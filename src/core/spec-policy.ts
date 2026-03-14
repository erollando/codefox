import type {
  PolicyMode,
  SpecPolicyConfig,
  SpecPolicyConfigOverride,
  SpecPolicyModeConfig,
  SpecSectionName
} from "../types/domain.js";
import type { SpecRevision } from "./spec-workflow.js";
import { listMissingRequiredSections, listMissingSections } from "./spec-workflow.js";

export interface SpecModePolicy {
  mode: PolicyMode;
  requireApprovedSpecForRun: boolean;
  allowForceApproval: boolean;
  requiredSectionsForApproval: SpecSectionName[];
}

const DEFAULT_SPEC_POLICY_CONFIG: SpecPolicyConfig = {
  observe: {
    requireApprovedSpecForRun: false,
    allowForceApproval: true,
    requiredSectionsForApproval: []
  },
  active: {
    requireApprovedSpecForRun: true,
    allowForceApproval: false,
    requiredSectionsForApproval: ["CONSTRAINTS", "DONE_WHEN"]
  },
  "full-access": {
    requireApprovedSpecForRun: true,
    allowForceApproval: false,
    requiredSectionsForApproval: ["CONSTRAINTS", "DONE_WHEN"]
  }
};

export class SpecPolicyEngine {
  private readonly config: SpecPolicyConfig;

  constructor(configOverride?: SpecPolicyConfigOverride) {
    this.config = mergeSpecPolicyConfig(DEFAULT_SPEC_POLICY_CONFIG, configOverride);
  }

  forMode(mode: PolicyMode): SpecModePolicy {
    return {
      mode,
      ...this.config[mode]
    };
  }

  listMissingSectionsForMode(revision: SpecRevision, mode: PolicyMode): string[] {
    const baseMissing = listMissingRequiredSections(revision);
    const modePolicy = this.forMode(mode);
    const modeMissing = listMissingSections(revision, modePolicy.requiredSectionsForApproval);
    return [...new Set([...baseMissing, ...modeMissing])];
  }
}

function mergeSpecPolicyConfig(defaults: SpecPolicyConfig, override?: SpecPolicyConfigOverride): SpecPolicyConfig {
  return {
    observe: mergeModePolicy(defaults.observe, override?.observe),
    active: mergeModePolicy(defaults.active, override?.active),
    "full-access": mergeModePolicy(defaults["full-access"], override?.["full-access"])
  };
}

function mergeModePolicy(
  defaults: SpecPolicyModeConfig,
  override?: Partial<SpecPolicyModeConfig>
): SpecPolicyModeConfig {
  return {
    requireApprovedSpecForRun:
      typeof override?.requireApprovedSpecForRun === "boolean"
        ? override.requireApprovedSpecForRun
        : defaults.requireApprovedSpecForRun,
    allowForceApproval:
      typeof override?.allowForceApproval === "boolean" ? override.allowForceApproval : defaults.allowForceApproval,
    requiredSectionsForApproval: override?.requiredSectionsForApproval
      ? [...override.requiredSectionsForApproval]
      : [...defaults.requiredSectionsForApproval]
  };
}
