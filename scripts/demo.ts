import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/app/server.js";
import type { AppConfig } from "../src/config.js";
import { MemoryConnector } from "../src/connectors/memory.js";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { migrateDatabase } from "../src/db/database.js";
import { FeishuNotifier } from "../src/notifications/feishu.js";
import { ScriptedCodexRunner } from "../src/worker/codex-runner.js";
import { prepareWorkspace } from "../src/worker/workspace.js";

const directory = await mkdtemp(join(tmpdir(), "personal-super-agent-demo-"));
const store = migrateDatabase(join(directory, "assistant.db"));
const connector = new MemoryConnector();
connector.seedTodo("inbox", "demo-item", "open");
const config: AppConfig = {
  host: "127.0.0.1",
  port: 4310,
  databasePath: store.path,
  workspaceRoot: join(directory, "workspaces"),
  backupDir: join(directory, "backups"),
  internalApiToken: "demo-internal-token-at-least-24-chars",
  approvalChannel: "feishu",
  feishuWebhookUrl: null,
  feishuSigningSecret: "demo-feishu-signing-secret",
  dingtalkDwsCommand: "dws",
  dingtalkApproverOpenId: null,
  dingtalkApproverUid: null,
  dingtalkBridgeToken: "demo-dingtalk-bridge-token-123456",
  dingtalkCatalogUrl:
    "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json",
  approverRef: "owner",
  controlJobPollMs: 250,
};
const server = await buildServer({
  store,
  config,
  connectors: new ConnectorRegistry([connector]),
  notifier: new FeishuNotifier(null, null),
  logger: {
    info() {},
    warn() {},
    error() {},
  },
  startScheduler: false,
});

try {
  server.control.ingestEvent({
    source: "todo",
    eventType: "todo.update_requested",
    subjectKey: "todo:inbox/demo-item",
    idempotencyKey: "demo:1",
    occurredAt: new Date().toISOString(),
    summary: "Complete the demo todo",
    sensitivity: "private",
  });
  await server.scheduler.tick();

  const initial = server.control.claimWorkerJob("demo-worker", 120);
  if (!initial) {
    throw new Error("Expected the worker job to be claimable");
  }
  const context = server.control.getRunContext(initial.runToken);
  const workspace = await prepareWorkspace(config.workspaceRoot, context);
  const run = await new ScriptedCodexRunner().run(context, workspace);
  await server.control.submitWorkerResult(initial.runToken, run.result);
  await server.scheduler.tick();

  const final = server.control.claimWorkerJob("demo-worker", 120);
  if (!final) {
    throw new Error("Expected the final-check job to be claimable");
  }
  const finalContext = server.control.getRunContext(final.runToken);
  const finalWorkspace = await prepareWorkspace(
    config.workspaceRoot,
    finalContext,
  );
  const finalRun = await new ScriptedCodexRunner().run(
    finalContext,
    finalWorkspace,
  );
  await server.control.submitWorkerResult(final.runToken, finalRun.result);
  await server.scheduler.tick();

  const timeline = server.control.getTimeline(initial.taskId);
  process.stdout.write(
    `${JSON.stringify(
      {
        taskState: (timeline.task as { state: string }).state,
        todoStatus: connector.getTodoStatus("inbox", "demo-item"),
        timeline,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await server.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
