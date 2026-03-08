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
        return { allowed: true, requiresApproval: false };
      case "full-access":
        return {
          allowed: true,
          requiresApproval: true,
          reason: "full-access requires explicit approval"
        };
      default:
        throw new PolicyError(`Unsupported mode '${mode}'`);
    }
  }
}
