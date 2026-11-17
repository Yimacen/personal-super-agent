import type { ActionState, TaskState } from "./models.js";

const TASK_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  received: new Set(["routing", "planning", "failed", "cancelled"]),
  routing: new Set(["planning", "failed", "cancelled"]),
  planning: new Set(["executing", "waiting_approval", "paused", "completed", "failed", "cancelled"]),
  executing: new Set(["waiting_approval", "verifying", "paused", "completed", "failed", "cancelled"]),
  waiting_approval: new Set(["executing", "paused", "failed", "cancelled"]),
  verifying: new Set(["executing", "completed", "failed", "paused", "cancelled"]),
  paused: new Set(["planning", "executing", "failed", "cancelled"]),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

const ACTION_TRANSITIONS: Record<ActionState, ReadonlySet<ActionState>> = {
  detected: new Set(["planned", "denied", "cancelled"]),
  planned: new Set(["policy_evaluated", "denied", "cancelled"]),
  policy_evaluated: new Set(["auto_approved", "approval_pending", "denied", "cancelled"]),
  auto_approved: new Set(["executing", "cancelled"]),
  approval_pending: new Set(["approved", "denied", "expired", "superseded", "cancelled"]),
  approved: new Set(["executing", "cancelled"]),
  denied: new Set([]),
  expired: new Set([]),
  superseded: new Set([]),
  executing: new Set(["executed", "outcome_unknown", "cancelled"]),
  executed: new Set(["verifying"]),
  outcome_unknown: new Set(["verifying", "cancelled"]),
  verifying: new Set(["verified", "verification_failed"]),
  verified: new Set(["compensating"]),
  verification_failed: new Set(["compensating", "cancelled"]),
  compensating: new Set(["compensated", "verification_failed"]),
  compensated: new Set([]),
  cancelled: new Set([]),
};

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!TASK_TRANSITIONS[from].has(to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}

export function assertActionTransition(from: ActionState, to: ActionState): void {
  if (!ACTION_TRANSITIONS[from].has(to)) {
    throw new Error(`Illegal action transition: ${from} -> ${to}`);
  }
}
