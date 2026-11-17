import { loadWorkerConfig } from "../config.js";
import { WorkerApiClient } from "./client.js";
import { createRunner, preflightCodex } from "./codex-runner.js";
import { prepareWorkspace } from "./workspace.js";

const config = loadWorkerConfig();
const client = new WorkerApiClient(config);
const runner = createRunner(config);

try {
  const health = await client.health();
  if (!health.ok) {
    throw new Error("Control-plane health check returned ok=false");
  }
  await preflightCodex(config);
  console.info(
    JSON.stringify({
      level: "info",
      event: "worker_ready",
      workerId: config.workerId,
      mode: config.codexMode,
      codexFullAccess:
        config.codexMode === "codex"
          ? "danger-full-access, approvals never"
          : null,
      schemaVersion: health.schemaVersion,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker_preflight_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processOne(): Promise<boolean> {
  const claimed = await client.claim();
  if (!claimed) {
    return false;
  }
  let heartbeat: NodeJS.Timeout | null = null;
  try {
    const context = await client.context(claimed.runToken, claimed.runId);
    const workspace = await prepareWorkspace(config.workspaceRoot, context);
    heartbeat = setInterval(() => {
      void client
        .heartbeat(claimed.runToken, claimed.runId)
        .catch((error) =>
          console.error(
            JSON.stringify({
              level: "error",
              event: "heartbeat_failed",
              runId: claimed.runId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    }, 30_000);
    heartbeat.unref();
    const output = await runner.run(context, workspace);
    await client.submitResult(
      claimed.runToken,
      claimed.runId,
      output.result,
      output.threadId,
    );
    console.info(
      JSON.stringify({
        level: "info",
        event: "run_completed",
        runId: claimed.runId,
        taskId: claimed.taskId,
        mode: config.codexMode,
        codexFullAccess:
          config.codexMode === "codex"
            ? "danger-full-access, approvals never"
            : null,
        threadId: output.threadId,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.failRun(claimed.runToken, claimed.runId, message).catch(
      (reportError) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "run_failure_report_failed",
            runId: claimed.runId,
            error:
              reportError instanceof Error
                ? reportError.message
                : String(reportError),
          }),
        );
      },
    );
    throw error;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
  return true;
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

while (!stopping) {
  try {
    const worked = await processOne();
    if (!worked) {
      await sleep(config.pollMs);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "worker_loop_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await sleep(Math.max(config.pollMs, 1_000));
  }
}
