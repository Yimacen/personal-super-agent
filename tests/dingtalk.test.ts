import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DingTalkBridgeConfig } from "../src/config.js";
import { DingTalkCardBridge } from "../src/dingtalk/bridge.js";
import type { DingTalkCallbackClient } from "../src/dingtalk/bridge.js";
import {
  DingTalkDwsClient,
  DingTalkNotifier,
} from "../src/dingtalk/dws.js";
import {
  claimWorker,
  createHarness,
  ingest,
  runFinalCheck,
  runScriptedWorker,
} from "./helpers.js";

const fakeDws = join(process.cwd(), "tests/fixtures/fake-dws.mjs");
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

async function commandLog(path: string): Promise<string[][]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

test("DingTalk approval card sends, rejects the wrong operator, approves once, and updates the card", async (t) => {
  const logDirectory = await mkdtemp(join(tmpdir(), "dingtalk-bridge-"));
  const logPath = join(logDirectory, "dws.log");
  t.after(async () => {
    await rm(logDirectory, { recursive: true, force: true });
  });
  const notifier = new DingTalkNotifier({
    command: fakeDws,
    catalogUrl:
      "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json",
    approverOpenId: "open-owner",
    env: { FAKE_DWS_LOG: logPath },
  });
  const harness = await createHarness(t, {}, notifier);
  await ingest(harness, {
    source: "message",
    eventType: "message.send_requested",
    subjectKey: "message:thread/dingtalk",
    idempotencyKey: "message:dingtalk:1",
    summary: "Send a DingTalk-approved message",
  });
  await harness.server.scheduler.tick();
  const claimed = await claimWorker(harness);
  assert.ok(claimed);
  await runScriptedWorker(harness, claimed);
  await harness.server.scheduler.tick();

  const approval = harness.store.db
    .prepare(
      `SELECT approval.*, action.action_digest
       FROM approval_requests approval
       JOIN actions action ON action.id = approval.action_id
       WHERE action.task_id = ?`,
    )
    .get(claimed.taskId) as {
    id: string;
    action_digest: string;
    status: string;
  };
  assert.equal(approval.status, "pending");
  const sentCommands = await commandLog(logPath);
  const sendCommand = sentCommands.find(
    (args) =>
      args[0] === "chat" &&
      args[1] === "message" &&
      args[2] === "send-a2ui-card",
  );
  assert.ok(sendCommand);
  const sentContent = sendCommand[sendCommand.indexOf("--content") + 1];
  assert.ok(sentContent);
  assert.match(sentContent, new RegExp(approval.id));
  assert.match(sentContent, new RegExp(approval.action_digest));

  const dws = new DingTalkDwsClient({
    command: fakeDws,
    catalogUrl:
      "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json",
    approverOpenId: "open-owner",
    env: { FAKE_DWS_LOG: logPath },
  });
  const callback: DingTalkCallbackClient = {
    async decide(input) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dingtalk/callback",
        headers: {
          authorization: `Bearer ${harness.config.dingtalkBridgeToken}`,
        },
        payload: input,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    },
  };
  const bridgeConfig: DingTalkBridgeConfig = {
    apiBaseUrl: "http://127.0.0.1:4310",
    bridgeToken: harness.config.dingtalkBridgeToken!,
    dwsCommand: fakeDws,
    expectedOpenId: "open-owner",
    expectedUid: "10001",
    approverRef: "owner",
    listenerDuration: "1m",
    restartDelayMs: 10,
  };
  const bridge = new DingTalkCardBridge(
    bridgeConfig,
    dws,
    callback,
    silentLogger,
  );
  const surfaceId = `approval-${approval.id}`;
  const rawEvent = {
    event_id: "dingtalk-event-1",
    payload: {
      body: {
        bizInfoDTO: { bizId: "biz-from-event" },
        operatorDTO: { uid: 99999 },
        a2uiEvent: {
          action: {
            name: "approval_decision",
            sourceComponentId: "approve",
            context: {
              decision: "approve",
              approvalId: approval.id,
              actionDigest: approval.action_digest,
              surfaceId,
            },
          },
        },
      },
    },
  };
  await assert.rejects(() => bridge.handleEvent(rawEvent), /approver mismatch/);
  const stillPending = harness.store.db
    .prepare(`SELECT status FROM approval_requests WHERE id = ?`)
    .get(approval.id) as { status: string };
  assert.equal(stillPending.status, "pending");

  rawEvent.payload.body.operatorDTO.uid = 10001;
  const decision = await bridge.handleEvent(rawEvent);
  assert.equal(decision.state, "approved");
  await harness.server.scheduler.tick();
  assert.equal(
    harness.server.control.getTask(claimed.taskId).state,
    "verifying",
  );
  await runFinalCheck(harness);
  assert.equal(harness.server.control.getTask(claimed.taskId).state, "completed");
  assert.equal(harness.connector.getSentMessages().size, 1);

  const bySource = harness.store.db
    .prepare(
      `SELECT source, source_event_id FROM webhook_inbox
       WHERE source_event_id = 'dingtalk-event-1'`,
    )
    .get() as { source: string; source_event_id: string };
  assert.equal(bySource.source, "dingtalk");

  const updatedCommands = await commandLog(logPath);
  const updateCommand = updatedCommands.find(
    (args) =>
      args[0] === "chat" &&
      args[1] === "message" &&
      args[2] === "update-a2ui-card",
  );
  assert.ok(updateCommand);
  assert.equal(updateCommand[updateCommand.indexOf("--biz-id") + 1], "biz-from-event");
  assert.match(
    updateCommand[updateCommand.indexOf("--content") + 1] ?? "",
    /已批准/,
  );

  const replay = await bridge.handleEvent(rawEvent);
  assert.equal(replay.duplicate, true);
  assert.equal(
    (
      harness.store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM execution_receipts
           WHERE lease_id IN (
             SELECT id FROM execution_leases
             WHERE action_id = (SELECT action_id FROM approval_requests WHERE id = ?)
           )`,
        )
        .get(approval.id) as { count: number }
    ).count,
    1,
  );
});

test("DingTalk callback endpoint rejects missing bridge authentication", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/dingtalk/callback",
    payload: {
      eventId: "missing-auth",
      approvalId: "approval_missing",
      actionDigest: "a".repeat(64),
      operatorRef: "owner",
      decision: "approve",
      timestamp: Math.floor(Date.now() / 1_000),
    },
  });
  assert.equal(response.statusCode, 401);
});
