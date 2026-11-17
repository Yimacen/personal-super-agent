import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { CodexResultSchema } from "../src/domain/codex-result.js";
import type { WorkerConfig } from "../src/config.js";
import {
  buildCodexExecArgs,
  normalizeCodexResult,
} from "../src/worker/codex-runner.js";
import { parseWorkspaceResultText } from "../src/worker/workspace.js";

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(path)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

test("domain layer is independent of HTTP, SQLite, connectors, and Feishu", async () => {
  for (const file of await filesUnder(join(process.cwd(), "src/domain"))) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'](?:fastify|better-sqlite3|\.\.\/db|\.\.\/connectors|\.\.\/notifications)/,
      relative(process.cwd(), file),
    );
  }
});

test("worker layer has no database, policy, approval, or Feishu imports", async () => {
  for (const file of await filesUnder(join(process.cwd(), "src/worker"))) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'](?:better-sqlite3|\.\.\/db|\.\.\/domain\/policy|\.\.\/notifications)|authorizeAction|issueLease|decideApproval/,
      relative(process.cwd(), file),
    );
  }
});

test("Codex output is strict and rejects unknown fields", () => {
  assert.equal(
    CodexResultSchema.safeParse({
      kind: "complete",
      summary: "done",
      acceptanceChecks: [],
      injected: "ignored",
    }).success,
    false,
  );
  assert.equal(
    CodexResultSchema.safeParse({
      kind: "no_action",
      summary: "nothing needed",
      reason: "no candidate",
    }).success,
    true,
  );
});

test("Codex worker uses non-interactive full access without a login gate", () => {
  const config: WorkerConfig = {
    apiBaseUrl: "http://127.0.0.1:4310",
    internalApiToken: "test-internal-token",
    workerId: "test-worker",
    pollMs: 1_000,
    workspaceRoot: "/tmp/workspaces",
    codexMode: "codex",
    codexCommand: "codex",
    codexModel: null,
    codexEnvAllowlist: ["OPENAI_API_KEY"],
  };
  const args = buildCodexExecArgs(config, {
    root: "/tmp/workspaces/task_test",
    prompt: "execute task",
    outputSchemaPath: "/tmp/workspaces/task_test/output/schema.json",
    resultPath: "/tmp/workspaces/task_test/output/result.json",
  });
  assert.equal(args[0], "exec");
  assert.equal(
    args.includes("--dangerously-bypass-approvals-and-sandbox"),
    true,
  );
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(args.includes("workspace-write"), false);
  assert.equal(args.includes("--output-schema"), false);
  assert.equal(args.at(-1), "execute task");
});

test("Codex text output accepts raw or fenced JSON and keeps Zod validation", () => {
  const raw = parseWorkspaceResultText(
    '```json\n{"kind":"no_action","summary":"none","reason":"test"}\n```',
  );
  assert.equal(
    CodexResultSchema.safeParse(raw).success,
    true,
  );
});

test("Codex result normalization removes non-contract root fields", () => {
  const normalized = normalizeCodexResult({
    kind: "no_action",
    summary: "nothing",
    reason: "already done",
    acceptanceChecks: ["extra"],
  });
  assert.deepEqual(normalized, {
    kind: "no_action",
    summary: "nothing",
    reason: "already done",
  });
});

test("Codex result normalization fills a missing display summary from the task", () => {
  const normalized = normalizeCodexResult(
    {
      kind: "proposed_action",
      action: {
        sourceAccountId: "acct",
        connectorId: "memory",
        capability: "todo.set_status",
        target: { listId: "inbox", itemId: "item" },
        parameters: { status: "done" },
        sideEffects: [],
        evidenceRefs: [],
        acceptanceChecks: [],
      },
    },
    { task: { goal: "Complete the todo" } },
  ) as Record<string, unknown>;
  assert.equal(normalized.summary, "Complete the todo");
});
