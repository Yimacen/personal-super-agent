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
  metadata?: Record<string, string>;
}

export interface ApprovalNotifier {
  readonly provider: "feishu" | "dingtalk";
  sendApproval(card: ApprovalCard): Promise<NotificationResult>;
}
