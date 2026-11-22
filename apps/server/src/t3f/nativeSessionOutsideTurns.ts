import { TurnItemId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderSessionManagerV2Shape } from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { NativeSessionOut } from "./NativeSessionOut.ts";
import { readOutsideTurnTail } from "./nativeSessionFiles.ts";
import { compareClaude, compareCodex } from "./outsideTurns.ts";

const noticeItemId = (threadId: string, nativeId: string, firstId: string) =>
  TurnItemId.make(`turn-item:native-outside:${JSON.stringify([threadId, nativeId, firstId])}`);

const logFailure = (cause: unknown) =>
  Effect.logWarning("Could not check for turns made in the terminal.", { cause });

export const makeOutsideTurnPreflight = Effect.fn("NativeSessionGate.makeOutsideTurnPreflight")(
  function* (manager: ProviderSessionManagerV2Shape, out: NativeSessionOut["Service"]) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    return Effect.fn("NativeSessionGate.outsideTurnPreflight")(
      function* (input: Parameters<ProviderSessionManagerV2Shape["open"]>[0]) {
        const { threadId, initialNativeThreadId: nativeId, providerSessionId } = input;
        if (!nativeId) return undefined;
        const { instanceId } = input.modelSelection;
        const instance = (yield* settings.getSettings).providerInstances[instanceId];
        const driver = input.resumeFromSession?.driver ?? instance?.driver ?? instanceId;
        if (driver !== "codex" && driver !== "claudeAgent") return undefined;
        return yield* executor.withLock(
          threadId,
          Effect.gen(function* () {
            if ((yield* out.get(threadId)) !== undefined) return undefined;
            let live = yield* manager.get(providerSessionId);
            if (driver === "codex" && Option.isSome(live)) return live;
            const { providerThreads } = yield* projections.getThreadRecords(threadId, [
              "providerThreads",
            ]);
            const active = providerThreads.find(
              (thread) =>
                thread.appThreadId === threadId &&
                thread.providerInstanceId === input.modelSelection.instanceId &&
                thread.nativeThreadRef?.nativeId === nativeId,
            );
            if (active?.driver !== driver) return live;
            if (driver === "claudeAgent" && active.nativeConversationHeadRef !== null) return live;
            const { providerTurns } = yield* projections.getThreadRecords(
              threadId,
              ["providerTurns"],
              {
                providerTurnThreadIds: [active.id],
              },
            );
            const turns = providerTurns.filter(
              (turn) =>
                turn.nativeThreadRef === undefined || turn.nativeThreadRef.nativeId === nativeId,
            );
            const last = turns.at(-1)?.completedAt;
            const known = turns.flatMap((turn) => {
              const id = turn.nativeTurnRef?.nativeId;
              return id && (driver !== "claudeAgent" || !id.startsWith("turn:"))
                ? [{ turn, id }]
                : [];
            });
            const cursor = known.at(-1);
            if (last == null || cursor === undefined) return live;
            const tail = yield* readOutsideTurnTail(
              active,
              nativeId,
              instance,
              DateTime.toEpochMillis(last),
            ).pipe(Effect.provide(files));
            if (tail === undefined) return live;

            const { runs } = yield* projections.getThreadRecords(
              threadId,
              ["runs"],
              driver === "codex" ? { latestRunLimit: 1 } : undefined,
            );
            const latestRun = runs.at(-1);
            const sent = new Set<string>();
            if (driver === "claudeAgent") {
              const boundary = cursor.turn.completedAt ?? cursor.turn.startedAt;
              const messageIds = runs.flatMap((run) =>
                run.providerThreadId === active.id &&
                run.startedAt !== null &&
                (boundary === null ||
                  DateTime.toEpochMillis(run.startedAt) > DateTime.toEpochMillis(boundary))
                  ? [run.userMessageId]
                  : [],
              );
              const messages = yield* projections.getMessagesById(threadId, messageIds);
              for (const message of messages.values()) sent.add(message.text.trim());
            }
            const outside =
              driver === "codex"
                ? compareCodex(tail, cursor.id, new Set(known.map(({ id }) => id)))
                : compareClaude(tail, cursor.id, sent);
            if (typeof outside === "string") return live;

            let busy = false;
            if (driver === "claudeAgent" && outside.shape === "linear" && Option.isSome(live)) {
              const runtime = live.value;
              yield* manager
                .releaseUnlessBusy({
                  providerSessionId,
                  ownProviderThreadIds: [],
                  throughRunOrdinal: 0,
                  reason: "manual_shutdown",
                  detail: "Turns made in the terminal",
                  keepIf: Effect.gen(function* () {
                    if (yield* runtime.hasPendingBackgroundWork ?? Effect.succeed(false))
                      return true;
                    const shell = yield* projections
                      .getThreadShell(threadId)
                      .pipe(Effect.catch((error) => logFailure(error).pipe(Effect.as(undefined))));
                    return shell === undefined || (shell?.pendingBackgroundTasks?.length ?? 0) > 0;
                  }),
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause) ? Effect.interrupt : logFailure(cause),
                  ),
                );
              live = yield* manager.get(providerSessionId);
              busy = Option.isSome(live);
            }

            const itemId = noticeItemId(threadId, nativeId, outside.firstId);
            if ((yield* projections.getTurnItem({ threadId, itemId })) !== null) return live;
            const now = yield* DateTime.now;
            yield* out.notice({ threadId, driver, nativeId, since: DateTime.formatIso(now) });
            const count = outside.count;
            const subject =
              count === undefined
                ? "Turns were"
                : count === 1
                  ? "1 turn was"
                  : `${count} turns were`;
            const message =
              outside.shape === "split"
                ? "Turns were made in the terminal while this thread still held the session. The agent here does not have them. To keep working there, choose Move to terminal."
                : `${subject} made in the terminal since this thread's last message. ${busy ? "The agent here may not have them." : "The agent has them; they are not shown here."}`;
            const runId = latestRun?.id ?? null;
            yield* sink.write({
              events: [
                {
                  id: yield* ids.allocate.event({ threadId }),
                  type: "turn-item.updated",
                  threadId,
                  ...(runId === null ? {} : { runId }),
                  occurredAt: now,
                  payload: {
                    id: itemId,
                    threadId,
                    runId,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "completed",
                    title:
                      outside.shape === "split"
                        ? "Conversation split in the terminal"
                        : "Turns made in the terminal",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                    type: "system_notice",
                    level: "info",
                    message,
                  },
                },
              ],
            });
            return live;
          }),
        );
      },
      (effect) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : logFailure(cause).pipe(Effect.as(undefined)),
          ),
        ),
    );
  },
);
