import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "../src/lib/canonical.js";
import {
  claimWorker,
  createHarness,
  ingest,
  runFinalCheck,
  runScriptedWorker,
} from "./helpers.js";

test("schema migration enables STRICT tables, foreign keys, WAL, and integrity", async (t) => {
  const harness = await createHarness(t);
  assert.equal(harness.store.userVersion(), 1);
  assert.equal(harness.store.integrityCheck(), "ok");
  assert.equal(harness.store.db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(
    (
      harness.store.db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
        )
        .get() as { sql: string }
    ).sql.includes("STRICT"),
    true,
  );
  assert.equal(
    harness.store.db.pragma("journal_mode", { simple: true }),
    "wal",
  );
});

test("replayed events create one task and one worker job", async (t) => {
  const harness = await createHarness(t);
  const payload = {
    source: "todo",
    eventType: "todo.update_requested",
    subjectKey: "todo:inbox/replay-item",
    idempotencyKey: "todo:replay:1",
    occurredAt: new Date().toISOString(),
    summary: "Replay-safe todo",
    sensitivity: "private",
  };
  const responses = await Promise.all(
    Array.from({ length: 25 }, () =>
      harness.app.inject({
        method: "POST",
        url: "/api/events",
        payload,
      }),
    ),
  );
  assert.equal(responses.every((response) => response.statusCode < 300), true);
  assert.equal(
    (
      harness.store.db
        .prepare(`SELECT COUNT(*) AS count FROM events`)
        .get() as { count: number }
    ).count,
    1,
  );
  await harness.server.scheduler.tick();
  assert.equal(
    (
      harness.store.db
        .prepare(`SELECT COUNT(*) AS count FROM tasks`)
        .get() as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      harness.store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM jobs WHERE kind = 'run_codex_task'`,
        )
        .get() as { count: number }
    ).count,
    1,
  );
});

test("concurrent worker claims receive distinct jobs", async (t) => {
  const harness = await createHarness(t);
  for (const suffix of ["a", "b"]) {
    await ingest(harness, {
      subjectKey: `todo:inbox/concurrent-${suffix}`,
      idempotencyKey: `todo:concurrent:${suffix}`,
      summary: `Concurrent ${suffix}`,
    });
  }
  await harness.server.scheduler.tick();
  const [first, second] = await Promise.all([
    claimWorker(harness),
    claimWorker(harness),
  ]);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.jobId, second.jobId);
  assert.notEqual(first.runId, second.runId);
});

test("worker endpoints require a control token and Run tokens are route-bound", async (t) => {
  const harness = await createHarness(t);
  const noControlToken = await harness.app.inject({
    method: "POST",
    url: "/internal/jobs/claim",
    payload: { workerId: "attacker" },
  });
  assert.equal(noControlToken.statusCode, 401);

  await ingest(harness, {
    subjectKey: "todo:inbox/token-bound",
    idempotencyKey: "todo:token:1",
    summary: "Token-bound task",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  const mismatch = await harness.app.inject({
    method: "POST",
    url: "/internal/runs/run_wrong/result",
    headers: { authorization: `Bearer ${claimed.runToken}` },
    payload: {
      kind: "complete",
      summary: "should not be accepted",
      acceptanceChecks: [],
    },
  });
  assert.equal(mismatch.statusCode, 401);
  const task = harness.server.control.getTask(claimed.taskId);
  assert.equal(task.state, "planning");
  assert.equal(
    (
      harness.store.db
        .prepare(`SELECT COUNT(*) AS count FROM actions WHERE task_id = ?`)
        .get(claimed.taskId) as { count: number }
    ).count,
    0,
  );
});

test("an expired worker lease creates a fresh scoped run and revokes the old token", async (t) => {
  const harness = await createHarness(t);
  harness.connector.seedTodo("inbox", "recovered", "open");
  await ingest(harness, {
    subjectKey: "todo:inbox/recovered",
    idempotencyKey: "todo:recover:1",
    summary: "Recover after worker crash",
  });
  await harness.server.scheduler.tick();
  const abandoned = await claimWorker(harness);
  assert.ok(abandoned);
  harness.store.db
    .prepare(
      `UPDATE jobs SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
    )
    .run(abandoned.jobId);
  assert.equal(harness.server.control.recoverExpiredLeases(), 1);

  const staleContext = await harness.app.inject({
    method: "GET",
    url: `/internal/runs/${abandoned.runId}/context`,
    headers: { authorization: `Bearer ${abandoned.runToken}` },
  });
  assert.equal(staleContext.statusCode, 401);

  const recovered = await claimWorker(harness);
  assert.ok(recovered);
  assert.notEqual(recovered.runId, abandoned.runId);
  await runScriptedWorker(harness, recovered);
  await runFinalCheck(harness);
  assert.equal(harness.server.control.getTask(recovered.taskId).state, "completed");
  assert.equal(harness.connector.getTodoStatus("inbox", "recovered"), "done");
});

test("worker execution failures are persisted immediately", async (t) => {
  const harness = await createHarness(t);
  await ingest(harness, {
    subjectKey: "todo:inbox/failing-run",
    idempotencyKey: "todo:failure:1",
    summary: "Fail this run",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  const response = await harness.app.inject({
    method: "POST",
    url: `/internal/runs/${claimed.runId}/fail`,
    headers: { authorization: `Bearer ${claimed.runToken}` },
    payload: { error: "codex_exec_failed" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(harness.server.control.getTask(claimed.taskId).state, "failed");
  const job = harness.store.db
    .prepare(`SELECT status,last_error FROM jobs WHERE id = ?`)
    .get(claimed.jobId) as { status: string; last_error: string };
  assert.deepEqual(job, {
    status: "failed",
    last_error: "codex_exec_failed",
  });
});

test("worker result persists the Codex thread id", async (t) => {
  const harness = await createHarness(t);
  await ingest(harness, {
    subjectKey: "todo:inbox/thread-persist",
    idempotencyKey: "todo:thread:1",
    summary: "Persist Codex thread",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  const response = await harness.app.inject({
    method: "POST",
    url: `/internal/runs/${claimed.runId}/result`,
    headers: {
      authorization: `Bearer ${claimed.runToken}`,
      "x-codex-thread-id": "thread_test_123",
    },
    payload: {
      kind: "complete",
      summary: "completed",
      acceptanceChecks: [],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const run = harness.store.db
    .prepare(`SELECT codex_thread_id FROM agent_runs WHERE id = ?`)
    .get(claimed.runId) as { codex_thread_id: string };
  assert.equal(run.codex_thread_id, "thread_test_123");
});

test("reversible private write executes once and completes after read-back verification", async (t) => {
  const harness = await createHarness(t);
  harness.connector.seedTodo("inbox", "item-automatic", "open");
  await ingest(harness, {
    subjectKey: "todo:inbox/item-automatic",
    idempotencyKey: "todo:auto:1",
    summary: "Finish automatic item",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  const context = await harness.app.inject({
    method: "GET",
    url: `/internal/runs/${claimed.runId}/context`,
    headers: { authorization: `Bearer ${claimed.runToken}` },
  });
  assert.deepEqual(
    context.json().authorizedAccounts.map(
      (account: { accountRef: string }) => account.accountRef,
    ),
    ["todo"],
  );
  assert.deepEqual(
    context.json().authorizedAccounts[0].capabilities[0].targetSchema.required,
    ["listId", "itemId"],
  );
  await runScriptedWorker(harness, claimed);
  await runFinalCheck(harness);

  const task = harness.server.control.getTask(claimed.taskId);
  assert.equal(task.state, "completed");
  assert.equal(harness.connector.getTodoStatus("inbox", "item-automatic"), "done");
  const action = harness.store.db
    .prepare(`SELECT * FROM actions WHERE task_id = ?`)
    .get(claimed.taskId) as {
    action_digest: string;
    state: string;
  };
  assert.equal(action.state, "verified");
  assert.equal(
    harness.connector.getExecuteCount(action.action_digest),
    1,
  );
  const counts = harness.store.db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM execution_receipts r
          JOIN execution_leases l ON l.id = r.lease_id
          JOIN actions a ON a.id = l.action_id WHERE a.task_id = ?) AS receipts,
        (SELECT COUNT(*) FROM verifications v JOIN actions a ON a.id = v.action_id
          WHERE a.task_id = ?) AS verifications`,
    )
    .get(claimed.taskId, claimed.taskId) as {
    receipts: number;
    verifications: number;
  };
  assert.deepEqual(counts, { receipts: 1, verifications: 1 });
});

test("external write waits for a digest-bound signed approval and executes once", async (t) => {
  const harness = await createHarness(t);
  await ingest(harness, {
    source: "message",
    eventType: "message.send_requested",
    subjectKey: "message:thread/abc",
    idempotencyKey: "message:approval:1",
    summary: "Send the prepared update",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  const context = await harness.app.inject({
    method: "GET",
    url: `/internal/runs/${claimed.runId}/context`,
    headers: { authorization: `Bearer ${claimed.runToken}` },
  });
  assert.deepEqual(
    context.json().authorizedAccounts.map(
      (account: { accountRef: string }) => account.accountRef,
    ),
    ["message"],
  );
  await runScriptedWorker(harness, claimed);
  await harness.server.scheduler.tick();

  assert.equal(harness.server.control.getTask(claimed.taskId).state, "waiting_approval");
  const approval = harness.store.db
    .prepare(
      `SELECT a.* FROM approval_requests a
       JOIN actions act ON act.id = a.action_id
       WHERE act.task_id = ?`,
    )
    .get(claimed.taskId) as {
    id: string;
    action_digest: string;
    status: string;
  };
  assert.equal(approval.status, "pending");

  const timestamp = Math.floor(Date.now() / 1_000);
  const callback = {
    eventId: "feishu_event_approval_1",
    approvalId: approval.id,
    actionDigest: approval.action_digest,
    operatorRef: "owner",
    decision: "approve",
    timestamp,
  };
  const signature = createHmac("sha256", harness.config.feishuSigningSecret!)
    .update(`${timestamp}.${canonicalJson(callback)}`)
    .digest("hex");
  const approved = await harness.app.inject({
    method: "POST",
    url: "/api/feishu/callback",
    headers: { "x-feishu-signature": signature },
    payload: callback,
  });
  assert.equal(approved.statusCode, 200, approved.body);

  const replay = await harness.app.inject({
    method: "POST",
    url: "/api/feishu/callback",
    headers: { "x-feishu-signature": signature },
    payload: callback,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().duplicate, true);

  await harness.server.scheduler.tick();
  assert.equal(harness.server.control.getTask(claimed.taskId).state, "verifying");
  await runFinalCheck(harness);
  assert.equal(harness.server.control.getTask(claimed.taskId).state, "completed");
  assert.equal(harness.connector.getSentMessages().size, 1);
  assert.equal(
    (
      harness.store.db
        .prepare(`SELECT COUNT(*) AS count FROM execution_receipts`)
        .get() as { count: number }
    ).count,
    1,
  );
});

test("a signed approval for a different digest is rejected without changing state", async (t) => {
  const harness = await createHarness(t);
  await ingest(harness, {
    source: "message",
    eventType: "message.send_requested",
    subjectKey: "message:thread/digest",
    idempotencyKey: "message:digest:1",
    summary: "Digest-bound message",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  await runScriptedWorker(harness, claimed);
  await harness.server.scheduler.tick();
  const approval = harness.store.db
    .prepare(
      `SELECT a.* FROM approval_requests a
       JOIN actions act ON act.id = a.action_id WHERE act.task_id = ?`,
    )
    .get(claimed.taskId) as { id: string; action_digest: string };

  const timestamp = Math.floor(Date.now() / 1_000);
  const callback = {
    eventId: "feishu_wrong_digest",
    approvalId: approval.id,
    actionDigest: "b".repeat(64),
    operatorRef: "owner",
    decision: "approve",
    timestamp,
  };
  const signature = createHmac("sha256", harness.config.feishuSigningSecret!)
    .update(`${timestamp}.${canonicalJson(callback)}`)
    .digest("hex");
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/feishu/callback",
    headers: { "x-feishu-signature": signature },
    payload: callback,
  });
  assert.equal(response.statusCode, 409, response.body);
  const current = harness.store.db
    .prepare(`SELECT status FROM approval_requests WHERE id = ?`)
    .get(approval.id) as { status: string };
  assert.equal(current.status, "pending");
});

test("an unknown connector outcome reconciles by read-back instead of retrying the write", async (t) => {
  const harness = await createHarness(t, { failAfterWrite: true });
  harness.connector.seedTodo("inbox", "uncertain-item", "open");
  await ingest(harness, {
    subjectKey: "todo:inbox/uncertain-item",
    idempotencyKey: "todo:uncertain:1",
    summary: "Write then lose the receipt",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  await runScriptedWorker(harness, claimed);
  await runFinalCheck(harness);

  const action = harness.store.db
    .prepare(`SELECT * FROM actions WHERE task_id = ?`)
    .get(claimed.taskId) as {
    id: string;
    action_digest: string;
    state: string;
  };
  const receipt = harness.store.db
    .prepare(
      `SELECT r.outcome FROM execution_receipts r
       JOIN execution_leases l ON l.id = r.lease_id
       WHERE l.action_id = ?`,
    )
    .get(action.id) as { outcome: string };
  assert.equal(receipt.outcome, "uncertain");
  assert.equal(action.state, "verified");
  assert.equal(harness.connector.getExecuteCount(action.action_digest), 1);
  assert.equal(harness.server.control.getTask(claimed.taskId).state, "completed");
});

test("kill switch denies proposed writes and the approval digest is mandatory", async (t) => {
  const harness = await createHarness(t);
  await harness.app.inject({
    method: "PUT",
    url: "/api/kill-switch",
    payload: { enabled: true },
  });
  await ingest(harness, {
    idempotencyKey: "todo:kill:1",
    summary: "Must not write",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  const result = await runScriptedWorker(harness, claimed);
  const actionResult = result.action as {
    state: string;
    actionDigest: string;
  };
  assert.equal(actionResult.state, "denied");
  assert.equal(
    harness.connector.getExecuteCount(actionResult.actionDigest),
    0,
  );

  const wrongSignature = await harness.app.inject({
    method: "POST",
    url: "/api/feishu/callback",
    headers: { "x-feishu-signature": "00" },
    payload: {
      eventId: "invalid",
      approvalId: "approval_missing",
      actionDigest: "a".repeat(64),
      operatorRef: "owner",
      decision: "approve",
      timestamp: Math.floor(Date.now() / 1_000),
    },
  });
  assert.equal(wrongSignature.statusCode, 401);
});
