import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(resolve(".env"))) {
  process.loadEnvFile(resolve(".env"));
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and set a long random value.`,
    );
  }
  return value;
}

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  workspaceRoot: string;
  backupDir: string;
  internalApiToken: string;
  approvalChannel: "feishu" | "dingtalk";
  feishuWebhookUrl: string | null;
  feishuSigningSecret: string | null;
  dingtalkDwsCommand: string;
  dingtalkApproverOpenId: string | null;
  dingtalkApproverUid: string | null;
  dingtalkBridgeToken: string | null;
  dingtalkCatalogUrl: string;
  approverRef: string;
  controlJobPollMs: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const internalApiToken = overrides.internalApiToken ??
    required("INTERNAL_API_TOKEN");
  if (internalApiToken.length < 24) {
    throw new Error("INTERNAL_API_TOKEN must contain at least 24 characters");
  }
  const approvalChannel =
    overrides.approvalChannel ??
    (process.env.APPROVAL_CHANNEL ?? "feishu");
  if (approvalChannel !== "feishu" && approvalChannel !== "dingtalk") {
    throw new Error("APPROVAL_CHANNEL must be feishu or dingtalk");
  }
  return {
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? integer("PORT", 4310),
    databasePath:
      overrides.databasePath ??
      resolve(process.env.DATABASE_PATH ?? "./data/assistant.db"),
    workspaceRoot:
      overrides.workspaceRoot ??
      resolve(process.env.WORKSPACE_ROOT ?? "./data/workspaces"),
    backupDir:
      overrides.backupDir ?? resolve(process.env.BACKUP_DIR ?? "./data/backups"),
    internalApiToken,
    approvalChannel,
    feishuWebhookUrl:
      overrides.feishuWebhookUrl ??
      (process.env.FEISHU_WEBHOOK_URL || null),
    feishuSigningSecret:
      overrides.feishuSigningSecret ??
      (process.env.FEISHU_SIGNING_SECRET || null),
    dingtalkDwsCommand:
      overrides.dingtalkDwsCommand ??
      process.env.DINGTALK_DWS_COMMAND ??
      "dws",
    dingtalkApproverOpenId:
      overrides.dingtalkApproverOpenId ??
      (process.env.DINGTALK_APPROVER_OPEN_ID || null),
    dingtalkApproverUid:
      overrides.dingtalkApproverUid ??
      (process.env.DINGTALK_APPROVER_UID || null),
    dingtalkBridgeToken:
      overrides.dingtalkBridgeToken ??
      (process.env.DINGTALK_BRIDGE_TOKEN || null),
    dingtalkCatalogUrl:
      overrides.dingtalkCatalogUrl ??
      process.env.DINGTALK_CARD_CATALOG ??
      "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json",
    approverRef: overrides.approverRef ?? process.env.APPROVER_REF ?? "owner",
    controlJobPollMs:
      overrides.controlJobPollMs ?? integer("CONTROL_JOB_POLL_MS", 250),
  };
}

export interface DingTalkBridgeConfig {
  apiBaseUrl: string;
  bridgeToken: string;
  dwsCommand: string;
  expectedOpenId: string | null;
  expectedUid: string | null;
  approverRef: string;
  listenerDuration: string;
  restartDelayMs: number;
}

export function loadDingTalkBridgeConfig(
  overrides: Partial<DingTalkBridgeConfig> = {},
): DingTalkBridgeConfig {
  const bridgeToken = overrides.bridgeToken ??
    process.env.DINGTALK_BRIDGE_TOKEN;
  if (!bridgeToken || bridgeToken.length < 24) {
    throw new Error(
      "DINGTALK_BRIDGE_TOKEN must contain at least 24 characters",
    );
  }
  return {
    apiBaseUrl:
      overrides.apiBaseUrl ??
      process.env.DINGTALK_API_BASE_URL ??
      `http://127.0.0.1:${process.env.PORT ?? "4310"}`,
    bridgeToken,
    dwsCommand:
      overrides.dwsCommand ??
      process.env.DINGTALK_DWS_COMMAND ??
      "dws",
    expectedOpenId:
      overrides.expectedOpenId ??
      (process.env.DINGTALK_APPROVER_OPEN_ID || null),
    expectedUid:
      overrides.expectedUid ??
      (process.env.DINGTALK_APPROVER_UID || null),
    approverRef:
      overrides.approverRef ??
      process.env.APPROVER_REF ??
      "owner",
    listenerDuration:
      overrides.listenerDuration ??
      process.env.DINGTALK_LISTENER_DURATION ??
      "24h",
    restartDelayMs:
      overrides.restartDelayMs ??
      integer("DINGTALK_BRIDGE_RESTART_MS", 3_000),
  };
}

export interface WorkerConfig {
  apiBaseUrl: string;
  internalApiToken: string;
  workerId: string;
  pollMs: number;
  workspaceRoot: string;
  codexMode: "scripted" | "codex";
  codexCommand: string;
  codexModel: string | null;
  codexEnvAllowlist: string[];
}

export function loadWorkerConfig(
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  const internalApiToken = overrides.internalApiToken ??
    required("INTERNAL_API_TOKEN");
  return {
    apiBaseUrl:
      overrides.apiBaseUrl ??
      process.env.WORKER_API_BASE_URL ??
      "http://127.0.0.1:4310",
    internalApiToken,
    workerId:
      overrides.workerId ?? process.env.WORKER_ID ?? "codex-worker-local",
    pollMs: overrides.pollMs ?? integer("WORKER_POLL_MS", 1_000),
    workspaceRoot:
      overrides.workspaceRoot ??
      resolve(process.env.WORKSPACE_ROOT ?? "./data/workspaces"),
    codexMode:
      overrides.codexMode ??
      ((process.env.WORKER_CODEX_MODE ?? "scripted") === "codex"
        ? "codex"
        : "scripted"),
    codexCommand:
      overrides.codexCommand ?? process.env.CODEX_COMMAND ?? "codex",
    codexModel:
      overrides.codexModel ?? process.env.CODEX_MODEL ?? null,
    codexEnvAllowlist:
      overrides.codexEnvAllowlist ??
      (process.env.CODEX_ENV_ALLOWLIST ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
  };
}
