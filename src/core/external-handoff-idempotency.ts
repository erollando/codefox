interface HandoffComparableRepo {
  name: string;
  rootPath?: string;
}

interface HandoffComparableRemainingWork {
  id: string;
  summary: string;
  requestedCapabilityRef?: string;
  blockedByApproval?: boolean;
}

export interface HandoffComparableBundle {
  schemaVersion: string;
  clientId: string;
  taskId: string;
  specRevisionRef: string;
  completedWork: string[];
  remainingWork: HandoffComparableRemainingWork[];
  sourceRepo?: HandoffComparableRepo;
  evidenceRefs?: string[];
  unresolvedQuestions?: string[];
  unresolvedRisks?: string[];
}

export function areSemanticallyEquivalentExternalHandoffs(
  existing: { sourceSessionId?: string; bundle: HandoffComparableBundle } | undefined,
  incoming: { sourceSessionId?: string; bundle: HandoffComparableBundle }
): boolean {
  if (!existing) {
    return false;
  }
  if (normalizeOptional(existing.sourceSessionId) !== normalizeOptional(incoming.sourceSessionId)) {
    return false;
  }
  return canonicalizeBundle(existing.bundle) === canonicalizeBundle(incoming.bundle);
}

function canonicalizeBundle(bundle: HandoffComparableBundle): string {
  const canonical = {
    schemaVersion: normalizeRequired(bundle.schemaVersion),
    clientId: normalizeRequired(bundle.clientId),
    taskId: normalizeRequired(bundle.taskId),
    specRevisionRef: normalizeRequired(bundle.specRevisionRef),
    completedWork: normalizeStringList(bundle.completedWork),
    remainingWork: bundle.remainingWork.map((work) => ({
      id: normalizeRequired(work.id),
      summary: normalizeRequired(work.summary),
      requestedCapabilityRef: normalizeOptional(work.requestedCapabilityRef),
      blockedByApproval: work.blockedByApproval === true ? true : undefined
    })),
    sourceRepo: bundle.sourceRepo
      ? {
          name: normalizeRequired(bundle.sourceRepo.name),
          rootPath: normalizeOptional(bundle.sourceRepo.rootPath)
        }
      : undefined,
    evidenceRefs: normalizeStringList(bundle.evidenceRefs),
    unresolvedQuestions: normalizeStringList(bundle.unresolvedQuestions),
    unresolvedRisks: normalizeStringList(bundle.unresolvedRisks)
  };
  return JSON.stringify(canonical);
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  return values
    .map((value) => normalizeOptional(value))
    .filter((value): value is string => typeof value === "string")
    .sort();
}

function normalizeRequired(value: string): string {
  return value.trim();
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
