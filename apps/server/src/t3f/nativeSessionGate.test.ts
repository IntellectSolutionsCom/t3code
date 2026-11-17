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
