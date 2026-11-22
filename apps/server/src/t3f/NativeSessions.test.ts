import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AcpRegistrySessions from "../provider/AcpRegistrySessions.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as NativeSessionKnownNames from "./NativeSessionKnownNames.ts";
import * as NativeSessionOut from "./NativeSessionOut.ts";
import * as NativeSessionTitleSync from "./NativeSessionTitleSync.ts";
import * as NativeSessions from "./NativeSessions.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const providerThreadId = ProviderThreadId.make("provider-thread-1");
const sessionId = "5a3356c8-4ff1-46f9-908c-637454f147c4";

const providerThread = (input: {
  readonly id?: ProviderThreadId;
  readonly driver: string;
  readonly instanceId: string;
  readonly nativeId: string;
  readonly title?: string;
}) =>
  ({
    id: input.id ?? providerThreadId,
    driver: ProviderDriverKind.make(input.driver),
    providerInstanceId: ProviderInstanceId.make(input.instanceId),
    nativeThreadRef: {
      driver: ProviderDriverKind.make(input.driver),
      nativeId: input.nativeId,
      strength: "durable",
    },
    nativeMetadata: input.title === undefined ? null : { title: input.title },
  }) as unknown as OrchestrationV2ProviderThread;

/** What the thread's title and its known names are, and which renames were dispatched. */
const fixture = (
  input: { title?: string; generating?: boolean; known?: ReadonlyArray<string> } = {},
) => ({
  title: input.title ?? "Fix the flaky test",
  generating: input.generating === true,
  known: [...(input.known ?? [])],
  renames: [] as Array<string>,
});

const layer = (input: {
  readonly fixture?: ReturnType<typeof fixture>;
  readonly home: string;
  readonly active: OrchestrationV2ProviderThread | null;
  readonly earlier?: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly providerInstances?: Record<string, unknown>;
}) => {
  const state = input.fixture ?? fixture();
  const shell = {
    id: threadId,
    projectId,
    get title() {
      return state.title;
    },
    get titleRegeneration() {
      return state.generating ? { requestId: "request" } : null;
    },
    worktreePath: null,
    activeProviderThreadId: input.active?.id ?? null,
    deletedAt: null,
  } as unknown as OrchestrationV2ThreadShell;
  return Layer.effect(NativeSessions.NativeSessions, NativeSessions.make).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
        Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
        Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
        Layer.mock(AcpRegistrySessions.AcpRegistrySessions)({}),
        Layer.succeed(SqlClient.SqlClient, {} as never),
        Layer.mock(NativeSessionOut.NativeSessionOut)({ get: () => Effect.undefined }),
        NativeSessionTitleSync.layer,
        Layer.succeed(
          NativeSessionKnownNames.NativeSessionKnownNames,
          NativeSessionKnownNames.NativeSessionKnownNames.of({
            get: () => Effect.succeed(state.known),
            add: (_thread, _native, name) =>
              Effect.sync(() => {
                if (!state.known.includes(name)) state.known.push(name);
              }),
          }),
        ),
        Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(EventSink.EventSinkV2)({}),
        Layer.succeed(IdAllocator.IdAllocatorV2, {} as never),
      ),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            const { title } = command as unknown as { readonly title: string };
            state.renames.push(title);
            state.title = title;
          }) as never,
        getThreadShell: (id) => Effect.succeed(id === threadId ? shell : null),
        getProjectThreadRecords: () =>
          Effect.succeed({
            thread: shell,
            providerThreads: [
              ...(input.earlier ?? []),
              ...(input.active === null ? [] : [input.active]),
            ],
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({ id: projectId, workspaceRoot: "/home/user/app" } as Project),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({ providerInstances: input.providerInstances ?? {} } as never),
    ),
  );
};

const withSessions = <A, E, R>(
  input: Parameters<typeof layer>[0],
  use: (sessions: NativeSessions.NativeSessions["Service"]) => Effect.Effect<A, E, R>,
) =>
  NativeSessions.NativeSessions.pipe(
    Effect.flatMap(use),
    Effect.provide(layer(input)),
    Effect.provideService(HostProcess.HomeDirectory, input.home),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

const identify = (input: Parameters<typeof layer>[0], id = threadId) =>
  withSessions(input, (sessions) => sessions.identify(id));

/** The step the gate and take-back reach through the cell. */
const sync = (input: Parameters<typeof layer>[0]) =>
  withSessions(input, () =>
    NativeSessionTitleSync.NativeSessionTitleSync.pipe(
      Effect.flatMap((titleSync) => titleSync.sync(threadId)),
    ),
  );

const withHome = <A, E, R>(use: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* use(yield* fs.makeTempDirectoryScoped());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const writeTranscript = (configDir: string, title: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(configDir, "projects", "-home-user-app");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId })}\n`,
    );
  });

describe("identifying a thread's native session", () => {
  it.effect("names a Claude session renamed in the terminal and sets its own config dir", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const configDir = `${home}/.claude-work`;
        yield* writeTranscript(configDir, "Renamed in the terminal");
        const state = fixture();
        const result = yield* identify({
          home,
          fixture: state,
          active: providerThread({
            driver: "claudeAgent",
            instanceId: "work",
            nativeId: sessionId,
          }),
          providerInstances: { work: { driver: "claudeAgent", config: { homePath: configDir } } },
        });
        expect(result.session).toEqual({
          driver: "claudeAgent",
          providerInstanceId: "work",
          nativeId: sessionId,
          name: "Renamed in the terminal",
          cwd: "/home/user/app",
          command: `cd /home/user/app && CLAUDE_CONFIG_DIR=${configDir} claude --resume ${sessionId}`,
          commandNote: null,
          out: null,
        });
        // Looking is not renaming: the step runs when a session is taken back or opened again.
        expect(state.renames).toEqual([]);
      }),
    ),
  );

  it.effect("shows the session Claude rotated to with /clear", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const rotated = "9f1b2c3d-0000-4000-8000-000000000001";
        const result = yield* identify({
          home,
          earlier: [
            providerThread({
              driver: "claudeAgent",
              instanceId: "claudeAgent",
              nativeId: sessionId,
            }),
          ],
          active: providerThread({
            id: ProviderThreadId.make("provider-thread-2"),
            driver: "claudeAgent",
            instanceId: "claudeAgent",
            nativeId: rotated,
          }),
        });
        expect(result.session?.nativeId).toBe(rotated);
      }),
    ),
  );

  it.effect("resumes Codex with the home the instance runs with and reads its shared index", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shared = `${home}/.codex-shared`;
        yield* fs.makeDirectory(shared, { recursive: true });
        yield* fs.writeFileString(
          `${shared}/session_index.jsonl`,
          `${JSON.stringify({ id: sessionId, thread_name: "Named in Codex" })}\n`,
        );
        const codex = (config: Record<string, unknown>, environment?: unknown) =>
          identify({
            home,
            active: providerThread({ driver: "codex", instanceId: "work", nativeId: sessionId }),
            providerInstances: {
              work: { driver: "codex", config, ...(environment ? { environment } : {}) },
            },
          });
        const overlay = yield* codex({ homePath: shared, shadowHomePath: `${home}/.codex-work` });
        expect(overlay.session).toMatchObject({
          name: "Named in Codex",
          command: `cd /home/user/app && CODEX_HOME=${home}/.codex-work codex resume ${sessionId}`,
        });
        const fromEnvironment = yield* codex({}, [
          { name: "CODEX_HOME", value: shared, sensitive: false },
        ]);
        expect(fromEnvironment.session).toMatchObject({
          name: "Named in Codex",
          command: `cd /home/user/app && CODEX_HOME=${shared} codex resume ${sessionId}`,
        });
      }),
    ),
  );

  it.effect.each([
    {
      name: "adopts a name set outside",
      native: "Outside",
      renames: ["Outside"],
      known: ["Outside"],
    },
    {
      name: "leaves a name it already knows",
      native: "Outside",
      knownBefore: ["Outside"],
      renames: [],
      known: ["Outside"],
    },
    {
      name: "leaves the title Claude's adapter applied last",
      native: "Outside",
      applied: "Outside",
      renames: [],
      known: [],
    },
    {
      name: "learns a name equal to the title",
      native: "Fix the flaky test",
      renames: [],
      known: ["Fix the flaky test"],
    },
    {
      name: "adopts a Codex name set outside",
      driver: "codex",
      native: "Outside",
      renames: ["Outside"],
      known: ["Outside"],
    },
    { name: "leaves a session without a name", native: null, renames: [], known: [] },
    {
      name: "leaves a session whose name cannot be read",
      native: "unreadable",
      renames: [],
      known: [],
    },
    {
      name: "waits for a pending title generation",
      generating: true,
      native: "Outside",
      renames: [],
      known: [],
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly driver?: "codex";
    readonly native: string | null;
    readonly knownBefore?: ReadonlyArray<string>;
    readonly applied?: string;
    readonly generating?: true;
    readonly renames: ReadonlyArray<string>;
    readonly known: ReadonlyArray<string>;
  }>)("the title $name", (row) =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const driver = row.driver ?? "claudeAgent";
        if (row.native === "unreadable") {
          // A file where the projects folder belongs cannot be listed, and is not an absent name.
          yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
          yield* fs.writeFileString(`${home}/.claude/projects`, "");
        } else if (row.native !== null && driver === "codex") {
          yield* fs.makeDirectory(`${home}/.codex`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.codex/session_index.jsonl`,
            `${JSON.stringify({ id: sessionId, thread_name: row.native })}\n`,
          );
        } else if (row.native !== null) {
          yield* writeTranscript(`${home}/.claude`, row.native);
        }
        const state = fixture({
          known: row.knownBefore ?? [],
          ...(row.generating ? { generating: true } : {}),
        });
        yield* sync({
          home,
          fixture: state,
          active: providerThread({
            driver,
            instanceId: driver,
            nativeId: sessionId,
            ...(row.applied === undefined ? {} : { title: row.applied }),
          }),
        });
        expect(state.renames).toEqual(row.renames);
        expect(state.known).toEqual(row.known);
      }),
    ),
  );

  it.effect("reads no file while the thread's title is being generated", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${home}/.codex`, { recursive: true });
        yield* fs.writeFileString(
          `${home}/.codex/session_index.jsonl`,
          `${JSON.stringify({ id: sessionId, thread_name: "Outside" })}\n`,
        );
        const touched: Array<string> = [];
        const counting = {
          ...fs,
          stat: (target) => {
            touched.push(target);
            return fs.stat(target);
          },
          open: (target, options) => {
            touched.push(target);
            return fs.open(target, options);
          },
        } as FileSystem.FileSystem;
        yield* sync({
          home,
          fixture: fixture({ generating: true }),
          active: providerThread({ driver: "codex", instanceId: "codex", nativeId: sessionId }),
        }).pipe(Effect.provideService(FileSystem.FileSystem, counting));
        expect(touched).toEqual([]);
      }),
    ),
  );

  it.effect("finds a Codex name beyond the tail with one read of the index", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${home}/.codex`, { recursive: true });
        const others = `${JSON.stringify({ id: "other", thread_name: `${"x".repeat(1000)}${sessionId}` })}\n`;
        yield* fs.writeFileString(
          `${home}/.codex/session_index.jsonl`,
          `${JSON.stringify({ id: sessionId, thread_name: "Named long ago" })}\n${others.repeat(2200)}`,
        );
        const opens: Array<string> = [];
        const counting = {
          ...fs,
          open: (target, options) => {
            opens.push(target);
            return fs.open(target, options);
          },
        } as FileSystem.FileSystem;
        const result = yield* identify({
          home,
          active: providerThread({ driver: "codex", instanceId: "codex", nativeId: sessionId }),
        }).pipe(Effect.provideService(FileSystem.FileSystem, counting));
        expect(result.session?.name).toBe("Named long ago");
        expect(opens).toHaveLength(1);
      }),
    ),
  );

  it.effect("logs an index too large to search instead of taking it for an absent name", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const index = `${home}/.codex/session_index.jsonl`;
        yield* fs.makeDirectory(`${home}/.codex`, { recursive: true });
        yield* fs.writeFileString(
          index,
          `${JSON.stringify({ id: sessionId, thread_name: "Named long ago" })}\n`,
        );
        yield* fs.truncate(index, 65 * 1024 * 1024);
        const logged: Array<string> = [];
        const logger = Logger.make(({ message }) => {
          logged.push(String(message));
        });
        const state = fixture();
        yield* sync({
          home,
          fixture: state,
          active: providerThread({ driver: "codex", instanceId: "codex", nativeId: sessionId }),
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
        expect(logged).toHaveLength(1);
        expect(state.renames).toEqual([]);
      }),
    ),
  );

  it.effect("names a long Pi session from its head when no later record names it", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = `${home}/session.jsonl`;
        const filler = `${JSON.stringify({ type: "message", text: "x".repeat(1000) })}\n`;
        yield* fs.writeFileString(
          file,
          `${JSON.stringify({ type: "session_info", name: "Named at the start" })}\n${filler.repeat(2200)}`,
        );
        const result = yield* identify({
          home,
          active: providerThread({ driver: "pi", instanceId: "pi", nativeId: file }),
        });
        expect(result.session?.name).toBe("Named at the start");
      }),
    ),
  );

  it.effect("leaves the default Claude home out of the command", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const result = yield* identify({
          home,
          active: providerThread({
            driver: "claudeAgent",
            instanceId: "claudeAgent",
            nativeId: sessionId,
          }),
        });
        expect(result.session?.command).toBe(`cd /home/user/app && claude --resume ${sessionId}`);
        expect(result.session?.name).toBeNull();
      }),
    ),
  );

  it.effect("gives an unverified driver's id and name with a note instead of a command", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const result = yield* identify({
          home,
          active: providerThread({
            driver: "grok",
            instanceId: "grok",
            nativeId: "acp-session",
            title: "Grok's name",
          }),
        });
        expect(result.session).toMatchObject({
          nativeId: "acp-session",
          name: "Grok's name",
          command: null,
        });
        expect(result.session?.commandNote).toContain("not yet verified");
      }),
    ),
  );

  it.effect("is empty before the provider opens a session", () =>
    withHome((home) =>
      Effect.gen(function* () {
        expect(yield* identify({ home, active: null })).toEqual({ session: null });
      }),
    ),
  );

  it.effect("refuses a thread that does not exist", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const failure = yield* identify({ home, active: null }, ThreadId.make("other")).pipe(
          Effect.flip,
        );
        expect(failure).toMatchObject({
          _tag: "T3fNativeSessionError",
          reason: "thread_not_found",
        });
      }),
    ),
  );
});
