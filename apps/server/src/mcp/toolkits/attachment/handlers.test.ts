import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2LinkedSender,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AssetSigner from "../../../assets/AssetSigner.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as AttachmentHandlers from "./handlers.ts";
import { AttachmentToolkit } from "./tools.ts";

const sender: OrchestrationV2LinkedSender = {
  environmentId: EnvironmentId.make("environment:mac"),
  threadId: ThreadId.make("thread:orc"),
  title: "orc lead",
};

const sendAttachmentsAs = (senderThread: OrchestrationV2LinkedSender | undefined) =>
  Effect.gen(function* () {
    const target = liveThreadShell(ThreadId.make("thread:target"));
    const attachment = {
      type: "file" as const,
      id: "thread-target-notes",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    };
    const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(AssetSigner.AssetSigner)({}),
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:here"),
        requestNamespace: "link:mac",
        thread: undefined,
        client: {
          sessionId: "link-mac",
          label: "Mac",
          access: "full-access",
          linked: true,
          ...(senderThread === undefined ? {} : { senderThread }),
        },
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(target),
        getProjectThreadRecords: () =>
          Effect.succeed({
            ...idleThreadProjection(target),
            messages: [{ attachments: [attachment] }],
          } as never),
        sendToThread: (input) => {
          sent.push(input);
          return Effect.succeed({
            run: { id: RunId.make("run:sent"), status: "running" },
            message: { attachments: [attachment] },
            delivery: "started",
          } as never);
        },
      }),
      DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachments-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeCrypto.layer,
    );
    const toolkit = yield* AttachmentToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(AttachmentHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    yield* toolkit
      .handle("t3_thread_send_attachments", {
        threadId: target.id,
        message: "Here are the notes",
        attachments: [attachment],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return sent[0];
  });

it.effect(
  "an attachment send from a linked agent records its sender thread, or names its link",
  () =>
    Effect.gen(function* () {
      const withThread = yield* sendAttachmentsAs(sender);
      expect(withThread?.linkedSender).toEqual(sender);
      expect(withThread?.text).toBe("Here are the notes");

      const withoutThread = yield* sendAttachmentsAs(undefined);
      expect(withoutThread?.linkedSender).toBeUndefined();
      expect(withoutThread?.text).toBe(
        '[Message from an agent on linked environment "Mac". This is agent-authored coordination, not a message from the human user.]\n\nHere are the notes',
      );
    }),
);
