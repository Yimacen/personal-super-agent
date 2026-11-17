import { z } from "zod";

const UnknownRecordSchema = z.record(z.string(), z.unknown());

const RawDingTalkEventSchema = z
  .object({
    event_id: z.string().min(1),
    payload: z
      .object({
        body: UnknownRecordSchema,
      })
      .passthrough(),
  })
  .passthrough();

export const DingTalkCardActionSchema = z
  .object({
    eventId: z.string().min(1),
    bizId: z.string().min(1),
    surfaceId: z.string().min(1),
    approvalId: z.string().min(1),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["approve", "deny"]),
    operatorUid: z.string().min(1).nullable(),
    operatorOpenId: z.string().min(1).nullable(),
  })
  .strict()
  .refine((value) => value.operatorUid || value.operatorOpenId, {
    message: "DingTalk callback has no operator identity",
  });

export type DingTalkCardAction = z.infer<typeof DingTalkCardActionSchema>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseDingTalkCardEvent(
  raw: unknown,
): DingTalkCardAction {
  const event = RawDingTalkEventSchema.parse(raw);
  const body = event.payload.body;
  const a2uiEvent = asRecord(body.a2uiEvent);
  const action = asRecord(a2uiEvent?.action);
  const actionData = asRecord(body.actionData);
  const context =
    asRecord(action?.context) ??
    asRecord(actionData?.context) ??
    {};
  const bizInfo = asRecord(body.bizInfoDTO);
  const operator = asRecord(body.operatorDTO);
  if (action && action.name !== "approval_decision") {
    throw new Error(
      `Unsupported DingTalk card action: ${String(action.name)}`,
    );
  }
  return DingTalkCardActionSchema.parse({
    eventId: event.event_id,
    bizId: bizInfo?.bizId,
    surfaceId: context.surfaceId,
    approvalId: context.approvalId,
    actionDigest: context.actionDigest,
    decision: context.decision,
    operatorUid:
      operator?.uid === undefined || operator.uid === null
        ? null
        : String(operator.uid),
    operatorOpenId:
      typeof operator?.openDingTalkId === "string"
        ? operator.openDingTalkId
        : null,
  });
}
