import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionSource,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AcpRegistrySessions from "../provider/AcpRegistrySessions.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeAdoption } from "./nativeSessionAdoption.ts";
import { matchesNativeSession, type NativeSessionScan } from "./nativeSessionFiles.ts";

const projectId = ProjectId.make("adopt-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const claudeInstance = ProviderInstanceId.make("claudeAgent");
const piInstance = ProviderInstanceId.make("pi");
const claudeSessionId = "5a3356c8-4ff1-46f9-908c-637454f147c4";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
  NodeServices.layer,
);

const transcript = (input: {
  readonly provider: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly filePath: string;
}) =>
  ({
    _tag: "Importable",
    source: { ...input, size: 100, mtimeMs: 2, device: 3, inode: 4, birthtimeMs: 1 },
    thread: {
      source: input.provider,
      providerInstanceId: input.providerInstanceId,
      providerSessionId: input.providerSessionId,
      title: "Old work",
      model: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      omittedMessageCount: 0,
      messages: [
        { role: "user", text: "Fix it", createdAt: timestamp },
        { role: "assistant", text: "Fixed", createdAt: timestamp },
      ],
    },
    worktree: null,
  }) satisfies AgentSessionScanner.AgentSessionRecentThread;

const silentAgent = {
  instanceId: ProviderInstanceId.make("silent"),
  driverKind: ProviderDriverKind.make("acpRegistry"),
  enabled: true,
  acpSessionManagement: { listSessions: () => Effect.never },
} as unknown as ProviderInstance;

const failingAgent = {
  ...silentAgent,
  instanceId: ProviderInstanceId.make("failing"),
  acpSessionManagement: { listSessions: () => Effect.fail("agent exited") },
} as unknown as ProviderInstance;

/** The real importer over a scanner that knows the given transcripts and honours the filter. */
const makeAdopter = Effect.fn(function* (
  transcripts: ReadonlyArray<ReturnType<typeof transcript>>,
  acpInstances: ReadonlyArray<ProviderInstance> = [],
) {
  const scans: Array<NativeSessionScan | undefined> = [];
  const fileSystem = yield* FileSystem.FileSystem;
  const scanner = Layer.mock(AgentSessionScanner.AgentSessionScanner)({
    recentThreads: (_root, _completed, scan) => {
      scans.push(scan);
      return Stream.fromIterable(transcripts).pipe(
        Stream.filterEffect((found) =>
          matchesNativeSession(
            fileSystem,
            scan,
            { source: found.source.provider, providerInstanceId: found.source.providerInstanceId },
            found.source.filePath,
          ),
        ),
      );
    },
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () =>
      Effect.succeedSome({
        id: projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      }),
  });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const shared = Layer.mergeAll(scanner, projects, ServerSettings.layerTest());
  const importer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        shared,
        Layer.succeed(EventSink.EventSinkV2, yield* EventSink.EventSinkV2),
        Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
        Layer.succeed(
          ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
        ),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (threadId, fields) =>
            projections
              .getThreadRecords(threadId, fields)
              .pipe(
                Effect.mapError(
                  (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                ),
              ),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.succeed(
          ThreadCommandExecutor.ThreadCommandExecutor,
          yield* ThreadCommandExecutor.make,
        ),
      ),
    ),
  );
  const adoption = yield* makeAdoption.pipe(
    Effect.provide(
      Layer.mergeAll(
        shared,
        importer,
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(acpInstances.find((instance) => instance.instanceId === id)),
          listInstances: Effect.succeed(acpInstances),
        }),
        Layer.mock(AcpRegistrySessions.AcpRegistrySessions)({
          importSession: (input) =>
            Effect.succeed({ threadId: ThreadId.make(`acp:${input.sessionId}`), imported: true }),
        }),
      ),
    ),
  );
  return { ...adoption, scans };
});

/** A thread T3 Code started on the session, its provider thread id derived without the instance. */
const seedStartedThread = Effect.fn(function* (input: {
  readonly driver: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeId: string;
  readonly deleted?: boolean;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const driver = ProviderDriverKind.make(input.driver);
  const threadId = ThreadId.make(`started:${input.nativeId}`);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, nativeThreadId: input.nativeId }),
    driver,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: input.nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Started here",
    providerInstanceId: input.providerInstanceId,
    modelSelection: { instanceId: input.providerInstanceId, model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lastVisitedAt: null,
    deletedAt: input.deleted ? now : null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

describe("adopting a native session", () => {
  it.effect("gives one thread when adopted twice, and scans for that session alone", () =>
    Effect.gen(function* () {
      const { adopt, scans } = yield* makeAdopter([
        transcript({
          provider: "claudeAgent",
          providerInstanceId: claudeInstance,
          providerSessionId: claudeSessionId,
          filePath: `/home/u/.claude/projects/-p/${claudeSessionId}.jsonl`,
        }),
        transcript({
          provider: "claudeAgent",
          providerInstanceId: claudeInstance,
          providerSessionId: "6b4467d9-5002-4a0a-a19d-748565025bd5",
          filePath: "/home/u/.claude/projects/-p/6b4467d9-5002-4a0a-a19d-748565025bd5.jsonl",
        }),
      ]);
      const input = { projectId, providerInstanceId: claudeInstance, nativeId: claudeSessionId };

      const first = yield* adopt(input);
      const second = yield* adopt(input);

      expect(first).toEqual({
        threadId: ThreadId.make(`import:claudeAgent:${claudeSessionId}`),
        created: true,
      });
      expect(second).toEqual({ threadId: first.threadId, created: false });
      expect(scans).toEqual([
        { session: { providerInstanceId: claudeInstance, fileKey: claudeSessionId } },
      ]);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect(
        (yield* projections
          .getThreadRecords(
            ThreadId.make("import:claudeAgent:6b4467d9-5002-4a0a-a19d-748565025bd5"),
            [],
          )
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("returns the thread T3 Code started on the session", () =>
    Effect.gen(function* () {
      const started = yield* seedStartedThread({
        driver: "claudeAgent",
        providerInstanceId: claudeInstance,
        nativeId: claudeSessionId,
      });
      const { adopt, scans } = yield* makeAdopter([
        transcript({
          provider: "claudeAgent",
          providerInstanceId: claudeInstance,
          providerSessionId: claudeSessionId,
          filePath: `/home/u/.claude/projects/-p/${claudeSessionId}.jsonl`,
        }),
      ]);

      expect(
        yield* adopt({ projectId, providerInstanceId: claudeInstance, nativeId: claudeSessionId }),
      ).toEqual({ threadId: started, created: false });
      expect(scans).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("refuses a session whose thread was deleted, and lists it as such", () =>
    Effect.gen(function* () {
      yield* seedStartedThread({
        driver: "claudeAgent",
        providerInstanceId: claudeInstance,
        nativeId: claudeSessionId,
        deleted: true,
      });
      const { adopt, list } = yield* makeAdopter([
        transcript({
          provider: "claudeAgent",
          providerInstanceId: claudeInstance,
          providerSessionId: claudeSessionId,
          filePath: `/home/u/.claude/projects/-p/${claudeSessionId}.jsonl`,
        }),
      ]);

      expect(
        yield* Effect.flip(
          adopt({ projectId, providerInstanceId: claudeInstance, nativeId: claudeSessionId }),
        ),
      ).toMatchObject({ _tag: "T3fNativeSessionError", reason: "owned_by_deleted_thread" });
      expect((yield* list(projectId)).sessions).toMatchObject([
        { nativeId: claudeSessionId, threadId: null, threadDeleted: true },
      ]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("finds a Pi thread's session through a symlinked folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const real = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-sessions-" });
      const link = `${real}-link`;
      yield* fs.symlink(real, link);
      yield* Effect.addFinalizer(() => fs.remove(link).pipe(Effect.ignore));
      const realFile = path.join(real, "2026-08-24_pi.jsonl");
      yield* fs.writeFileString(realFile, "");
      const started = yield* seedStartedThread({
        driver: "pi",
        providerInstanceId: piInstance,
        nativeId: path.join(link, "2026-08-24_pi.jsonl"),
      });
      const { adopt, list } = yield* makeAdopter([
        transcript({
          provider: "pi",
          providerInstanceId: piInstance,
          providerSessionId: "pi-session",
          filePath: realFile,
        }),
      ]);

      expect(
        yield* adopt({ projectId, providerInstanceId: piInstance, nativeId: realFile }),
      ).toEqual({ threadId: started, created: false });
      expect((yield* list(projectId)).sessions).toMatchObject([
        { providerInstanceId: piInstance, nativeId: realFile, threadId: started },
      ]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("loads only the Pi session at the asked path when another folder has its name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-sessions-" });
      const files = ["a", "b"].map((folder) => path.join(root, folder, "2026-08-24_pi.jsonl"));
      for (const file of files) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const { adopt } = yield* makeAdopter(
        files.map((filePath, index) =>
          transcript({
            provider: "pi",
            providerInstanceId: piInstance,
            providerSessionId: `pi-${index}`,
            filePath,
          }),
        ),
      );

      expect(
        yield* adopt({ projectId, providerInstanceId: piInstance, nativeId: files[1]! }),
      ).toEqual({ threadId: ThreadId.make("import:pi:pi-1"), created: true });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect(
        (yield* projections.getThreadRecords(ThreadId.make("import:pi:pi-0"), []).pipe(Effect.exit))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("lists the scanned sessions and names the agents that could not list theirs", () =>
    Effect.gen(function* () {
      const { list } = yield* makeAdopter(
        [
          transcript({
            provider: "claudeAgent",
            providerInstanceId: claudeInstance,
            providerSessionId: claudeSessionId,
            filePath: `/claude/projects/-workspace-project/${claudeSessionId}.jsonl`,
          }),
        ],
        [silentAgent, failingAgent],
      );
      const listing = yield* Effect.forkChild(list(projectId));
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(listing)).toMatchObject({
        sessions: [
          { providerInstanceId: claudeInstance, nativeId: claudeSessionId, threadId: null },
        ],
        unlisted: [
          { providerInstanceId: silentAgent.instanceId, reason: "timed_out" },
          { providerInstanceId: failingAgent.instanceId, reason: "failed" },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("loads an agent's session when the agent never lists its sessions", () =>
    Effect.gen(function* () {
      const { adopt } = yield* makeAdopter([], [silentAgent]);
      const adopting = yield* Effect.forkChild(
        adopt({ projectId, providerInstanceId: silentAgent.instanceId, nativeId: "acp-session" }),
      );
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(adopting)).toEqual({
        threadId: ThreadId.make("acp:acp-session"),
        created: true,
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("refuses a session no transcript in the folder holds", () =>
    Effect.gen(function* () {
      const { adopt } = yield* makeAdopter([]);
      expect(
        yield* Effect.flip(
          adopt({ projectId, providerInstanceId: claudeInstance, nativeId: claudeSessionId }),
        ),
      ).toMatchObject({ _tag: "T3fNativeSessionError", reason: "session_not_found" });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );
});
