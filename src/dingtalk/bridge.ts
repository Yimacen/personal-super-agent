import { spawn } from "node:child_process";
import type { DingTalkBridgeConfig } from "../config.js";
import type { ControlPlaneLogger } from "../services/control-plane.js";
import { parseDingTalkCardEvent } from "./events.js";
import type { DingTalkDwsClient } from "./dws.js";

export interface DingTalkCallbackClient {
  decide(input: {
    eventId: string;
    approvalId: string;
    actionDigest: string;
    operatorRef: string;
    decision: "approve" | "deny";
    timestamp: number;
  }): Promise<{
    accepted: boolean;
    duplicate: boolean;
    state: string;
  }>;
}

export class HttpDingTalkCallbackClient implements DingTalkCallbackClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly bridgeToken: string,
  ) {}

  async decide(input: {
    eventId: string;
    approvalId: string;
    actionDigest: string;
    operatorRef: string;
    decision: "approve" | "deny";
    timestamp: number;
  }): Promise<{
    accepted: boolean;
    duplicate: boolean;
    state: string;
  }> {
    const response = await fetch(
      `${this.apiBaseUrl}/api/dingtalk/callback`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.bridgeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `DingTalk callback failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json()) as {
      accepted: boolean;
      duplicate: boolean;
      state: string;
    };
  }
}

export class DingTalkCardBridge {
  private expectedOpenId: string | null;
  private expectedUid: string | null;
  private stopping = false;
  private activeChild: ReturnType<typeof spawn> | null = null;

  constructor(
    private readonly config: DingTalkBridgeConfig,
    private readonly dws: DingTalkDwsClient,
    private readonly callback: DingTalkCallbackClient,
    private readonly logger: ControlPlaneLogger,
  ) {
    this.expectedOpenId = config.expectedOpenId;
    this.expectedUid = config.expectedUid;
  }

  async initialize(): Promise<void> {
    const status = await this.dws.authStatus();
    if (!status.authenticated || !status.token_valid) {
      throw new Error(
        "DingTalk dws is not authenticated. Run: dws auth login --device",
      );
    }
    const identity = await this.dws.selfIdentity();
    this.expectedOpenId ??= identity.openDingTalkId;
    this.expectedUid ??= identity.uid;
    this.logger.info(
      { event: "dingtalk_bridge_ready" },
      "DingTalk card bridge is ready",
    );
  }

  async handleEvent(raw: unknown): Promise<{
    accepted: boolean;
    duplicate: boolean;
    state: string;
  }> {
    const action = parseDingTalkCardEvent(raw);
    const operatorMatches =
      (this.expectedUid !== null &&
        action.operatorUid === this.expectedUid) ||
      (this.expectedOpenId !== null &&
        action.operatorOpenId === this.expectedOpenId);
    if (!operatorMatches) {
      throw new Error(
        `DingTalk approver mismatch: uid=${action.operatorUid ?? ""} openId=${action.operatorOpenId ?? ""}`,
      );
    }
    const decision = await this.callback.decide({
      eventId: action.eventId,
      approvalId: action.approvalId,
      actionDigest: action.actionDigest,
      operatorRef: this.config.approverRef,
      decision: action.decision,
      timestamp: Math.floor(Date.now() / 1_000),
    });
    const status =
      decision.state === "approved" || decision.state === "executing"
        ? "已批准，正在执行"
        : decision.state === "denied"
          ? "已拒绝"
          : decision.state === "expired"
            ? "审批已过期"
            : decision.duplicate
              ? "该审批已处理"
              : `审批状态：${decision.state}`;
    await this.dws.updateCard(action.bizId, action.surfaceId, status);
    return decision;
  }

  async start(): Promise<void> {
    await this.initialize();
    while (!this.stopping) {
      try {
        await this.consumeOnce();
      } catch (error) {
        this.logger.error(
          {
            event: "dingtalk_listener_failed",
            error: error instanceof Error ? error.message : String(error),
          },
          "DingTalk event listener failed",
        );
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.restartDelayMs),
        );
      }
    }
  }

  stop(): void {
    this.stopping = true;
    this.activeChild?.kill("SIGTERM");
  }

  private consumeOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.config.dwsCommand,
        [
          "event",
          "consume",
          "user_card_action_triggered",
          "--flatten",
          "-f",
          "ndjson",
          "--max-events",
          "100",
          "--duration",
          this.config.listenerDuration,
        ],
        {
          env: this.safeEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.activeChild = child;
      let ready = false;
      let buffer = "";
      const readyTimer = setTimeout(() => {
        if (!ready) {
          child.kill("SIGTERM");
          reject(new Error("DingTalk event listener did not become ready"));
        }
      }, 20_000);
      readyTimer.unref();

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.logger.info(
          { event: "dingtalk_listener_stderr" },
          chunk.trim(),
        );
        if (chunk.includes("[event] ready")) {
          ready = true;
          clearTimeout(readyTimer);
        }
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            void this.processLine(line);
          }
        }
      });
      child.on("error", (error) => {
        clearTimeout(readyTimer);
        reject(error);
      });
      child.on("close", (code) => {
        this.activeChild = null;
        clearTimeout(readyTimer);
        if (this.stopping) {
          resolve();
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`DingTalk event listener exited with ${code}`));
        }
      });
    });
  }

  private async processLine(line: string): Promise<void> {
    try {
      const event = JSON.parse(line) as unknown;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.handleEvent(event);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await new Promise((resolve) =>
              setTimeout(resolve, attempt * 500),
            );
          }
        }
      }
      throw lastError;
    } catch (error) {
      this.logger.error(
        {
          event: "dingtalk_card_callback_failed",
          error: error instanceof Error ? error.message : String(error),
        },
        "DingTalk card callback failed",
      );
    }
  }

  private safeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ]) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    return env;
  }
}
