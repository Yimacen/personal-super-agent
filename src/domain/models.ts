export type RiskClass =
  | "read"
  | "private_write"
  | "shared_write"
  | "external_write"
  | "financial"
  | "permission"
  | "destructive";

export type TaskState =
  | "received"
  | "routing"
  | "planning"
  | "executing"
  | "waiting_approval"
  | "verifying"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type ActionState =
  | "detected"
  | "planned"
  | "policy_evaluated"
  | "auto_approved"
  | "approval_pending"
  | "approved"
  | "denied"
  | "expired"
  | "superseded"
  | "executing"
  | "executed"
  | "outcome_unknown"
  | "verifying"
  | "verified"
  | "verification_failed"
  | "compensating"
  | "compensated"
  | "cancelled";

export type AgentRunState =
  | "claimed"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type JobKind =
  | "route_event"
  | "run_codex_task"
  | "resume_codex_task"
  | "send_approval"
  | "execute_action"
  | "verify_action";

export interface Actor {
  type: "system" | "worker" | "user" | "connector" | "watchdog";
  id: string;
}

export interface WorkerContext {
  userId: string;
  taskId: string;
  runId: string;
  workerId: string;
}

export interface EventInput {
  source: string;
  eventType: string;
  subjectKey: string;
  idempotencyKey: string;
  occurredAt: string;
  summary: string;
  payloadRef?: string | null | undefined;
  sensitivity: "public" | "internal" | "private" | "secret";
}

export interface ActionProposalInput {
  sourceAccountId: string;
  connectorId: string;
  capability: string;
  target: Record<string, unknown>;
  parameters: Record<string, unknown>;
  evidenceRefs: string[];
}

export interface PreparedAction {
  target: Record<string, unknown>;
  parameters: Record<string, unknown>;
  sideEffects: string[];
  expiresAt: string;
}

export interface ImmutableActionSnapshot {
  id: string;
  taskId: string;
  userId: string;
  sourceAccountId: string;
  connectorId: string;
  connectorVersion: string;
  capability: string;
  risk: RiskClass;
  target: Record<string, unknown>;
  parameters: Record<string, unknown>;
  sideEffects: string[];
  evidenceRefs: string[];
  reversible: boolean;
  idempotent: boolean;
  policyVersion: string;
  actionDigest: string;
  expiresAt: string;
}

export interface ConnectorReceipt {
  outcome: "success" | "failure" | "uncertain";
  connectorRequestId?: string;
  receiptRef?: string;
  errorCode?: string;
}

export interface VerificationResult {
  verified: boolean;
  reasonCode: string;
  observedState?: Record<string, unknown>;
}

export type PolicyDecision =
  | { decision: "allow"; reasonCode: string; policyVersion: string }
  | { decision: "approval"; reasonCode: string; policyVersion: string }
  | { decision: "deny"; reasonCode: string; policyVersion: string };
