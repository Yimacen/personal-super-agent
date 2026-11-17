PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE assistants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  display_name TEXT NOT NULL,
  profile_ref TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  connector_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  secret_ref TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, connector_id, account_ref)
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_account_id TEXT REFERENCES source_accounts(id),
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_ref TEXT,
  sensitivity TEXT NOT NULL CHECK (
    sensitivity IN ('public', 'internal', 'private', 'secret')
  ),
  trace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  UNIQUE (user_id, idempotency_key)
) STRICT;

CREATE INDEX events_subject_idx ON events(user_id, subject_key, occurred_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  assistant_id TEXT NOT NULL REFERENCES assistants(id),
  goal TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
  state TEXT NOT NULL CHECK (
    state IN (
      'received', 'routing', 'planning', 'executing', 'waiting_approval',
      'verifying', 'paused', 'completed', 'failed', 'cancelled'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  trigger_event_id TEXT NOT NULL REFERENCES events(id),
  deadline_at TEXT,
  budget_cents INTEGER,
  max_model_tokens INTEGER,
  active_action_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX tasks_user_state_idx ON tasks(user_id, state, updated_at DESC);

CREATE TABLE task_events (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (task_id, event_id)
) STRICT;

CREATE TABLE task_accounts (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source_account_id TEXT NOT NULL REFERENCES source_accounts(id),
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (task_id, source_account_id)
) STRICT;

CREATE TABLE thread_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  subject_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, subject_key, task_id)
) STRICT;

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT UNIQUE REFERENCES agent_runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  source_account_id TEXT NOT NULL REFERENCES source_accounts(id),
  connector_id TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  capability TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (
    risk IN (
      'read', 'private_write', 'shared_write', 'external_write',
      'financial', 'permission', 'destructive'
    )
  ),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
  side_effects_json TEXT NOT NULL CHECK (json_valid(side_effects_json)),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  reversible INTEGER NOT NULL CHECK (reversible IN (0, 1)),
  idempotent INTEGER NOT NULL CHECK (idempotent IN (0, 1)),
  policy_version TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'detected', 'planned', 'policy_evaluated', 'auto_approved',
      'approval_pending', 'approved', 'denied', 'expired', 'superseded',
      'executing', 'executed', 'outcome_unknown', 'verifying', 'verified',
      'verification_failed', 'compensating', 'compensated', 'cancelled'
    )
  ),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX actions_task_idx ON actions(task_id, created_at DESC);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  action_digest TEXT NOT NULL,
  approver_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'denied', 'expired', 'superseded')
  ),
  reason TEXT,
  expires_at TEXT NOT NULL,
  callback_event_id TEXT UNIQUE,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (action_id, action_digest)
) STRICT;

CREATE TABLE execution_leases (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
  action_digest TEXT NOT NULL,
  issued_to TEXT NOT NULL,
  device_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('issued', 'claimed', 'used', 'revoked', 'expired')
  ),
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE execution_receipts (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE REFERENCES execution_leases(id),
  connector_request_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'uncertain')),
  receipt_ref TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  receipt_id TEXT REFERENCES execution_receipts(id),
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  observed_state_json TEXT CHECK (
    observed_state_json IS NULL OR json_valid(observed_state_json)
  ),
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worker_id TEXT NOT NULL,
  codex_thread_id TEXT,
  codex_model TEXT,
  workspace_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('claimed', 'running', 'waiting', 'completed', 'failed', 'cancelled')
  ),
  step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  model_tokens INTEGER NOT NULL DEFAULT 0 CHECK (model_tokens >= 0),
  cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  last_error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX agent_runs_task_idx ON agent_runs(task_id, started_at DESC);

CREATE TABLE agent_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
  kind TEXT NOT NULL,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE run_tokens (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'route_event', 'run_codex_task', 'resume_codex_task', 'send_approval',
      'execute_action', 'verify_action'
    )
  ),
  aggregate_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'claimed', 'done', 'failed', 'dead_letter')
  ),
  run_after TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_by TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, idempotency_key)
) STRICT;

CREATE INDEX jobs_claim_idx ON jobs(status, run_after, created_at);
CREATE INDEX jobs_lease_idx ON jobs(status, lease_until, locked_by, run_after);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  policy_version TEXT,
  model_version TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX audit_aggregate_idx
  ON audit_log(aggregate_type, aggregate_id, created_at);

CREATE TABLE webhook_inbox (
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (source, source_event_id)
) STRICT;

CREATE TABLE rule_versions (
  version TEXT PRIMARY KEY,
  source_ref TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  retired_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

PRAGMA user_version = 1;
