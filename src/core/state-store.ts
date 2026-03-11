import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalRequest, CodexReasoningEffort, PolicyMode, SessionState, TaskTokenUsage } from "../types/domain.js";

export interface PersistedState {
  sessions: SessionState[];
  approvals: ApprovalRequest[];
}

export interface StateTtlOptions {
  sessionTtlHours?: number;
  approvalTtlHours?: number;
}

const EMPTY_STATE: PersistedState = {
  sessions: [],
  approvals: []
};

const POLICY_MODES: PolicyMode[] = ["observe", "active", "full-access"];
const REASONING_EFFORTS: CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

export class JsonStateStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedState> {
    const raw = await readFile(this.filePath, "utf8").catch((error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return "";
      }
      throw error;
    });

    if (!raw) {
      return EMPTY_STATE;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return EMPTY_STATE;
    }

    if (!parsed || typeof parsed !== "object") {
      return EMPTY_STATE;
    }

    const obj = parsed as Record<string, unknown>;
    const sessions = Array.isArray(obj.sessions) ? (obj.sessions as SessionState[]) : [];
    const approvals = Array.isArray(obj.approvals) ? (obj.approvals as ApprovalRequest[]) : [];

    return {
      sessions: sanitizeSessions(sessions),
      approvals: sanitizeApprovals(approvals)
    };
  }

  async save(state: PersistedState): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const parent = path.dirname(this.filePath);
      await mkdir(parent, { recursive: true });

      const safeState: PersistedState = {
        sessions: sanitizeSessions(state.sessions),
        approvals: sanitizeApprovals(state.approvals)
      };

      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(safeState, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });

    return this.writeQueue;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

function sanitizeSessions(sessions: SessionState[]): SessionState[] {
  const now = new Date().toISOString();
  return sessions
    .filter((session) => typeof session?.chatId === "number" && Number.isSafeInteger(session.chatId))
    .map((session) => {
      const mode = isPolicyMode(session.mode) ? session.mode : "observe";
      const codexThreadId = typeof session.codexThreadId === "string" ? session.codexThreadId : undefined;
      const codexLastActiveAt =
        codexThreadId && isValidIsoTimestamp(session.codexLastActiveAt) ? session.codexLastActiveAt : undefined;
      const reasoningEffortOverride =
        typeof session.reasoningEffortOverride === "string" &&
        REASONING_EFFORTS.includes(session.reasoningEffortOverride as CodexReasoningEffort)
          ? (session.reasoningEffortOverride as CodexReasoningEffort)
          : undefined;
      const lastReasoningEffort =
        typeof session.lastReasoningEffort === "string" &&
        REASONING_EFFORTS.includes(session.lastReasoningEffort as CodexReasoningEffort)
          ? (session.lastReasoningEffort as CodexReasoningEffort)
          : undefined;
      const lastTokenUsage = sanitizeTokenUsage(session.lastTokenUsage);
      const lastRunAt = isValidIsoTimestamp(session.lastRunAt) ? session.lastRunAt : undefined;

      return {
        chatId: session.chatId,
        mode,
        selectedRepo: typeof session.selectedRepo === "string" ? session.selectedRepo : undefined,
        activeRequestId: typeof session.activeRequestId === "string" ? session.activeRequestId : undefined,
        codexThreadId,
        codexLastActiveAt,
        reasoningEffortOverride,
        lastReasoningEffort,
        lastTokenUsage,
        lastRunAt,
        updatedAt: isValidIsoTimestamp(session.updatedAt) ? session.updatedAt : now
      };
    });
}

function sanitizeTokenUsage(value: unknown): TaskTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const normalized: TaskTokenUsage = {
    total: toNonNegativeInteger(usage.total),
    input: toNonNegativeInteger(usage.input),
    output: toNonNegativeInteger(usage.output),
    reasoning: toNonNegativeInteger(usage.reasoning),
    cachedInput: toNonNegativeInteger(usage.cachedInput),
    remaining: toNonNegativeInteger(usage.remaining)
  };

  if (
    typeof normalized.total === "undefined" &&
    typeof normalized.input === "undefined" &&
    typeof normalized.output === "undefined" &&
    typeof normalized.reasoning === "undefined" &&
    typeof normalized.cachedInput === "undefined" &&
    typeof normalized.remaining === "undefined"
  ) {
    return undefined;
  }

  return normalized;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function sanitizeApprovals(approvals: ApprovalRequest[]): ApprovalRequest[] {
  const now = new Date().toISOString();
  return approvals
    .filter(
      (approval) =>
        typeof approval?.id === "string" &&
        typeof approval.chatId === "number" &&
        Number.isSafeInteger(approval.chatId) &&
        typeof approval.userId === "number" &&
        Number.isSafeInteger(approval.userId)
    )
    .map((approval) => ({
      id: approval.id,
      chatId: approval.chatId,
      userId: approval.userId,
      repoName: approval.repoName,
      mode: isPolicyMode(approval.mode) ? approval.mode : "observe",
      instruction: approval.instruction,
      createdAt: isValidIsoTimestamp(approval.createdAt) ? approval.createdAt : now
    }));
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === "string" && POLICY_MODES.includes(value as PolicyMode);
}

export function pruneStateByTtl(
  state: PersistedState,
  options: StateTtlOptions,
  now: Date = new Date()
): {
  state: PersistedState;
  removedSessions: number;
  removedApprovals: number;
} {
  const nowMs = now.getTime();
  const sessionTtlMs = ttlHoursToMs(options.sessionTtlHours);
  const approvalTtlMs = ttlHoursToMs(options.approvalTtlHours);

  const sessions = sessionTtlMs
    ? state.sessions.filter((session) => {
        const updatedMs = Date.parse(session.updatedAt);
        return Number.isFinite(updatedMs) && nowMs - updatedMs <= sessionTtlMs;
      })
    : [...state.sessions];

  const approvals = approvalTtlMs
    ? state.approvals.filter((approval) => {
        const createdMs = Date.parse(approval.createdAt);
        return Number.isFinite(createdMs) && nowMs - createdMs <= approvalTtlMs;
      })
    : [...state.approvals];

  return {
    state: {
      sessions,
      approvals
    },
    removedSessions: state.sessions.length - sessions.length,
    removedApprovals: state.approvals.length - approvals.length
  };
}

function ttlHoursToMs(hours: number | undefined): number | undefined {
  if (typeof hours !== "number") {
    return undefined;
  }
  return hours * 60 * 60 * 1000;
}
