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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
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

const layer = (input: {
  readonly home: string;
  readonly active: OrchestrationV2ProviderThread | null;
  readonly earlier?: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly providerInstances?: Record<string, unknown>;
}) => {
  const shell = {
    id: threadId,
    projectId,
    title: "Fix the flaky test",
    worktreePath: null,
    activeProviderThreadId: input.active?.id ?? null,
    deletedAt: null,
  } as unknown as OrchestrationV2ThreadShell;
  return NativeSessions.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
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

const identify = (input: Parameters<typeof layer>[0], id = threadId) =>
  NativeSessions.NativeSessions.pipe(
    Effect.flatMap((sessions) => sessions.identify(id)),
    Effect.provide(layer(input)),
    Effect.provideService(HostProcess.HomeDirectory, input.home),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(HostProcess.Platform, "linux"),
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
        const result = yield* identify({
          home,
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
        });
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
