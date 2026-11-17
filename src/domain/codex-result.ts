import { z } from "zod";

export const CodexResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("complete"),
      summary: z.string().min(1),
      acceptanceChecks: z
        .array(
          z
            .object({
              check: z.string().min(1),
              passed: z.boolean(),
              evidence: z.string().optional(),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("needs_data"),
      requests: z
        .array(
          z
            .object({
              sourceAccountId: z.string().min(1),
              capability: z.string().min(1),
              query: z.record(z.string(), z.unknown()),
              reason: z.string().min(1),
            })
            .strict(),
        )
        .max(5),
    })
    .strict(),
  z
    .object({
      kind: z.literal("proposed_action"),
      summary: z.string().min(1),
      action: z
        .object({
          sourceAccountId: z.string().min(1),
          connectorId: z.string().min(1),
          capability: z.string().min(1),
          target: z.record(z.string(), z.unknown()),
          parameters: z.record(z.string(), z.unknown()),
          sideEffects: z.array(z.string()).max(20),
          evidenceRefs: z.array(z.string()).max(20),
          acceptanceChecks: z.array(z.string()).max(10),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("no_action"),
      summary: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
]);

export type CodexResult = z.infer<typeof CodexResultSchema>;

export const CodexResultJsonSchema = {
  type: "object",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "summary", "acceptanceChecks"],
      properties: {
        kind: { const: "complete" },
        summary: { type: "string", minLength: 1 },
        acceptanceChecks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["check", "passed"],
            properties: {
              check: { type: "string", minLength: 1 },
              passed: { type: "boolean" },
              evidence: { type: "string" },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "requests"],
      properties: {
        kind: { const: "needs_data" },
        requests: { type: "array" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "summary", "action"],
      properties: {
        kind: { const: "proposed_action" },
        summary: { type: "string", minLength: 1 },
        action: {
          type: "object",
          additionalProperties: false,
          required: [
            "sourceAccountId",
            "connectorId",
            "capability",
            "target",
            "parameters",
            "sideEffects",
            "evidenceRefs",
            "acceptanceChecks",
          ],
          properties: {
            sourceAccountId: { type: "string" },
            connectorId: { type: "string" },
            capability: { type: "string" },
            target: { type: "object" },
            parameters: { type: "object" },
            sideEffects: { type: "array", items: { type: "string" } },
            evidenceRefs: { type: "array", items: { type: "string" } },
            acceptanceChecks: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "summary", "reason"],
      properties: {
        kind: { const: "no_action" },
        summary: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
      },
    },
  ],
} as const;
