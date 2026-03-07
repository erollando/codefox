import { PolicyError } from "./errors.js";
import type { PolicyMode, TaskType } from "../types/domain.js";

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

export class PolicyEngine {
  decide(mode: PolicyMode, taskType: TaskType): PolicyDecision {
    if (taskType === "ask") {
      return { allowed: true, requiresApproval: false };
    }

    switch (mode) {
      case "observe":
        return {
          allowed: false,
          requiresApproval: false,
          reason: "observe mode blocks mutating tasks"
        };
      case "active":
        return { allowed: true, requiresApproval: false };
      default:
        throw new PolicyError(`Unsupported mode '${mode}'`);
    }
  }
}
