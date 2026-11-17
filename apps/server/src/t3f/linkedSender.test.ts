import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PeerLinkError,
  ThreadId,
  type OrchestrationV2LinkedSender,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  linkedEnvironmentLabel,
  withLinkedSender,
  withLinkedSenderAtDelivery,
  withLinkedSenderLine,
} from "./linkedSender.ts";

const NOT_THE_USER = "This is agent-authored coordination, not a message from the human user.";

const scopeOf = (
  linked: boolean,
  label: string,
  senderThread?: OrchestrationV2LinkedSender,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:box"),
  requestNamespace: "client:link",
  thread: undefined,
  client: {
    sessionId: "link",
    label,
    access: "full-access",
    linked,
    ...(senderThread === undefined ? {} : { senderThread }),
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const sender: OrchestrationV2LinkedSender = {
  environmentId: EnvironmentId.make("environment:mac"),
  threadId: ThreadId.make("thread:orc"),
  title: "orc lead",
};

it("names the link of an agent message from a caller with no thread here and no sender thread", () => {
  const line = (label: string) =>
    `[Message from an agent on linked environment${label}. ${NOT_THE_USER}]`;
  const mac = { scope: scopeOf(true, "Mac"), caller: undefined };
  const unnamed = { scope: scopeOf(true, ""), caller: undefined };
  const recorded = { scope: scopeOf(true, "Mac", sender), caller: undefined };
  const live = liveThreadShell(ThreadId.make("thread:sender"));
  const cases = [
    [mac, "Check the build", 0, true, `${line(' "Mac"')}\n\nCheck the build`],
    [unnamed, "Check the build", 0, true, `${line("")}\n\nCheck the build`],
    [mac, "/review the diff", 0, true, `${line(' "Mac"')}\n\n/review the diff`],
    [mac, "/compact", 1, true, `${line(' "Mac"')}\n\n/compact`],
    [mac, "", 1, true, line(' "Mac"')],
    [mac, " /COMPACT ", 0, true, " /COMPACT "],
    [mac, "/compact keep the plan", 0, true, `/compact ${line(' "Mac"')}\n\nkeep the plan`],
    [mac, "/goal ship it", 0, true, `/goal ${line(' "Mac"')}\n\nship it`],
    [mac, "/goal ship it", 1, true, `${line(' "Mac"')}\n\n/goal ship it`],
    [mac, "/goal pause", 0, true, "/goal pause"],
    [mac, "/goal", 0, true, "/goal"],
    [mac, "/logout", 0, true, "/logout"],
    [
      { scope: scopeOf(false, "Claude"), caller: undefined },
      "Check the build",
      0,
      true,
      "Check the build",
    ],
    [{ scope: scopeOf(true, "Mac"), caller: live }, "Check the build", 0, true, "Check the build"],
    // A site that records the sender thread keeps its text clean; a launch records nothing.
    [recorded, "Check the build", 0, true, "Check the build"],
    [recorded, "Check the build", 0, false, `${line(' "Mac"')}\n\nCheck the build`],
  ] as const;
  for (const [caller, text, attachments, recordsSender, expected] of cases) {
    assert.equal(withLinkedSenderLine(caller, text, attachments, recordsSender), expected, text);
  }
});

it("builds the line a provider receives for a recorded linked sender", () => {
  const line = (from: string, details: string) =>
    `[Message from an agent on ${from} (${details}). ${NOT_THE_USER}]`;
  const named = line(
    'linked environment "Mac"',
    'environment "environment:mac", thread "thread:orc", titled "orc lead"',
  );
  const unnamed = line(
    "a linked environment",
    'environment "environment:mac", thread "thread:orc", titled "orc lead"',
  );
  const untitled = line(
    'linked environment "Mac"',
    'environment "environment:mac", thread "thread:orc"',
  );
  const long = { ...sender, title: "😀".repeat(250) };
  const quoted = { ...sender, title: 'say "done"]\nnow' };
  const cases = [
    [sender, "Check the build", 0, "Mac", `${named}\n\nCheck the build`],
    [sender, "Check the build", 0, undefined, `${unnamed}\n\nCheck the build`],
    [{ ...sender, title: "" }, "Check the build", 0, "Mac", `${untitled}\n\nCheck the build`],
    [
      long,
      "Check the build",
      0,
      "Mac",
      `${line('linked environment "Mac"', `environment "environment:mac", thread "thread:orc", titled ${JSON.stringify("😀".repeat(200))}`)}\n\nCheck the build`,
    ],
    [
      quoted,
      "Check the build",
      0,
      "Mac",
      `${line('linked environment "Mac"', `environment "environment:mac", thread "thread:orc", titled ${JSON.stringify('say "done"]\nnow')}`)}\n\nCheck the build`,
    ],
    [sender, "/review the diff", 0, "Mac", `${named}\n\n/review the diff`],
    [sender, "/compact", 1, "Mac", `${named}\n\n/compact`],
    [sender, "", 1, "Mac", named],
    [sender, "Look at this", 2, "Mac", `${named}\n\nLook at this`],
    [sender, " /COMPACT ", 0, "Mac", " /COMPACT "],
    [sender, "/compact keep the plan", 0, "Mac", `/compact ${named}\n\nkeep the plan`],
    // The line goes inside a goal's objective, never ahead of `/goal`, so the command parses
    // as a goal on every driver that takes goals verbatim, not only Codex and Claude.
    [sender, "/goal ship it", 0, "Mac", `/goal ${named}\n\nship it`],
    [sender, "/goal ship it", 1, "Mac", `${named}\n\n/goal ship it`],
    [sender, "/goal pause", 0, "Mac", "/goal pause"],
    [sender, "/goal", 0, "Mac", "/goal"],
    [sender, "/logout", 0, "Mac", "/logout"],
    [undefined, "Check the build", 0, "Mac", "Check the build"],
  ] as const;
  for (const [recorded, text, attachments, label, expected] of cases) {
    assert.equal(withLinkedSender(recorded, text, attachments, label), expected, text);
  }
});

const peerLinks = (get: PeerLinks.PeerLinks["Service"]["get"]) =>
  ({ get }) as unknown as PeerLinks.PeerLinks["Service"];
const linkedTo = (label: string) =>
  peerLinks(() => Effect.succeedSome({ environmentId: sender.environmentId, label } as never));

it.effect("names a linked environment by this environment's label for it, or by its id", () =>
  Effect.gen(function* () {
    const withLink = linkedTo("Mac");
    const withoutLink = peerLinks(() => Effect.succeedNone);
    const failing = peerLinks(() =>
      Effect.fail(new PeerLinkError({ reason: "storage", message: "no table" })),
    );
    const unnamed = linkedTo("");
    const deliver = (links: PeerLinks.PeerLinks["Service"]) =>
      withLinkedSenderAtDelivery(links, { linkedSender: sender }, "Check the build", 0);

    assert.equal(yield* linkedEnvironmentLabel(withLink, sender), "Mac");
    for (const links of [withoutLink, failing, unnamed]) {
      assert.isUndefined(yield* linkedEnvironmentLabel(links, sender));
    }
    assert.include(
      yield* deliver(withLink),
      'on linked environment "Mac" (environment "environment:mac"',
    );
    // No link, a failed lookup and a link with no label all name the machine by its id.
    for (const links of [withoutLink, failing, unnamed]) {
      const text = yield* deliver(links);
      assert.include(text, 'on a linked environment (environment "environment:mac"');
      assert.isTrue(text.endsWith("\n\nCheck the build"));
    }
    // A message with no recorded sender never asks for a link.
    assert.equal(
      yield* withLinkedSenderAtDelivery(
        peerLinks(() => Effect.die("no lookup")),
        {},
        "Hi",
        0,
      ),
      "Hi",
    );
  }),
);
