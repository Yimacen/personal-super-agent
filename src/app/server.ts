import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createHmac } from "node:crypto";
import { ZodError } from "zod";
import type { AppConfig } from "../config.js";
import type { Store } from "../db/database.js";
import type { ConnectorRegistry } from "../connectors/registry.js";
import { AppError, UnauthorizedError } from "../errors.js";
import {
  canonicalJson,
  safeEqual,
  sha256,
} from "../lib/canonical.js";
import type { FeishuNotifier } from "../notifications/feishu.js";
import {
  ControlPlane,
  type ControlPlaneLogger,
} from "../services/control-plane.js";
import { ControlJobScheduler } from "./scheduler.js";
import {
  ClaimRequestSchema,
  EventRequestSchema,
  FeishuDecisionSchema,
  KillSwitchSchema,
} from "./schemas.js";

export interface ServerOptions {
  store: Store;
  config: AppConfig;
  connectors: ConnectorRegistry;
  notifier: FeishuNotifier;
  logger?: ControlPlaneLogger;
  startScheduler?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  control: ControlPlane;
  scheduler: ControlJobScheduler;
  close(): Promise<void>;
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }
  return header.slice("Bearer ".length);
}

function assertInternalToken(request: FastifyRequest, expected: string): void {
  if (!safeEqual(bearer(request), expected)) {
    throw new UnauthorizedError("Invalid internal API token");
  }
}

function verifyFeishuSignature(
  request: FastifyRequest,
  secret: string,
  timestamp: number,
  body: unknown,
): void {
  const signature = request.headers["x-feishu-signature"];
  if (typeof signature !== "string") {
    throw new UnauthorizedError("Missing Feishu callback signature");
  }
  if (Math.abs(Date.now() - timestamp * 1_000) > 5 * 60_000) {
    throw new UnauthorizedError("Feishu callback timestamp is outside the replay window");
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalJson(body)}`)
    .digest("hex");
  if (!safeEqual(signature, expected)) {
    throw new UnauthorizedError("Invalid Feishu callback signature");
  }
}

export async function buildServer(options: ServerOptions): Promise<BuiltServer> {
  const { store, config, connectors, notifier } = options;
  const app = Fastify({
    logger: options.logger ? false : {
      level: process.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "headers.authorization",
        "body.payloadRef",
        "payloadRef",
      ],
    },
  });
  const logger: ControlPlaneLogger =
    options.logger ??
    ({
      info: (input, message) => app.log.info(input as object, message),
      warn: (input, message) => app.log.warn(input as object, message),
      error: (input, message) => app.log.error(input as object, message),
    } satisfies ControlPlaneLogger);
  const control = new ControlPlane(
    store,
    connectors,
    notifier,
    config.approverRef,
    logger,
  );
  control.bootstrap();
  const scheduler = new ControlJobScheduler(
    control,
    config.controlJobPollMs,
    logger,
  );

  app.setErrorHandler(
    (
      error: Error & { statusCode?: number; code?: string },
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: "invalid_input",
          issues: error.issues,
        });
        return;
      }
      if (error instanceof AppError) {
        reply.status(error.statusCode).send({
          error: error.code,
          message: error.message,
        });
        return;
      }
      app.log.error({ error }, "Unhandled request error");
      reply.status(error.statusCode ?? 500).send({
        error: error.code ?? "internal_error",
        message:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : error.message,
      });
    },
  );

  app.get("/health", async () => ({
    ok: store.integrityCheck() === "ok",
    schemaVersion: store.userVersion(),
  }));

  app.post("/api/events", async (request, reply) => {
    const input = EventRequestSchema.parse(request.body);
    const result = control.ingestEvent(input);
    reply.status(result.duplicate ? 200 : 202);
    return result;
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => {
    const task = control.getTask(request.params.id);
    return {
      id: task.id,
      goal: task.goal,
      state: task.state,
      acceptanceCriteria: JSON.parse(task.acceptance_criteria_json),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    };
  });

  app.get("/api/tasks", async () => ({
    tasks: control.listTasks(),
  }));

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/timeline",
    async (request) => control.getTimeline(request.params.id),
  );

  app.put("/api/kill-switch", async (request) => {
    const input = KillSwitchSchema.parse(request.body);
    return control.setKillSwitch(input.enabled);
  });

  app.post("/internal/jobs/claim", async (request, reply) => {
    assertInternalToken(request, config.internalApiToken);
    const input = ClaimRequestSchema.parse(request.body);
    const job = control.claimWorkerJob(input.workerId, input.leaseSeconds);
    if (!job) {
      reply.status(204);
      return;
    }
    return job;
  });

  app.post<{ Params: { id: string } }>(
    "/internal/runs/:id/heartbeat",
    async (request) => {
      const token = bearer(request);
      control.assertRunAccess(token, request.params.id);
      const result = control.heartbeat(token);
      return { runId: request.params.id, ...result };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/internal/runs/:id/context",
    async (request) => {
      const token = bearer(request);
      control.assertRunAccess(token, request.params.id);
      const context = control.getRunContext(token);
      return context;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/internal/runs/:id/result",
    async (request) => {
      const token = bearer(request);
      control.assertRunAccess(token, request.params.id);
      return control.submitWorkerResult(token, request.body);
    },
  );

  app.post("/api/feishu/callback", async (request) => {
    const input = FeishuDecisionSchema.parse(request.body);
    if (!config.feishuSigningSecret) {
      throw new UnauthorizedError(
        "FEISHU_SIGNING_SECRET is required for callbacks",
      );
    }
    verifyFeishuSignature(
      request,
      config.feishuSigningSecret,
      input.timestamp,
      request.body,
    );
    return control.decideApproval({
      approvalId: input.approvalId,
      actionDigest: input.actionDigest,
      operatorRef: input.operatorRef,
      decision: input.decision,
      eventId: input.eventId,
      rawHash: sha256(canonicalJson(request.body)),
    });
  });

  if (options.startScheduler ?? true) {
    scheduler.start();
    app.addHook("onClose", async () => {
      scheduler.stop();
    });
  }

  return {
    app,
    control,
    scheduler,
    async close() {
      scheduler.stop();
      await app.close();
    },
  };
}
