import type {
  ActionState,
  AgentRunState,
  JobKind,
  RiskClass,
  TaskState,
} from "../domain/models.js";

export interface EventRow {
  id: string;
  user_id: string;
  source_account_id: string | null;
  source: string;
  event_type: string;
  subject_key: string;
  idempotency_key: string;
  occurred_at: string;
  received_at: string;
  summary: string;
  payload_ref: string | null;
  sensitivity: string;
  trace_id: string;
  schema_version: number;
}

export interface TaskRow {
  id: string;
  user_id: string;
  assistant_id: string;
  goal: string;
  acceptance_criteria_json: string;
  state: TaskState;
  priority: number;
  trigger_event_id: string;
  deadline_at: string | null;
  budget_cents: number | null;
  max_model_tokens: number | null;
  active_action_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  kind: JobKind;
  aggregate_id: string | null;
  idempotency_key: string;
  payload_json: string;
  status: "pending" | "claimed" | "done" | "failed" | "dead_letter";
  run_after: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActionRow {
  id: string;
  task_id: string;
  user_id: string;
  source_account_id: string;
  connector_id: string;
  connector_version: string;
  capability: string;
  risk: RiskClass;
  target_json: string;
  parameters_json: string;
  side_effects_json: string;
  evidence_refs_json: string;
  reversible: number;
  idempotent: number;
  policy_version: string;
  action_digest: string;
  state: ActionState;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  action_id: string;
  action_digest: string;
  approver_ref: string;
  status: "pending" | "approved" | "denied" | "expired" | "superseded";
  reason: string | null;
  expires_at: string;
  callback_event_id: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface LeaseRow {
  id: string;
  action_id: string;
  action_digest: string;
  issued_to: string;
  device_id: string | null;
  token_hash: string;
  status: "issued" | "claimed" | "used" | "revoked" | "expired";
  expires_at: string;
  claimed_at: string | null;
  used_at: string | null;
  created_at: string;
}

export interface AgentRunRow {
  id: string;
  job_id: string;
  task_id: string;
  worker_id: string;
  codex_thread_id: string | null;
  codex_model: string | null;
  workspace_ref: string;
  state: AgentRunState;
  step_count: number;
  model_tokens: number;
  cost_cents: number;
  last_error: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

export interface RunTokenRow {
  id: string;
  run_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}
