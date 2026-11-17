import {
  ProviderDriverKind,
  ProviderInstanceId,
  T3fNativeSessionError,
  ThreadId,
  type ProjectId,
  type T3fNativeSessionAdoptInput,
  type T3fNativeSessionListItem,
  type T3fNativeSessionUnlisted,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AcpRegistrySessions from "../provider/AcpRegistrySessions.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { nativeIdFileKey } from "./nativeSessionFiles.ts";

/** Drivers whose sessions the transcript scanner reads. */
const SCANNED_DRIVERS = new Set(["claudeAgent", "codex", "pi"]);

const fail = (reason: T3fNativeSessionError["reason"], message: string) =>
  new T3fNativeSessionError({ reason, message });

const storageError =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, T3fNativeSessionError> =>
    Effect.logWarning(message, { cause }).pipe(
      Effect.andThen(Effect.fail(fail("storage", message))),
    );

// An agent slow to start must hold back neither the folder's other sessions nor a load.
const ACP_LIST_TIMEOUT = "10 seconds";

const listableAcpInstance = (instance: ProviderInstance) =>
  instance.enabled && instance.acpSessionManagement !== undefined;

export const makeAdoption = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const acpSessions = yield* AcpRegistrySessions.AcpRegistrySessions;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;

  const project = Effect.fn("NativeSessions.project")(function* (projectId: ProjectId) {
    const found = yield* projects
      .getById(projectId)
      .pipe(Effect.catch(storageError("The project could not be read.")));
    if (Option.isNone(found) || found.value.deletedAt !== null) {
      return yield* fail("project_not_found", `Project ${projectId} was not found.`);
    }
    return found.value;
  });

  // Pi names a session by its file path; a symlinked home must not make it a second session.
  const ownerKey = (driver: string, nativeId: string) =>
    driver === "pi"
      ? fs.realPath(nativeId).pipe(Effect.orElseSucceed(() => nativeId))
      : Effect.succeed(nativeId);

  /**
   * The threads on an instance's sessions, by native id, as the event sink sees ownership: a
   * deleted thread still holds its session. A live owner wins over a deleted one.
   */
  const owners = Effect.fn("NativeSessions.owners")(function* (
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    nativeId: string | null,
  ) {
    const exact = driver === "pi" ? null : nativeId;
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly native_id: string | null;
      readonly deleted: number;
    }>`
      SELECT provider.thread_id,
        json_extract(provider.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        thread.deleted_at IS NOT NULL AS deleted
      FROM orchestration_v2_projection_provider_threads AS provider
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = provider.thread_id
      WHERE provider.driver = ${driver}
        AND provider.provider_instance_id = ${instanceId}
        AND (${exact} IS NULL
          OR json_extract(provider.payload_json, '$.nativeThreadRef.nativeId') = ${exact})
      ORDER BY deleted ASC, thread.updated_at DESC
    `.pipe(Effect.catch(storageError("Session owners could not be read.")));
    const byKey = new Map<string, { readonly threadId: ThreadId; readonly deleted: boolean }>();
    for (const row of rows) {
      if (row.native_id === null) continue;
      const key = yield* ownerKey(driver, row.native_id);
      if (!byKey.has(key)) {
        byKey.set(key, { threadId: ThreadId.make(row.thread_id), deleted: row.deleted !== 0 });
      }
    }
    return byKey;
  });

  const ownerOf = Effect.fn("NativeSessions.ownerOf")(function* (
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    nativeId: string,
  ) {
    return (
      (yield* owners(driver, instanceId, nativeId)).get(yield* ownerKey(driver, nativeId)) ?? null
    );
  });

  const scannedSessions = Effect.fn("NativeSessions.scannedSessions")(function* (
    workspaceRoot: string,
  ) {
    const outcomes = yield* scanner
      .recentThreads(workspaceRoot, [], { session: null })
      .pipe(Stream.runCollect, Effect.catch(storageError("Provider sessions could not be read.")));
    return Array.from(outcomes).flatMap((outcome) =>
      outcome._tag === "Importable"
        ? [
            {
              driver: ProviderDriverKind.make(outcome.thread.source),
              providerInstanceId: outcome.thread.providerInstanceId,
              nativeId:
                outcome.thread.source === "pi"
                  ? outcome.source.filePath
                  : outcome.thread.providerSessionId,
              name: outcome.thread.title.trim() || null,
              updatedAt: outcome.thread.updatedAt,
            },
          ]
        : [],
    );
  });

  // Each listing agent runs its own process, so one that fails leaves the others listed.
  const acpSessionsOf = Effect.fn("NativeSessions.acpSessionsOf")(function* (
    instance: ProviderInstance,
    workspaceRoot: string,
  ) {
    const manager = instance.acpSessionManagement;
    if (manager === undefined) return { sessions: [], unlisted: [] };
    const unlisted = (reason: T3fNativeSessionUnlisted["reason"]) => (cause: unknown) =>
      Effect.logWarning("An agent's sessions could not be listed.", {
        instanceId: instance.instanceId,
        cause,
      }).pipe(
        Effect.as({
          sessions: [],
          unlisted: [
            { driver: instance.driverKind, providerInstanceId: instance.instanceId, reason },
          ],
        }),
      );
    return yield* manager.listSessions({ cwd: workspaceRoot }).pipe(
      Effect.map((listed) => ({
        sessions: listed.sessions.map((session) => ({
          driver: instance.driverKind,
          providerInstanceId: instance.instanceId,
          nativeId: session.sessionId,
          name: session.title?.trim() || null,
          updatedAt: session.updatedAt,
        })),
        unlisted: [],
      })),
      Effect.timeoutOrElse({
        duration: ACP_LIST_TIMEOUT,
        orElse: () => unlisted("timed_out")("timed out"),
      }),
      Effect.catch(unlisted("failed")),
    );
  });

  const list = Effect.fn("NativeSessions.list")(function* (projectId: ProjectId) {
    const { workspaceRoot } = yield* project(projectId);
    const acpInstances = (yield* instances.listInstances).filter(listableAcpInstance);
    const acpListings = yield* Effect.forEach(
      acpInstances,
      (instance) => acpSessionsOf(instance, workspaceRoot),
      { concurrency: "unbounded" },
    );
    const found = [
      ...(yield* scannedSessions(workspaceRoot)),
      ...acpListings.flatMap((listing) => listing.sessions),
    ];
    const ownersByInstance = new Map<
      string,
      Map<string, { threadId: ThreadId; deleted: boolean }>
    >();
    const sessions: Array<T3fNativeSessionListItem> = [];
    for (const session of found) {
      const instanceKey = `${session.driver}\0${session.providerInstanceId}`;
      let byKey = ownersByInstance.get(instanceKey);
      if (byKey === undefined) {
        byKey = yield* owners(session.driver, session.providerInstanceId, null);
        ownersByInstance.set(instanceKey, byKey);
      }
      const owner = byKey.get(yield* ownerKey(session.driver, session.nativeId));
      sessions.push({
        ...session,
        threadId: owner?.deleted === false ? owner.threadId : null,
        threadDeleted: owner?.deleted === true,
      });
    }
    sessions.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
    return { sessions, unlisted: acpListings.flatMap((listing) => listing.unlisted) };
  });

  const driverOf = Effect.fn("NativeSessions.driverOf")(function* (instanceId: ProviderInstanceId) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance !== undefined) return { driver: instance.driverKind, instance };
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catch(storageError("Settings could not be read.")),
    );
    const configured = settings.providerInstances[instanceId]?.driver;
    if (configured !== undefined) return { driver: configured, instance };
    if (SCANNED_DRIVERS.has(instanceId))
      return { driver: ProviderDriverKind.make(instanceId), instance };
    return yield* fail("instance_not_found", `Provider instance ${instanceId} was not found.`);
  });

  const adopt = Effect.fn("NativeSessions.adopt")(function* (input: T3fNativeSessionAdoptInput) {
    const { workspaceRoot } = yield* project(input.projectId);
    const { driver, instance } = yield* driverOf(input.providerInstanceId);
    const existing = yield* ownerOf(driver, input.providerInstanceId, input.nativeId);
    if (existing?.deleted === false) return { threadId: existing.threadId, created: false };
    if (existing?.deleted === true) {
      return yield* fail(
        "owned_by_deleted_thread",
        "A deleted thread still holds this session, so it cannot be loaded into a new one.",
      );
    }

    const fileKey = nativeIdFileKey(driver, yield* ownerKey(driver, input.nativeId));
    if (fileKey !== null) {
      yield* importer
        .importRecentAgentThreads(
          { projectId: input.projectId, expectedWorkspaceRoot: workspaceRoot },
          { session: { providerInstanceId: input.providerInstanceId, fileKey } },
        )
        .pipe(Effect.catch(storageError("The session could not be loaded.")));
      const adopted = yield* ownerOf(driver, input.providerInstanceId, input.nativeId);
      if (adopted?.deleted === false) return { threadId: adopted.threadId, created: true };
      return yield* fail(
        "session_not_found",
        "No session with this id ran in the project's folder, or it holds no conversation.",
      );
    }

    if (instance?.acpSessionManagement !== undefined) {
      const listed = yield* instance.acpSessionManagement.listSessions({ cwd: workspaceRoot }).pipe(
        Effect.timeoutOrElse({
          duration: ACP_LIST_TIMEOUT,
          orElse: () => Effect.succeed({ sessions: [] }),
        }),
        Effect.orElseSucceed(() => ({ sessions: [] })),
      );
      const session = listed.sessions.find((candidate) => candidate.sessionId === input.nativeId);
      const imported = yield* acpSessions
        .importSession({
          instanceId: input.providerInstanceId,
          projectId: input.projectId,
          sessionId: input.nativeId,
          ...(session?.title ? { title: session.title } : {}),
          ...(session?.updatedAt ? { updatedAt: session.updatedAt } : {}),
        })
        .pipe(
          Effect.catch((error) =>
            error.reason === "session_resume_unsupported" ||
            error.reason === "session_list_unsupported"
              ? Effect.fail(fail("unsupported", error.message))
              : storageError(error.message)(error),
          ),
        );
      return { threadId: imported.threadId, created: imported.imported };
    }

    return yield* fail("unsupported", `Sessions of ${driver} cannot be loaded into a thread.`);
  });

  return { list, adopt };
});
