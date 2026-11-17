import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ApprovalCard,
  ApprovalNotifier,
  NotificationResult,
} from "../notifications/contracts.js";

const execFileAsync = promisify(execFile);

export interface DingTalkCardMessages {
  surfaceId: string;
  messages: Record<string, unknown>[];
}

export function contentArg(messages: Record<string, unknown>[]): string {
  return JSON.stringify(
    messages.map((message) => JSON.stringify(message)),
  );
}

export function buildDingTalkApprovalCard(
  card: ApprovalCard,
  catalogUrl: string,
): DingTalkCardMessages {
  const surfaceId = `approval-${card.approvalId.replaceAll(
    /[^a-zA-Z0-9_-]/g,
    "",
  )}`;
  const details = [
    `摘要：${card.summary}`,
    `目标：${JSON.stringify(card.target)}`,
    `参数：${JSON.stringify(card.parameters)}`,
    `副作用：${card.sideEffects.join("；")}`,
    `可撤销：${card.reversible ? "是" : "否"}`,
    `动作摘要：${card.actionDigest.slice(0, 20)}…`,
    `有效期至：${card.expiresAt}`,
  ].join("\n");

  return {
    surfaceId,
    messages: [
      {
        version: "v1.0",
        createSurface: {
          surfaceId,
          catalogId: catalogUrl,
          dataModel: {
            title: { text: "个人助理需要你的确认" },
            summary: { text: card.title },
            details: { text: details },
            status: { text: "等待审批…" },
          },
        },
      },
      {
        version: "v1.0",
        updateComponents: {
          surfaceId,
          components: [
            {
              id: "root",
              component: "Column",
              align: "stretch",
              children: [
                "title",
                "summary",
                "details",
                "actionRow",
                "status",
              ],
            },
            {
              id: "title",
              component: "Text",
              text: { path: "/title/text" },
              bold: true,
            },
            {
              id: "summary",
              component: "Text",
              text: { path: "/summary/text" },
            },
            {
              id: "details",
              component: "Text",
              text: { path: "/details/text" },
            },
            {
              id: "actionRow",
              component: "Row",
              align: "stretch",
              children: ["approve", "deny"],
            },
            {
              id: "approve",
              component: "Button",
              child: "approve_label",
              action: {
                event: {
                  name: "approval_decision",
                  context: {
                    decision: "approve",
                    approvalId: card.approvalId,
                    actionDigest: card.actionDigest,
                    surfaceId,
                  },
                },
              },
            },
            {
              id: "approve_label",
              component: "Text",
              text: "批准",
            },
            {
              id: "deny",
              component: "Button",
              child: "deny_label",
              action: {
                event: {
                  name: "approval_decision",
                  context: {
                    decision: "deny",
                    approvalId: card.approvalId,
                    actionDigest: card.actionDigest,
                    surfaceId,
                  },
                },
              },
            },
            {
              id: "deny_label",
              component: "Text",
              text: "拒绝",
            },
            {
              id: "status",
              component: "Text",
              text: { path: "/status/text" },
            },
          ],
        },
      },
    ],
  };
}

export interface DwsClientOptions {
  command: string;
  catalogUrl: string;
  approverOpenId: string | null;
  env?: Record<string, string>;
}

export interface DingTalkSelfIdentity {
  openDingTalkId: string;
  uid: string;
}

export class DingTalkDwsClient {
  constructor(private readonly options: DwsClientOptions) {}

  async authStatus(): Promise<Record<string, unknown>> {
    return this.run(["auth", "status"]);
  }

  async selfIdentity(): Promise<DingTalkSelfIdentity> {
    const result = await this.run(["contact", "user", "get-self"]);
    const employee = (
      result.result as
        | Array<{
            orgEmployeeModel?: {
              openDingTalkId?: string;
              userId?: string | number;
            };
          }>
        | undefined
    )?.[0]?.orgEmployeeModel;
    const openDingTalkId =
      this.options.approverOpenId ?? employee?.openDingTalkId;
    if (!openDingTalkId || employee?.userId === undefined) {
      throw new Error("Cannot resolve DingTalk self identity");
    }
    return {
      openDingTalkId,
      uid: String(employee.userId),
    };
  }

  async sendApprovalCard(
    card: ApprovalCard,
  ): Promise<{
    surfaceId: string;
    bizId: string;
    result: Record<string, unknown>;
  }> {
    const status = await this.authStatus();
    if (!status.authenticated || !status.token_valid) {
      throw new Error("DingTalk dws is not authenticated. Run: dws auth login --device");
    }
    const built = buildDingTalkApprovalCard(card, this.options.catalogUrl);
    await this.lintCard(built.messages);
    const identity = await this.selfIdentity();
    const result = await this.run([
      "chat",
      "message",
      "send-a2ui-card",
      "--open-dingtalk-id",
      identity.openDingTalkId,
      "--summary",
      "个人助理审批".slice(0, 60),
      "--content",
      contentArg(built.messages),
    ]);
    const payload =
      (result.data as Record<string, unknown> | undefined) ??
      (result.result as Record<string, unknown> | undefined) ??
      {};
    const bizId = payload.bizId;
    if (typeof bizId !== "string" || !bizId) {
      throw new Error(
        `DingTalk card send returned no bizId: ${JSON.stringify(result)}`,
      );
    }
    return { surfaceId: built.surfaceId, bizId, result };
  }

  async updateCard(
    bizId: string,
    surfaceId: string,
    status: string,
  ): Promise<Record<string, unknown>> {
    const messages = [
      {
        version: "v1.0",
        updateDataModel: {
          surfaceId,
          path: "/status/text",
          value: status,
        },
      },
    ];
    return this.run([
      "chat",
      "message",
      "update-a2ui-card",
      "--biz-id",
      bizId,
      "--flow-status",
      "FINISH",
      "--a2ui-annotations",
      JSON.stringify([
        {
          surfaceId,
          componentId: "status",
          type: "artifact",
        },
      ]),
      "--content",
      contentArg(messages),
    ]);
  }

  private async lintCard(
    messages: Record<string, unknown>[],
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "dingtalk-card-"));
    const path = join(directory, "card.a2ui.json");
    try {
      await writeFile(path, JSON.stringify(messages), {
        encoding: "utf8",
        mode: 0o600,
      });
      const result = await this.run([
        "aicard",
        "lint",
        "--file",
        path,
        "--preflight",
        "new-card",
      ]);
      const data = result.data as
        | { valid?: boolean; preflight?: { valid?: boolean } }
        | undefined;
      if (!data?.valid || !data.preflight?.valid) {
        throw new Error(
          `DingTalk card lint failed: ${JSON.stringify(result)}`,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async run(
    args: string[],
    timeout = 90_000,
  ): Promise<Record<string, unknown>> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ]) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    Object.assign(env, this.options.env);
    try {
      const { stdout } = await execFileAsync(
        this.options.command,
        [...args, "--format", "json"],
        {
          env,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (error) {
      const detail =
        error &&
        typeof error === "object" &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`dws ${args.join(" ")} failed: ${detail}`);
    }
  }
}

export class DingTalkNotifier implements ApprovalNotifier {
  readonly provider = "dingtalk" as const;
  readonly client: DingTalkDwsClient;

  constructor(options: DwsClientOptions) {
    this.client = new DingTalkDwsClient(options);
  }

  async sendApproval(card: ApprovalCard): Promise<NotificationResult> {
    const sent = await this.client.sendApprovalCard(card);
    return {
      deliveryRef: `dingtalk://card/${sent.bizId}`,
      dryRun: false,
      metadata: {
        bizId: sent.bizId,
        surfaceId: sent.surfaceId,
      },
    };
  }
}
