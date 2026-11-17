import type {
  WorkerConfig,
} from "../config.js";

export interface ClaimedJob {
  jobId: string;
  runId: string;
  taskId: string;
  leaseUntil: string;
  runToken: string;
}

export class WorkerApiClient {
  constructor(private readonly config: WorkerConfig) {}

  async health(): Promise<{ ok: boolean; schemaVersion: number }> {
    const response = await fetch(`${this.config.apiBaseUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        `Control-plane health check failed (${response.status})`,
      );
    }
    return (await response.json()) as { ok: boolean; schemaVersion: number };
  }

  async claim(): Promise<ClaimedJob | null> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/internal/jobs/claim`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workerId: this.config.workerId,
          leaseSeconds: 180,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 204) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `Claim failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json()) as ClaimedJob;
  }

  async heartbeat(runToken: string, runId: string): Promise<void> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/internal/runs/${encodeURIComponent(runId)}/heartbeat`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${runToken}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Heartbeat failed (${response.status}): ${await response.text()}`,
      );
    }
  }

  async context(
    runToken: string,
    runId: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/internal/runs/${encodeURIComponent(runId)}/context`,
      {
        headers: {
          authorization: `Bearer ${runToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Context request failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async submitResult(
    runToken: string,
    runId: string,
    result: unknown,
    codexThreadId?: string | null,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${runToken}`,
      "content-type": "application/json",
    };
    if (codexThreadId) {
      headers["x-codex-thread-id"] = codexThreadId;
    }
    const response = await fetch(
      `${this.config.apiBaseUrl}/internal/runs/${encodeURIComponent(runId)}/result`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Result submission failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async failRun(
    runToken: string,
    runId: string,
    error: string,
  ): Promise<void> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/internal/runs/${encodeURIComponent(runId)}/fail`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${runToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ error }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failure report failed (${response.status}): ${await response.text()}`,
      );
    }
  }
}
