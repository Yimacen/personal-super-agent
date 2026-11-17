import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { WorkerConfig } from "../config.js";
import {
  CodexResultSchema,
  type CodexResult,
} from "../domain/codex-result.js";
import { sha256 } from "../lib/canonical.js";
import {
  readWorkspaceResult,
  type TaskWorkspace,
} from "./workspace.js";

export interface CodexRunOutput {
  result: CodexResult;
  threadId: string | null;
  transcript: string;
}

export interface CodexRunner {
  run(
    context: Record<string, unknown>,
    workspace: TaskWorkspace,
  ): Promise<CodexRunOutput>;
}

export class ScriptedCodexRunner implements CodexRunner {
  async run(
    context: Record<string, unknown>,
    _workspace: TaskWorkspace,
  ): Promise<CodexRunOutput> {
    const event = context.triggerEvent as {
      id: string;
      source: string;
      eventType: string;
      subjectKey: string;
      summary: string;
    };
    const accounts = context.authorizedAccounts as Array<{
      id: string;
      connectorId: string;
      accountRef: string;
      scopes: string[];
    }>;
    const finalization = context.finalization as
      | {
          verification?: {
            verified?: boolean;
            reasonCode?: string;
          } | null;
        }
      | null
      | undefined;
    let result: CodexResult;
    if (finalization) {
      const verified = finalization.verification?.verified === true;
      result = verified
        ? {
            kind: "complete",
            summary:
              "Independent verification passed and the final acceptance check completed.",
            acceptanceChecks: [
              {
                check: "Independent connector read-back verified the action",
                passed: true,
                evidence:
                  finalization.verification?.reasonCode ?? "verified",
              },
            ],
          }
        : {
            kind: "no_action",
            summary: "The action did not pass independent verification.",
            reason: "final_acceptance_failed",
          };
    } else if (event.eventType === "todo.update_requested") {
      const account = accounts.find(
        (item) =>
          item.connectorId === "memory" &&
          item.scopes.includes("todo.write"),
      );
      if (!account) {
        result = {
          kind: "needs_data",
          requests: [
            {
              sourceAccountId: "missing",
              capability: "todo.read",
              query: {},
              reason: "No authorized todo account is available",
            },
          ],
        };
      } else {
        const subject = event.subjectKey.replace(/^todo:/, "");
        const [listId = "inbox", itemId = "unknown"] = subject.split("/");
        result = {
          kind: "proposed_action",
          summary: `Mark todo ${itemId} as done`,
          action: {
            sourceAccountId: account.id,
            connectorId: "memory",
            capability: "todo.set_status",
            target: { listId, itemId },
            parameters: { status: "done" },
            sideEffects: [`Mark ${itemId} done in ${listId}`],
            evidenceRefs: [`event://${event.id}`],
            acceptanceChecks: ["Todo status reads back as done"],
          },
        };
      }
    } else if (event.eventType === "message.send_requested") {
      const account = accounts.find(
        (item) =>
          item.connectorId === "memory" &&
          item.scopes.includes("message.send"),
      );
      if (!account) {
        result = {
          kind: "needs_data",
          requests: [
            {
              sourceAccountId: "missing",
              capability: "message.send",
              query: {},
              reason: "No authorized message account is available",
            },
          ],
        };
      } else {
        result = {
          kind: "proposed_action",
          summary: event.summary,
          action: {
            sourceAccountId: account.id,
            connectorId: "memory",
            capability: "message.send",
            target: { account: "personal" },
            parameters: {
              to: ["recipient@example.com"],
              subject: "Personal assistant test",
              body: event.summary,
            },
            sideEffects: ["Send an external email"],
            evidenceRefs: [`event://${event.id}`],
            acceptanceChecks: ["A sent-message record exists"],
          },
        };
      }
    } else {
      result = {
        kind: "complete",
        summary: `Handled event: ${event.summary}`,
        acceptanceChecks: [
          {
            check: "Event was incorporated into the task",
            passed: true,
            evidence: event.id,
          },
        ],
      };
    }
    return {
      result,
      threadId: null,
      transcript: JSON.stringify({
        adapter: "scripted",
        eventType: event.eventType,
        summaryHash: sha256(event.summary),
      }),
    };
  }
}

export class CommandCodexRunner implements CodexRunner {
  constructor(private readonly config: WorkerConfig) {}

  async run(
    context: Record<string, unknown>,
    workspace: TaskWorkspace,
  ): Promise<CodexRunOutput> {
    const args = buildCodexExecArgs(this.config, workspace);
    const env = codexProcessEnv(this.config);
    const transcript = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.config.codexCommand, args, {
        cwd: workspace.root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Codex process exceeded the 10 minute limit"));
      }, 10 * 60_000);
      timeout.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-2_000_000);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-200_000);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(
              `Codex exited with ${code}: stdout=${stdout.slice(-2_000)} stderr=${stderr.slice(-2_000)}`,
            ),
          );
          return;
        }
        resolve(`${stdout}\n${stderr}`);
      });
    });
    await writeFile(
      `${workspace.root}/transcript.jsonl`,
      transcript,
      { mode: 0o600 },
    );
    const raw = await readWorkspaceResult(workspace);
    const result = CodexResultSchema.parse(
      normalizeCodexResult(raw, context),
    );
    const threadId =
      transcript
        .split("\n")
        .flatMap((line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            const candidate =
              event.thread_id ??
              event.threadId ??
              (event.thread as Record<string, unknown> | undefined)?.id;
            return typeof candidate === "string" ? [candidate] : [];
          } catch {
            return [];
          }
        })
        .at(0) ?? null;
    return { result, threadId, transcript: transcript.slice(-2_000_000) };
  }
}

export function normalizeCodexResult(
  raw: unknown,
  context?: Record<string, unknown>,
): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const input = raw as Record<string, unknown>;
  const pick = (keys: string[]): Record<string, unknown> =>
    Object.fromEntries(
      keys
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, input[key]]),
    );
  switch (input.kind) {
    case "complete": {
      const result = pick(["kind", "summary", "acceptanceChecks"]);
      addTaskSummary(result, context);
      return result;
    }
    case "needs_data":
      return pick(["kind", "requests"]);
    case "proposed_action": {
      const result = pick(["kind", "summary", "action"]);
      addTaskSummary(result, context);
      return result;
    }
    case "no_action": {
      const result = pick(["kind", "summary", "reason"]);
      addTaskSummary(result, context);
      return result;
    }
    default:
      return input;
  }
}

function addTaskSummary(
  result: Record<string, unknown>,
  context?: Record<string, unknown>,
): void {
  if (typeof result.summary === "string" && result.summary.trim()) {
    return;
  }
  const task = context?.task;
  if (task && typeof task === "object" && "goal" in task) {
    const goal = (task as { goal?: unknown }).goal;
    if (typeof goal === "string" && goal.trim()) {
      result.summary = goal;
    }
  }
}

export function createRunner(
  config: WorkerConfig,
): CodexRunner {
  return config.codexMode === "codex"
    ? new CommandCodexRunner(config)
    : new ScriptedCodexRunner();
}

export function buildCodexExecArgs(
  config: WorkerConfig,
  workspace: TaskWorkspace,
): string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "-C",
    workspace.root,
    "--output-last-message",
    workspace.resultPath,
  ];
  if (config.codexModel) {
    args.push("--model", config.codexModel);
  }
  args.push(workspace.prompt);
  return args;
}

export async function preflightCodex(config: WorkerConfig): Promise<void> {
  if (config.codexMode !== "codex") {
    return;
  }
  const env = codexProcessEnv(config);
  try {
    const version = await promisify(execFile)(
      config.codexCommand,
      ["--version"],
      {
        env,
        timeout: 10_000,
      },
    );
    const help = await promisify(execFile)(
      config.codexCommand,
      ["exec", "--help"],
      {
        env,
        timeout: 10_000,
      },
    );
    if (!help.stdout.includes("--dangerously-bypass-approvals-and-sandbox")) {
      throw new Error("Codex CLI does not support full-access execution");
    }
    if (!version.stdout.trim()) {
      throw new Error("Codex CLI version check returned no output");
    }
  } catch (error) {
    throw new Error(
      `Codex CLI is not ready: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function codexProcessEnv(config: WorkerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    ...config.codexEnvAllowlist,
  ]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.GIT_CEILING_DIRECTORIES = dirname(config.workspaceRoot);
  return env;
}
