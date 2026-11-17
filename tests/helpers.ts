import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer, type BuiltServer } from "../src/app/server.js";
import type { AppConfig } from "../src/config.js";
import {
  MemoryConnector,
  type MemoryConnectorOptions,
} from "../src/connectors/memory.js";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { migrateDatabase, type Store } from "../src/db/database.js";
import type { CodexResult } from "../src/domain/codex-result.js";
import { FeishuNotifier } from "../src/notifications/feishu.js";
import { prepareWorkspace } from "../src/worker/workspace.js";
import {
  ScriptedCodexRunner,
} from "../src/worker/codex-runner.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

export interface Harness {
  app: FastifyInstance;
  server: BuiltServer;
  store: Store;
  connector: MemoryConnector;
  config: AppConfig;
  directory: string;
}

export async function createHarness(
  t: TestContext,
  connectorOptions: MemoryConnectorOptions = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "personal-super-agent-"));
  const store = migrateDatabase(join(directory, "assistant.db"));
  const connector = new MemoryConnector(connectorOptions);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 4310,
    databasePath: store.path,
    workspaceRoot: join(directory, "workspaces"),
    backupDir: join(directory, "backups"),
    internalApiToken: "test-internal-token-at-least-24-chars",
    feishuWebhookUrl: null,
    feishuSigningSecret: "test-feishu-signing-secret",
    approverRef: "owner",
    controlJobPollMs: 10,
  };
  const server = await buildServer({
    store,
    config,
    connectors: new ConnectorRegistry([connector]),
    notifier: new FeishuNotifier(null, null),
    logger: silentLogger,
    startScheduler: false,
  });
  t.after(async () => {
    await server.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app: server.app,
    server,
    store,
    connector,
    config,
    directory,
  };
}

export async function ingest(
  harness: Harness,
  overrides: Record<string, unknown> = {},
) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/events",
    payload: {
      source: "todo",
      eventType: "todo.update_requested",
      subjectKey: "todo:inbox/item-1",
      idempotencyKey: `todo:inbox:item-1:${Date.now()}`,
      occurredAt: new Date().toISOString(),
      summary: "Mark item-1 as done",
      sensitivity: "private",
      ...overrides,
    },
  });
  return response;
}

export async function claimWorker(harness: Harness) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/internal/jobs/claim",
    headers: {
      authorization: `Bearer ${harness.config.internalApiToken}`,
    },
    payload: { workerId: "test-worker", leaseSeconds: 120 },
  });
  if (response.statusCode === 204) {
    return null;
  }
  if (response.statusCode !== 200) {
    throw new Error(`Claim failed: ${response.statusCode} ${response.body}`);
  }
  return response.json() as {
    jobId: string;
    runId: string;
    taskId: string;
    leaseUntil: string;
    runToken: string;
  };
}

export async function runScriptedWorker(
  harness: Harness,
  claimed: NonNullable<Awaited<ReturnType<typeof claimWorker>>>,
  override?: CodexResult,
): Promise<Record<string, unknown>> {
  const contextResponse = await harness.app.inject({
    method: "GET",
    url: `/internal/runs/${claimed.runId}/context`,
    headers: { authorization: `Bearer ${claimed.runToken}` },
  });
  if (contextResponse.statusCode !== 200) {
    throw new Error(
      `Context failed: ${contextResponse.statusCode} ${contextResponse.body}`,
    );
  }
  const context = contextResponse.json() as Record<string, unknown>;
  const workspace = await prepareWorkspace(harness.config.workspaceRoot, context);
  const output = override
    ? { result: override, threadId: null, transcript: "" }
    : await new ScriptedCodexRunner().run(context, workspace);
  const response = await harness.app.inject({
    method: "POST",
    url: `/internal/runs/${claimed.runId}/result`,
    headers: { authorization: `Bearer ${claimed.runToken}` },
    payload: output.result,
  });
  if (response.statusCode !== 200) {
    throw new Error(
      `Result failed: ${response.statusCode} ${response.body}`,
    );
  }
  return response.json() as Record<string, unknown>;
}

export async function runFinalCheck(harness: Harness): Promise<void> {
  await harness.server.scheduler.tick();
  const finalClaim = await claimWorker(harness);
  if (!finalClaim) {
    throw new Error("Expected a final-check worker job");
  }
  await runScriptedWorker(harness, finalClaim);
  await harness.server.scheduler.tick();
}
