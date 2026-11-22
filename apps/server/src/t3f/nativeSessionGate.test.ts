import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { makeGate } from "./nativeSessionGate.ts";
import { isNativeSessionRestoreRefusedError } from "./NativeSessionRestoreRefusedError.ts";

const before = "2026-11-21T12:00:00.000Z";
const firstTakeBack = "2026-11-21T12:01:00.000Z";
const between = "2026-11-21T12:02:00.000Z";
const secondTakeBack = "2026-11-21T12:03:00.000Z";
const after = "2026-11-21T12:04:00.000Z";

it.effect.each([
  { name: "Codex restore before take-back", startedAt: before, refused: true },
  { name: "Codex restore to thread start", atStart: true, refused: true },
  { name: "Codex restore with an unknown start", refused: true },
  { name: "Codex restore after take-back", startedAt: between, refused: false },
  { name: "Claude restore before take-back", driver: "claude", startedAt: before, refused: false },
  { name: "Codex fork before take-back", fork: true, startedAt: before, refused: true },
  { name: "Codex fork from the head", fork: true, refused: false },
  {
    name: "Codex restore without a hand-out",
    neverHandedOut: true,
    startedAt: before,
    refused: false,
  },
  {
    name: "Codex restore between take-backs",
    takenBackAt: secondTakeBack,
    startedAt: between,
    refused: true,
  },
  {
    name: "Codex restore after its second take-back",
    takenBackAt: secondTakeBack,
    startedAt: after,
    refused: false,
  },
  {
    name: "Codex restore after moving sessions",
    nativeId: "replacement",
    startedAt: before,
    refused: false,
  },
])("$name", (scenario) =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make(scenario.driver ?? "codex");
    const threadId = ThreadId.make("thread");
    const providerSessionId = ProviderSessionId.make("session");
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const checkpointId = CheckpointId.make("checkpoint");
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: ProviderInstanceId.make(driver),
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: scenario.nativeId ?? "native", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: DateTime.makeUnsafe(before),
      updatedAt: DateTime.makeUnsafe(after),
    };
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: ProviderTurnId.make("provider-turn"),
      providerThreadId,
      nodeId: NodeId.make("root"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: scenario.startedAt === undefined ? null : DateTime.makeUnsafe(scenario.startedAt),
      completedAt: DateTime.makeUnsafe(after),
    };
    const calls = { rollback: 0, fork: 0 };
    const runtime = {
      rollbackThread: () => {
        calls.rollback++;
        return Effect.succeed({
          providerThread,
          providerTurns: [],
          messages: [],
          runtimeRequests: [],
        });
      },
      forkThread: () => {
        calls.fork++;
        return Effect.succeed(providerThread);
      },
    } satisfies Pick<
      ProviderAdapter.ProviderAdapterV2SessionRuntime,
      "rollbackThread" | "forkThread"
    >;
    const marks = {
      get: () => Effect.undefined,
      drop: () => Effect.void,
      getTakeBack: () =>
        Effect.succeed(
          scenario.neverHandedOut
            ? undefined
            : {
                threadId,
                driver,
                nativeId: "native",
                since: before,
                takenBackAt: scenario.takenBackAt ?? firstTakeBack,
              },
        ),
    };
    const gated = yield* Effect.gen(function* () {
      return yield* makeGate(yield* ProviderSessionManager.ProviderSessionManagerV2, marks);
    }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeedSome(
              runtime as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
            ),
        }),
      ),
    );
    const session = Option.getOrThrow(yield* gated.get(providerSessionId));
    const result = scenario.fork
      ? yield* session
          .forkThread({
            sourceProviderThread: providerThread,
            sourceProviderTurns: [providerTurn],
            ...(scenario.startedAt === undefined ? {} : { providerTurnId: providerTurn.id }),
            targetThreadId: ThreadId.make("fork"),
          })
          .pipe(Effect.result)
      : yield* session
          .rollbackThread({
            providerThread,
            providerThreadTurns: [providerTurn],
            target: scenario.atStart
              ? { type: "thread_start", checkpointId, appRunOrdinal: 0 }
              : { type: "provider_turn", checkpointId, appRunOrdinal: 1, providerTurn },
          })
          .pipe(Effect.result);

    assert.equal(calls.rollback, scenario.fork || scenario.refused ? 0 : 1);
    assert.equal(calls.fork, scenario.fork && !scenario.refused ? 1 : 0);
    if (scenario.refused) {
      assert(result._tag === "Failure");
      if (scenario.fork) {
        assert(result.failure._tag === "ProviderAdapterForkThreadError");
        assert.include(String(result.failure.cause), "moved back from the terminal");
      } else {
        assert(isNativeSessionRestoreRefusedError(result.failure));
        assert.include(result.failure.message, "moved back from the terminal");
      }
    } else {
      assert.equal(result._tag, "Success");
    }
  }).pipe(Effect.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({}))),
);

/** A gated Codex session over fakes: the manager's live runtime, the name the step finds, what reached it. */
const titledSessions = Effect.gen(function* () {
  const driver = ProviderDriverKind.make("codex");
  const threadId = ThreadId.make("thread");
  const providerThread = {
    driver,
    appThreadId: threadId,
    nativeThreadRef: { driver, nativeId: "native", strength: "strong" },
  } as unknown as OrchestrationV2ProviderThread;
  const synced: Array<string> = [];
  const learned: Array<string> = [];
  const pushed: Array<string> = [];
  const state = {
    live: undefined as ProviderAdapter.ProviderAdapterV2SessionRuntime | undefined,
    replaces: false,
    outside: undefined as string | undefined,
    learnInto: undefined as undefined | ((nativeId: string, name: string) => void),
    syncWith: undefined as undefined | (() => string | undefined),
  };
  const makeRuntime = () =>
    ({
      startTurn: (input: { readonly appThread: { readonly title: string } }) =>
        Effect.sync(() => void pushed.push(`startTurn:${input.appThread.title}`)),
      applyThreadTitle: (input: { readonly title: string }) =>
        Effect.sync(() => void pushed.push(`applyThreadTitle:${input.title}`)),
      // Methods the gate has no name for, whose input carries the thread's title.
      resumeTurn: (input: { readonly appThread: { readonly title: string } }) =>
        Effect.sync(() => void pushed.push(`resumeTurn:${input.appThread.title}`)),
      fooTurn: (input: { readonly appThread: { readonly title: string } }) =>
        Effect.sync(() => void pushed.push(`fooTurn:${input.appThread.title}`)),
      canReuseContextUsage: () => true,
    }) as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  const manager = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
    get: () => Effect.succeed(state.live === undefined ? Option.none() : Option.some(state.live)),
    open: () =>
      Effect.sync(() => {
        if (state.live === undefined || state.replaces) state.live = makeRuntime();
        return state.live;
      }),
  });
  const gated = yield* Effect.gen(function* () {
    return yield* makeGate(
      yield* ProviderSessionManager.ProviderSessionManagerV2,
      {
        get: () => Effect.undefined,
        drop: () => Effect.void,
        getTakeBack: () => Effect.undefined,
      },
      {
        sync: (id) =>
          Effect.sync(() => {
            synced.push(id);
            return state.syncWith === undefined ? state.outside : state.syncWith();
          }),
        learn: (_thread, native, name) =>
          Effect.sync(() => {
            learned.push(name);
            state.learnInto?.(native, name);
          }),
      },
    );
  }).pipe(Effect.provide(manager));
  const providerSessionId = ProviderSessionId.make("session");
  const open = gated.open({ threadId, providerSessionId } as never);
  const turn = { threadId, providerThread, appThread: { title: "old" } } as never;
  return {
    gated,
    open,
    providerSessionId,
    state,
    makeRuntime,
    turn,
    providerThread,
    synced,
    learned,
    pushed,
  };
}).pipe(Effect.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({})));

it.effect("opening a session that was not live adopts its outside name for the next turn", () =>
  Effect.gen(function* () {
    const { open, state, turn, synced, learned, pushed } = yield* titledSessions;
    state.outside = "outside";
    const session = yield* open;
    yield* session.startTurn(turn);
    yield* session.startTurn(turn);

    assert.deepEqual(synced, ["thread"]);
    assert.deepEqual(pushed, ["startTurn:outside", "startTurn:old"]);
    assert.deepEqual(learned, ["outside", "old"]);
  }),
);

it.effect("opening a live session reads no name", () =>
  Effect.gen(function* () {
    const { open, state, makeRuntime, turn, synced, pushed } = yield* titledSessions;
    state.live = makeRuntime();
    state.outside = "outside";
    const session = yield* open;
    yield* session.startTurn(turn);

    assert.deepEqual(synced, []);
    assert.deepEqual(pushed, ["startTurn:old"]);
  }),
);

it.effect("a runtime the manager replaced is not a live one", () =>
  Effect.gen(function* () {
    const { open, state, makeRuntime, turn, synced, pushed } = yield* titledSessions;
    state.live = makeRuntime();
    state.replaces = true;
    state.outside = "outside";
    yield* (yield* open).startTurn(turn);

    assert.deepEqual(synced, ["thread"]);
    assert.deepEqual(pushed, ["startTurn:outside"]);
  }),
);

it.effect("an adopted name belongs to the runtime that open returned", () =>
  Effect.gen(function* () {
    const { gated, open, providerSessionId, state, turn, synced, pushed } = yield* titledSessions;
    state.outside = "outside";
    yield* open;
    // The session is released before any turn, and nothing outside has renamed it since.
    state.live = undefined;
    state.outside = undefined;
    const reopened = yield* open;
    const fetched = Option.getOrThrow(yield* gated.get(providerSessionId));
    yield* reopened.startTurn(turn);
    yield* fetched.startTurn(turn);

    assert.deepEqual(synced, ["thread", "thread"]);
    assert.deepEqual(pushed, ["startTurn:old", "startTurn:old"]);
  }),
);

it.effect("a turn's title is learned even when no title was pushed to the session", () =>
  Effect.gen(function* () {
    const { open, makeRuntime, state, turn, learned } = yield* titledSessions;
    state.live = makeRuntime();
    yield* (yield* open).startTurn(turn);

    assert.deepEqual(learned, ["old"]);
  }),
);

it.effect("a title pushed to a live session is learned before it reaches the session", () =>
  Effect.gen(function* () {
    const { open, makeRuntime, state, providerThread, learned, pushed } = yield* titledSessions;
    state.live = makeRuntime();
    const session = yield* open;
    yield* session.applyThreadTitle!({ providerThread, title: "B" });

    assert.deepEqual(learned, ["B"]);
    assert.deepEqual(pushed, ["applyThreadTitle:B"]);
  }),
);

it.effect("any method given a title records it for the input's native session", () =>
  Effect.gen(function* () {
    const { open, makeRuntime, state, turn, learned, pushed } = yield* titledSessions;
    state.live = makeRuntime();
    const session = (yield* open) as unknown as Record<string, (input: unknown) => unknown>;
    yield* session.fooTurn!(turn) as Effect.Effect<void>;
    // A method that is not given a title is passed through as it is.
    assert.equal(session.canReuseContextUsage!(turn), true);

    assert.deepEqual(learned, ["old"]);
    assert.deepEqual(pushed, ["fooTurn:old"]);
  }),
);

/** The reviewer's sequence: close, rename to A, a promptless resume, release, rename to B, send. */
it.effect.each([
  { name: "the resumed turn's own session", nativeId: "native", title: "B" },
  { name: "another session", nativeId: "other", title: "A" },
])("a resumed turn's title is known only to $name", ({ nativeId, title: expected }) =>
  Effect.gen(function* () {
    const { open, state, providerThread, turn } = yield* titledSessions;
    // The session holds the name P, known; what the session is named is what the runtime writes.
    const known = new Map<string, Array<string>>([["native", ["P"]]]);
    const held = { name: "P", title: "P" };
    state.learnInto = (native, name) => known.set(native, [...(known.get(native) ?? []), name]);
    state.syncWith = () => {
      const native = held.name;
      if (native === held.title) return undefined;
      if (known.get("native")?.includes(native)) return undefined;
      held.title = native;
      return native;
    };
    // Closed; renamed to A in T3 Code while the session is not live.
    held.title = "A";
    const resumed = yield* open;
    yield* (
      resumed as unknown as { resumeTurn: (input: unknown) => Effect.Effect<void> }
    ).resumeTurn({
      ...(turn as object),
      providerThread: {
        ...providerThread,
        nativeThreadRef: { ...providerThread.nativeThreadRef, nativeId },
      },
      appThread: { title: "A" },
    });
    // The resume wrote A into the session; then it is released and the thread renamed to B.
    held.name = "A";
    state.live = undefined;
    held.title = "B";
    yield* open;

    assert.equal(held.title, expected);
  }),
);
