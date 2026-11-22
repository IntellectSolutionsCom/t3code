import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunId,
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
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as NativeSessionOut from "./NativeSessionOut.ts";
import { makeOutsideTurnPreflight } from "./nativeSessionOutsideTurns.ts";
import { makeGate } from "./nativeSessionGate.ts";
import { isNativeSessionRestoreRefusedError } from "./NativeSessionRestoreRefusedError.ts";

const before = "2026-11-21T12:00:00.000Z";
const firstTakeBack = "2026-11-21T12:01:00.000Z";
const between = "2026-11-21T12:02:00.000Z";
const secondTakeBack = "2026-11-21T12:03:00.000Z";
const after = "2026-11-21T12:04:00.000Z";

const outLayer = Layer.effect(NativeSessionOut.NativeSessionOut, NativeSessionOut.make).pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("here")),
    }),
  ),
);

it.effect.each([
  {
    name: "Codex restore before a noticed outside turn",
    noticed: true,
    startedAt: before,
    refused: true,
  },
  { name: "Codex restore before take-back", startedAt: before, refused: true },
  { name: "Codex restore to thread start", atStart: true, refused: true },
  { name: "Codex restore with an unknown start", refused: true },
  { name: "Codex restore after take-back", startedAt: between, refused: false },
  {
    name: "Claude restore before take-back",
    driver: "claudeAgent",
    startedAt: before,
    refused: false,
  },
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
    const out = yield* NativeSessionOut.NativeSessionOut;
    if (scenario.noticed)
      yield* out.notice({ threadId, driver, nativeId: "native", since: firstTakeBack });
    const marks = {
      get: () => Effect.undefined,
      drop: () => Effect.void,
      getTakeBack: () =>
        scenario.noticed
          ? out.getTakeBack(threadId)
          : Effect.succeed(
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
        assert.include(String(result.failure.cause), "last used in the terminal");
      } else {
        assert(isNativeSessionRestoreRefusedError(result.failure));
        assert.include(result.failure.message, "last used in the terminal");
      }
    } else {
      assert.equal(result._tag, "Success");
    }
  }).pipe(Effect.provide(Layer.merge(outLayer, Layer.mock(ProjectionStore.ProjectionStoreV2)({})))),
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

const outsideMessage =
  "1 turn was made in the terminal since this thread's last message. The agent has them; they are not shown here.";
const busyMessage =
  "1 turn was made in the terminal since this thread's last message. The agent here may not have them.";
const splitMessage =
  "Turns were made in the terminal while this thread still held the session. The agent here does not have them. To keep working there, choose Move to terminal.";

it.effect.each([
  { name: "live Codex without reading", driver: "codex", live: true, calls: ["open"] },
  {
    name: "Codex reopening on an outside turn",
    driver: "codex",
    message: outsideMessage,
    calls: ["stat", "read", "notice", "open", "adopt"],
  },
  {
    name: "Claude releases before reopening and adopting",
    driver: "claudeAgent",
    live: true,
    release: "released",
    message: outsideMessage,
    calls: ["stat", "read", "release", "notice", "open", "adopt"],
  },
  {
    name: "Claude releases and adopts after cleanup fails",
    driver: "claudeAgent",
    live: true,
    release: "failed-after-removal",
    message: outsideMessage,
    calls: ["stat", "read", "release", "notice", "open", "adopt"],
  },
  {
    name: "busy Claude keeps the live runtime",
    driver: "claudeAgent",
    live: true,
    release: "busy",
    message: busyMessage,
    calls: ["stat", "read", "release", "notice", "open"],
  },
  {
    name: "Claude split without releasing",
    driver: "claudeAgent",
    live: true,
    split: true,
    message: splitMessage,
    calls: ["stat", "read", "notice", "open"],
  },
  {
    name: "Codex retries without a duplicate or refusal",
    driver: "codex",
    retry: true,
    message: outsideMessage,
    calls: ["stat", "read", "notice", "open", "adopt", "stat", "read", "open", "adopt"],
  },
  {
    name: "Claude attributes an interrupted T3 prompt with one transcript read",
    driver: "claudeAgent",
    live: true,
    interrupted: true,
    calls: ["stat", "read", "open"],
  },
  {
    name: "Claude skips a pinned rollback",
    driver: "claudeAgent",
    live: true,
    pinned: true,
    calls: ["open"],
  },
  { name: "another driver passes through", driver: "pi", calls: ["open", "adopt"] },
  {
    name: "Codex checks unchanged mtime without reading",
    driver: "codex",
    stale: true,
    calls: ["stat", "open", "adopt"],
  },
])("$name", (scenario) =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make(scenario.driver);
    const instanceId = ProviderInstanceId.make(driver);
    const threadId = ThreadId.make("thread");
    const providerSessionId = ProviderSessionId.make("session");
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const runId = RunId.make("latest");
    const userMessageId = MessageId.make("interrupted");
    const nativeId = "5a3356c8-4ff1-46f9-908c-637454f147c4";
    const nativeThreadRef = { driver, nativeId, strength: "strong" as const };
    const completedAt = DateTime.makeUnsafe(before);
    const rootTurn = { nativeTurnRef: { ...nativeThreadRef, nativeId: "ours" }, completedAt };
    const calls: Array<string> = [];
    const notices: Array<OrchestrationV2TurnItem> = [];
    const titles: Array<string> = [];
    const runtime = {
      startTurn: (input: { readonly appThread: { readonly title: string } }) =>
        Effect.sync(() => void titles.push(input.appThread.title)),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    let current = scenario.live ? runtime : undefined;
    const manager = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: () => Effect.sync(() => Option.fromNullishOr(current)),
      open: () =>
        Effect.sync(() => {
          calls.push("open");
          return (current ??= { ...runtime });
        }),
      releaseUnlessBusy: () =>
        Effect.suspend(() => {
          calls.push("release");
          if (scenario.release === "busy") return Effect.succeed(false);
          current = undefined;
          return scenario.release === "failed-after-removal"
            ? Effect.fail(
                new ProviderSessionManager.ProviderSessionReleaseError({
                  providerSessionId,
                  reason: "manual_shutdown",
                  cause: "cleanup",
                }),
              )
            : Effect.succeed(true);
        }),
    });
    const rows =
      driver === "claudeAgent"
        ? [
            { type: "assistant", uuid: "ours" },
            {
              type: "user",
              uuid: "outside",
              parentUuid: scenario.split ? "sibling" : "ours",
              message: { content: "outside" },
            },
          ]
        : ["ours", "outside"].map((turn_id) => ({
            type: "event_msg",
            payload: { type: "task_started", turn_id },
          }));
    const bytes = new TextEncoder().encode(
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const file = {
      seek: () => Effect.succeed(0n),
      readAlloc: () =>
        Effect.sync(() => {
          calls.push("read");
          return Option.some(bytes);
        }),
    } as unknown as FileSystem.File;
    const out = yield* NativeSessionOut.NativeSessionOut;
    const gated = yield* Effect.gen(function* () {
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      return yield* makeGate(
        sessions,
        {
          get: out.get,
          drop: (id) => out.clear(id).pipe(Effect.ignore),
          getTakeBack: out.getTakeBack,
        },
        {
          sync: () =>
            Effect.sync(() => {
              calls.push("adopt");
              return "terminal title";
            }),
          learn: () => Effect.void,
        },
        yield* makeOutsideTurnPreflight(sessions, out),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          manager,
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          Path.layer,
          FileSystem.layerNoop({
            readDirectory: (path) =>
              Effect.succeed(
                path.endsWith("sessions")
                  ? ["2026"]
                  : path.endsWith("/2026")
                    ? ["11"]
                    : path.endsWith("/11")
                      ? ["21"]
                      : path.endsWith("/21")
                        ? [`rollout-session-${nativeId}.jsonl`]
                        : ["project"],
              ),
            exists: () => Effect.succeed(true),
            stat: () =>
              Effect.sync(() => {
                calls.push("stat");
                return {
                  type: "File",
                  size: ByteSize.bytes(bytes.length),
                  mtime: Option.some(
                    DateTime.toDateUtc(DateTime.makeUnsafe(scenario.stale ? before : after)),
                  ),
                } as FileSystem.File.Info;
              }),
            open: () => Effect.succeed(file),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.succeed({ activeProviderThreadId: providerThreadId } as never),
            getThreadRecords: () =>
              Effect.succeed({
                providerThreads: [
                  {
                    id: providerThreadId,
                    appThreadId: threadId,
                    providerInstanceId: instanceId,
                    driver,
                    nativeThreadRef,
                    nativeConversationHeadRef: scenario.pinned ? nativeThreadRef : null,
                  },
                ],
                providerTurns: [rootTurn],
                runs: [
                  {
                    id: runId,
                    providerThreadId,
                    userMessageId,
                    startedAt: scenario.interrupted ? DateTime.makeUnsafe(between) : null,
                  },
                ] satisfies Array<Partial<OrchestrationV2Run>>,
              } as never),
            getMessagesById: (_threadId, messageIds) =>
              Effect.succeed(
                new Map(
                  scenario.interrupted && messageIds.includes(userMessageId)
                    ? [[userMessageId, { text: "outside" } as OrchestrationV2ConversationMessage]]
                    : [],
                ),
              ),
            getTurnItem: ({ itemId }) =>
              Effect.succeed(notices.find((item) => item.id === itemId) ?? null),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: ({ events }) =>
              Effect.sync(() => {
                const event = events[0];
                assert(event?.type === "turn-item.updated");
                notices.push(event.payload);
                calls.push("notice");
                return [];
              }),
          }),
        ),
      ),
      Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
      Effect.provideService(HostProcess.Environment, {}),
    );
    const open = gated.open({
      threadId,
      providerSessionId,
      modelSelection: { instanceId, model: "model" },
      initialNativeThreadId: nativeId,
      runtimePolicy: {} as never,
    });
    yield* (yield* open).startTurn({ threadId, appThread: { title: "T3 title" } } as never);
    if (scenario.retry) {
      current = undefined;
      yield* open;
    }

    assert.deepEqual(calls, scenario.calls);
    assert.deepEqual(titles, [scenario.calls.includes("adopt") ? "terminal title" : "T3 title"]);
    assert.deepEqual(
      notices.flatMap((item) =>
        item.type === "system_notice" ? [[item.runId, item.message]] : [],
      ),
      scenario.message === undefined ? [] : [[runId, scenario.message]],
    );
    if (scenario.message === undefined) assert.isUndefined(yield* out.getTakeBack(threadId));
    else assert.equal((yield* out.getTakeBack(threadId))?.nativeId, nativeId);
    assert.isUndefined(yield* out.get(threadId));
    if (scenario.release === "busy" || scenario.split) assert.strictEqual(current, runtime);
  }).pipe(Effect.provide(outLayer)),
);
