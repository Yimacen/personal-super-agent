import { createHmac } from "node:crypto";

export interface ApprovalCard {
  approvalId: string;
  actionId: string;
  actionDigest: string;
  title: string;
  summary: string;
  target: Record<string, unknown>;
  parameters: Record<string, unknown>;
  sideEffects: string[];
  reversible: boolean;
  expiresAt: string;
}

export interface NotificationResult {
  deliveryRef: string;
  dryRun: boolean;
}

export class FeishuNotifier {
  constructor(
    private readonly webhookUrl: string | null,
    private readonly signingSecret: string | null,
  ) {}

  async sendApproval(card: ApprovalCard): Promise<NotificationResult> {
    const payload = {
      msg_type: "interactive",
      card: {
        header: {
          template: "orange",
          title: { tag: "plain_text", content: "个人助理需要你的确认" },
        },
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: [
                `**准备执行**：${card.title}`,
                `**摘要**：${card.summary}`,
                `**目标**：\`${JSON.stringify(card.target)}\``,
                `**参数**：\`${JSON.stringify(card.parameters)}\``,
                `**副作用**：${card.sideEffects.join("；")}`,
                `**可撤销**：${card.reversible ? "是" : "否"}`,
                `**审批 ID**：\`${card.approvalId}\``,
                `**动作摘要**：\`${card.actionDigest.slice(0, 16)}…\``,
                `**过期时间**：${card.expiresAt}`,
              ].join("\n"),
            },
          },
          {
            tag: "action",
            actions: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "批准" },
                type: "primary",
                value: {
                  decision: "approve",
                  approvalId: card.approvalId,
                  actionDigest: card.actionDigest,
                },
              },
              {
                tag: "button",
                text: { tag: "plain_text", content: "拒绝" },
                type: "danger",
                value: {
                  decision: "deny",
                  approvalId: card.approvalId,
                  actionDigest: card.actionDigest,
                },
              },
            ],
          },
        ],
      },
    };

    if (!this.webhookUrl) {
      return {
        deliveryRef: "dry-run://feishu/approval-card",
        dryRun: true,
      };
    }

    const body: Record<string, unknown> = { ...payload };
    if (this.signingSecret) {
      const timestamp = Math.floor(Date.now() / 1_000).toString();
      const stringToSign = `${timestamp}\n${this.signingSecret}`;
      const sign = createHmac("sha256", stringToSign)
        .update("")
        .digest("base64");
      body.timestamp = timestamp;
      body.sign = sign;
    }

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        `Feishu webhook returned ${response.status}: ${await response.text()}`,
      );
    }
    return {
      deliveryRef: `feishu://webhook/${Date.now()}`,
      dryRun: false,
    };
  }
}
