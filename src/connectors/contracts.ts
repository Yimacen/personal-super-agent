import type {
  ConnectorReceipt,
  ImmutableActionSnapshot,
  PreparedAction,
  RiskClass,
  VerificationResult,
} from "../domain/models.js";

export interface ConnectorCapability {
  id: string;
  risk: RiskClass;
  reversible: boolean;
  idempotent: boolean;
  requiresApprovalByDefault: boolean;
  scopes: string[];
  targetSchema: Record<string, unknown>;
  parameterSchema: Record<string, unknown>;
}

export interface ConnectorManifest {
  id: string;
  version: string;
  capabilities: ConnectorCapability[];
}

export interface SourceAccount {
  id: string;
  userId: string;
  connectorId: string;
  accountRef: string;
  scopes: string[];
  secretRef: string;
  status: "active" | "expired" | "revoked";
}

export interface Connector {
  manifest: ConnectorManifest;

  prepare(
    account: SourceAccount,
    capability: string,
    target: Record<string, unknown>,
    parameters: Record<string, unknown>,
  ): Promise<PreparedAction>;

  execute(
    account: SourceAccount,
    capability: string,
    action: ImmutableActionSnapshot,
  ): Promise<ConnectorReceipt>;

  verify(
    account: SourceAccount,
    capability: string,
    action: ImmutableActionSnapshot,
  ): Promise<VerificationResult>;
}

export class CapabilityNotAllowedError extends Error {}
