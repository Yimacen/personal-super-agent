import { z } from "zod";
import type {
  ConnectorReceipt,
  ImmutableActionSnapshot,
  PreparedAction,
  VerificationResult,
} from "../domain/models.js";
import {
  CapabilityNotAllowedError,
  type Connector,
  type ConnectorManifest,
  type SourceAccount,
} from "./contracts.js";

const TodoPrepareSchema = z
  .object({
    target: z
      .object({
        listId: z.string().min(1),
        itemId: z.string().min(1),
      })
      .strict(),
    parameters: z.object({ status: z.enum(["open", "done"]) }).strict(),
  })
  .strict();

const MessagePrepareSchema = z
  .object({
    target: z.object({ account: z.string().min(1) }).strict(),
    parameters: z
      .object({
        to: z.array(z.string().email()).min(1).max(20),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(20_000),
      })
      .strict(),
  })
  .strict();

export interface MemoryConnectorOptions {
  publicBaseUrl?: string;
  failAfterWrite?: boolean;
}

export class MemoryConnector implements Connector {
  readonly manifest: ConnectorManifest = {
    id: "memory",
    version: "1.0.0",
    capabilities: [
      {
        id: "todo.set_status",
        risk: "private_write",
        reversible: true,
        idempotent: true,
        requiresApprovalByDefault: false,
        scopes: ["todo.write"],
      },
      {
        id: "message.send",
        risk: "external_write",
        reversible: false,
        idempotent: true,
        requiresApprovalByDefault: true,
        scopes: ["message.send"],
      },
    ],
  };

  private readonly todoStatus = new Map<string, "open" | "done">();
  private readonly sentMessages = new Map<string, Record<string, unknown>>();
  private readonly executedByDigest = new Map<string, ConnectorReceipt>();
  private readonly executeCounts = new Map<string, number>();
  private readonly options: MemoryConnectorOptions;

  constructor(options: MemoryConnectorOptions = {}) {
    this.options = options;
  }

  async prepare(
    _account: SourceAccount,
    capability: string,
    target: Record<string, unknown>,
    parameters: Record<string, unknown>,
  ): Promise<PreparedAction> {
    if (capability === "todo.set_status") {
      const parsed = TodoPrepareSchema.parse({ target, parameters });
      return {
        target: parsed.target,
        parameters: parsed.parameters,
        sideEffects: [
          `Set todo ${parsed.target.itemId} in ${parsed.target.listId} to ${parsed.parameters.status}`,
        ],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    }
    if (capability === "message.send") {
      const parsed = MessagePrepareSchema.parse({ target, parameters });
      return {
        target: parsed.target,
        parameters: parsed.parameters,
        sideEffects: [
          `Send message to ${parsed.parameters.to.join(", ")}`,
        ],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    }
    throw new CapabilityNotAllowedError(`Unknown capability: ${capability}`);
  }

  async execute(
    _account: SourceAccount,
    capability: string,
    action: ImmutableActionSnapshot,
  ): Promise<ConnectorReceipt> {
    const existing = this.executedByDigest.get(action.actionDigest);
    if (existing) {
      return existing;
    }
    this.executeCounts.set(
      action.actionDigest,
      (this.executeCounts.get(action.actionDigest) ?? 0) + 1,
    );

    if (capability === "todo.set_status") {
      const listId = String(action.target.listId);
      const itemId = String(action.target.itemId);
      this.todoStatus.set(
        `${listId}/${itemId}`,
        action.parameters.status as "open" | "done",
      );
      if (this.options.failAfterWrite) {
        throw new Error("simulated_connection_lost_after_write");
      }
      const receipt: ConnectorReceipt = {
        outcome: "success",
        connectorRequestId: `todo_${action.actionDigest.slice(0, 16)}`,
        receiptRef: `${this.options.publicBaseUrl ?? "memory"}://todo/${listId}/${itemId}`,
      };
      this.executedByDigest.set(action.actionDigest, receipt);
      return receipt;
    }

    if (capability === "message.send") {
      this.sentMessages.set(action.actionDigest, {
        to: action.parameters.to,
        subject: action.parameters.subject,
        body: action.parameters.body,
      });
      if (this.options.failAfterWrite) {
        throw new Error("simulated_connection_lost_after_send");
      }
      const receipt: ConnectorReceipt = {
        outcome: "success",
        connectorRequestId: `message_${action.actionDigest.slice(0, 16)}`,
        receiptRef: `${this.options.publicBaseUrl ?? "memory"}://message/${action.actionDigest}`,
      };
      this.executedByDigest.set(action.actionDigest, receipt);
      return receipt;
    }

    throw new CapabilityNotAllowedError(`Unknown capability: ${capability}`);
  }

  async verify(
    _account: SourceAccount,
    capability: string,
    action: ImmutableActionSnapshot,
  ): Promise<VerificationResult> {
    if (capability === "todo.set_status") {
      const key = `${String(action.target.listId)}/${String(action.target.itemId)}`;
      const observed = this.todoStatus.get(key);
      return {
        verified: observed === action.parameters.status,
        reasonCode:
          observed === action.parameters.status
            ? "todo_status_matches"
            : "todo_status_mismatch",
        observedState: { status: observed ?? null },
      };
    }
    if (capability === "message.send") {
      const observed = this.sentMessages.get(action.actionDigest);
      return {
        verified: observed !== undefined,
        reasonCode:
          observed !== undefined
            ? "message_record_exists"
            : "message_not_found",
        observedState: observed ? { sent: true, subject: observed.subject } : {},
      };
    }
    throw new CapabilityNotAllowedError(`Unknown capability: ${capability}`);
  }

  seedTodo(listId: string, itemId: string, status: "open" | "done"): void {
    this.todoStatus.set(`${listId}/${itemId}`, status);
  }

  getTodoStatus(listId: string, itemId: string): string | null {
    return this.todoStatus.get(`${listId}/${itemId}`) ?? null;
  }

  getSentMessages(): ReadonlyMap<string, Record<string, unknown>> {
    return this.sentMessages;
  }

  getExecuteCount(actionDigest: string): number {
    return this.executeCounts.get(actionDigest) ?? 0;
  }
}
