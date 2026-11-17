import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { CodexResultSchema } from "../src/domain/codex-result.js";

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
