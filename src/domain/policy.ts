import type { ImmutableActionSnapshot, PolicyDecision } from "./models.js";

export const POLICY_VERSION = "policy_2026_11_16_v1";

const FORCE_APPROVAL = new Set([
  "shared_write",
  "external_write",
  "financial",
  "permission",
  "destructive",
]);

const HARD_DENY_CAPABILITIES = new Set([
  "account.rotate_credentials",
  "system.shell",
  "policy.modify",
]);

export interface PolicyFacts {
  killSwitch: boolean;
  capabilityRequiresApproval: boolean;
}

export function evaluatePolicy(
  action: ImmutableActionSnapshot,
  facts: PolicyFacts,
): PolicyDecision {
  if (facts.killSwitch) {
    return {
      decision: "deny",
      reasonCode: "kill_switch_enabled",
      policyVersion: POLICY_VERSION,
    };
  }
  if (HARD_DENY_CAPABILITIES.has(action.capability)) {
    return {
      decision: "deny",
      reasonCode: "capability_hard_denied",
      policyVersion: POLICY_VERSION,
    };
  }
  if (FORCE_APPROVAL.has(action.risk)) {
    return {
      decision: "approval",
      reasonCode: `approval_required:${action.risk}`,
      policyVersion: POLICY_VERSION,
    };
  }
  if (facts.capabilityRequiresApproval) {
    return {
      decision: "approval",
      reasonCode: "approval_required:capability",
      policyVersion: POLICY_VERSION,
    };
  }
  if (action.risk === "read") {
    return {
      decision: "allow",
      reasonCode: "allow:read",
      policyVersion: POLICY_VERSION,
    };
  }
  if (action.risk === "private_write" && action.reversible) {
    return {
      decision: "allow",
      reasonCode: "allow:reversible_private_write",
      policyVersion: POLICY_VERSION,
    };
  }
  return {
    decision: "approval",
    reasonCode: "approval_required:unknown_or_irreversible",
    policyVersion: POLICY_VERSION,
  };
}
