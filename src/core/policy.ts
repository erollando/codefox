import { PolicyError } from "./errors.js";
import type { PolicyMode } from "../types/domain.js";

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

export class PolicyEngine {
  decide(mode: PolicyMode): PolicyDecision {
    switch (mode) {
      case "observe":
      case "active":
      case "full-access":
        return { allowed: true, requiresApproval: false };
      default:
        throw new PolicyError(`Unsupported mode '${mode}'`);
    }
  }
}
