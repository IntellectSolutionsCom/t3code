import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  UsageLimitSourceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const checkedAt = "2026-10-31T09:00:00.000Z";
const weekly = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 73,
  resetsAt: "2026-11-01T00:00:00.000Z",
} as const;

const provider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly usageLimits?: ServerProvider["usageLimits"];
  readonly enabled?: boolean;
  readonly email?: string;
  readonly workspaceId?: string;
  readonly signedOut?: boolean;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  displayName:
    input.driver === "codex" ? "Codex" : input.driver === "claude" ? "Claude" : input.driver,
  enabled: input.enabled ?? true,
  installed: true,
  version: "test",
  status: "ready",
  auth: {
    status: input.signedOut ? "unauthenticated" : "authenticated",
    ...(input.email ? { email: input.email } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  ...(input.usageLimits === undefined ? {} : { usageLimits: input.usageLimits }),
});

const sources = [
  {
    id: UsageLimitSourceId.make("proxy"),
    kind: "cliproxy",
    label: "CLI Proxy",
    checkedAt,
    accounts: [
      {
        id: "muse-account",
        driver: ProviderDriverKind.make("muse"),
        usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 41 }] },
      },
    ],
  },
  {
    id: UsageLimitSourceId.make("unavailable-proxy"),
    kind: "cliproxy",
    label: "Backup Proxy",
    checkedAt,
    accounts: [],
    error: "management-secret-sentinel",
  },
] as const satisfies ReadonlyArray<UsageLimitSourceSnapshot>;

const dependencies = (
  providers: ReadonlyArray<ServerProvider>,
  snapshots: ReadonlyArray<UsageLimitSourceSnapshot> = sources,
) =>
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ServerSettings.layerTest(),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(RemoteDelegation.RemoteDelegation)({}),
    Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed(snapshots) }),
  );

const scope = (capabilities: ReadonlySet<"orchestration">): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-usage-limits"),
  requestNamespace: "provider-session-usage-limits",
  thread: undefined,
  client: { sessionId: "read-only-client", label: "Agent", access: "read-only" },
  capabilities,
  issuedAt: 1,
});

it.effect("aggregates provider drivers, preserves probe timestamps and hides credentials", () =>
  Effect.gen(function* () {
    const providers = [
      provider({
        instanceId: "codex",
        driver: "codex",
        usageLimits: {
          checkedAt,
          windows: [weekly],
          credentialFingerprint: "credential-fingerprint-sentinel",
          resetCredits: { availableCount: 1, nextCreditId: "redemption-handle-sentinel" },
          unavailable: { reason: "probeFailed", message: "raw provider response" },
        },
      }),
      provider({
        instanceId: "claude",
        driver: "claude",
        usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      }),
      provider({ instanceId: "grok", driver: "grok" }),
    ];
    const layer = OrchestratorMcpService.layer.pipe(Layer.provide(dependencies(providers)));
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(layer),
    );
    yield* TestClock.setTime(Date.parse(weekly.resetsAt));

    const result = yield* service.usageLimits({
      ...scope(new Set(["orchestration"])),
      thread: {
        threadId: ThreadId.make("usage-limits-thread"),
        providerSessionId: "usage-limits-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    });

    expect(result.providers.map((account) => account.driver)).toEqual([
      "codex",
      "claude",
      "grok",
      "muse",
    ]);
    expect(result.providers.find((account) => account.driver === "codex")?.limits).toEqual({
      checkedAt,
      windows: [{ ...weekly, remainingPercent: 27 }],
      unavailable: { reason: "probeFailed" },
    });
    expect(result.providers.find((account) => account.driver === "muse")?.limits).toEqual({
      checkedAt,
      windows: [{ ...weekly, usedPercent: 41, remainingPercent: 59 }],
    });
    expect(result.notices).toContain("Claude [claude]: usage limits are not supported.");
    expect(result.notices).toContain("Codex [codex]: usage limits could not be refreshed.");
    expect(result.notices).toContain(
      "Codex [codex] · Weekly: reset after this reading, so the figure is from before the reset.",
    );
    expect(result.notices).toContain("Backup Proxy: unable to read provider usage limits.");
    expect(JSON.stringify(result)).not.toContain("credential-fingerprint-sentinel");
    expect(JSON.stringify(result)).not.toContain("redemption-handle-sentinel");
    expect(JSON.stringify(result)).not.toContain("management-secret-sentinel");
    expect(JSON.stringify(result)).not.toContain("raw provider response");
  }),
);

it.effect("requires orchestration scope before reading provider usage", () =>
  Effect.gen(function* () {
    const layer = OrchestratorMcpService.layer.pipe(Layer.provide(dependencies([])));
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(layer),
    );
    const error = yield* service.usageLimits(scope(new Set())).pipe(Effect.flip);

    expect(error.code).toBe("capability_denied");
  }),
);

it.effect("lists each native instance and drops proxy accounts sharing a login", () =>
  Effect.gen(function* () {
    const email = "shared@example.com";
    const providers = [
      provider({
        instanceId: "primary",
        driver: "codex",
        email,
        usageLimits: { checkedAt, windows: [weekly] },
      }),
      provider({
        instanceId: "stale",
        driver: "codex",
        email,
        usageLimits: {
          checkedAt: "2026-10-30T09:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      }),
    ];
    const snapshots = [
      {
        ...sources[0],
        accounts: [
          {
            id: "shared",
            driver: ProviderDriverKind.make("codex"),
            email,
            usageLimits: { checkedAt, windows: [weekly] },
          },
        ],
      },
    ];
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(
        OrchestratorMcpService.layer.pipe(Layer.provide(dependencies(providers, snapshots))),
      ),
    );
    const result = yield* service.usageLimits(scope(new Set(["orchestration"])));
    expect(result.providers.map((account) => account.providerInstanceId)).toEqual([
      "primary",
      "stale",
    ]);
    expect(result.providers[0]?.limits.windows).toEqual([{ ...weekly, remainingPercent: 27 }]);
    expect(result.providers[1]?.limits).toEqual({
      checkedAt: "2026-10-30T09:00:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
    expect(result.notices).toEqual(["Codex [stale]: usage limits could not be refreshed."]);
  }),
);

it.effect("keeps each instance's own figures when workspaces share one login", () =>
  Effect.gen(function* () {
    const email = "shared@example.com";
    const instance = (instanceId: string, workspaceId: string, usedPercent: number) =>
      provider({
        instanceId,
        driver: "codex",
        email,
        workspaceId,
        usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent }] },
      });
    const providers = [
      instance("a", "one", 10),
      instance("b", "one", 20),
      instance("c", "two", 30),
    ];
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies(providers, [])))),
    );
    const result = yield* service.usageLimits(scope(new Set(["orchestration"])));
    expect(
      result.providers.map((account) => [
        account.providerInstanceId,
        account.limits.windows[0]?.usedPercent,
      ]),
    ).toEqual([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);
  }),
);

it.effect(
  "omits disabled instances and distinguishes pending snapshots from unsupported drivers",
  () =>
    Effect.gen(function* () {
      const providers = [
        provider({
          instanceId: "disabled",
          driver: "codex",
          enabled: false,
          usageLimits: { checkedAt, windows: [weekly] },
        }),
        provider({ instanceId: "pending", driver: "grok" }),
        provider({
          instanceId: "capped",
          driver: "claude",
          usageLimits: { checkedAt, windows: [], zeroSpendCap: true },
        }),
        provider({
          instanceId: "capped-used",
          driver: "claude",
          usageLimits: {
            checkedAt,
            windows: [{ ...weekly, usedPercent: 112.6 }],
            zeroSpendCap: true,
          },
        }),
        provider({
          instanceId: "signed-out",
          driver: "codex",
          signedOut: true,
          usageLimits: { checkedAt, windows: [weekly] },
        }),
      ];
      const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
        Effect.provide(
          OrchestratorMcpService.layer.pipe(Layer.provide(dependencies(providers, []))),
        ),
      );
      const result = yield* service.usageLimits(scope(new Set(["orchestration"])));
      expect(result.providers.map((account) => account.id)).toEqual([
        "pending",
        "capped",
        "capped-used",
        "signed-out",
      ]);
      expect(result.providers[0]?.limits).toEqual({ checkedAt, windows: [] });
      expect(result.providers[1]?.limits).toEqual({ checkedAt, windows: [], zeroSpendCap: true });
      expect(result.providers[2]?.limits).toEqual({
        checkedAt,
        windows: [{ ...weekly, usedPercent: 112.6, remainingPercent: 0 }],
        zeroSpendCap: true,
      });
      expect(result.providers[3]?.limits).toEqual({
        checkedAt,
        windows: [],
        unavailable: { reason: "unauthenticated" },
      });
      expect(result.notices).toEqual([
        "grok [pending]: no usage limits reported yet.",
        "Claude [capped]: monthly spend cap is $0; no paid usage beyond the plan.",
        "Claude [capped-used]: monthly spend cap is $0; no paid usage beyond the plan.",
        "Codex [signed-out]: no usage limits reported yet.",
      ]);
    }),
);
