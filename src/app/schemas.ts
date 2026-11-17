import { z } from "zod";

export const EventRequestSchema = z
  .object({
    source: z.string().min(1).max(100),
    eventType: z.string().min(1).max(150),
    subjectKey: z.string().min(1).max(500),
    idempotencyKey: z.string().min(1).max(500),
    occurredAt: z.iso.datetime({ offset: true }),
    summary: z.string().min(1).max(10_000),
    payloadRef: z.string().min(1).max(1_000).nullable().optional(),
    sensitivity: z
      .enum(["public", "internal", "private", "secret"])
      .default("private"),
  })
  .strict();

export const ClaimRequestSchema = z
  .object({
    workerId: z.string().min(1).max(200),
    leaseSeconds: z.number().int().min(30).max(600).default(120),
  })
  .strict();

export const RunFailureSchema = z
  .object({
    error: z.string().min(1).max(4_000),
  })
  .strict();

export const FeishuDecisionSchema = z
  .object({
    eventId: z.string().min(1).max(300),
    approvalId: z.string().min(1).max(200),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    operatorRef: z.string().min(1).max(200),
    decision: z.enum(["approve", "deny"]),
    timestamp: z.number().int().positive(),
  })
  .strict();

export const DingTalkDecisionSchema = z
  .object({
    eventId: z.string().min(1).max(300),
    approvalId: z.string().min(1).max(200),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    operatorRef: z.string().min(1).max(200),
    decision: z.enum(["approve", "deny"]),
    timestamp: z.number().int().positive(),
  })
  .strict();

export const KillSwitchSchema = z
  .object({ enabled: z.boolean() })
  .strict();
