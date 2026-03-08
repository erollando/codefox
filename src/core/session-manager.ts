import type { CodexReasoningEffort, PolicyMode, SessionState } from "../types/domain.js";

export class SessionManager {
  private readonly sessions = new Map<number, SessionState>();

  constructor(
    private readonly defaultMode: PolicyMode,
    initialSessions: SessionState[] = [],
    private readonly onChange?: (sessions: SessionState[]) => void | Promise<void>
  ) {
    for (const session of initialSessions) {
      this.sessions.set(session.chatId, {
        chatId: session.chatId,
        mode: session.mode,
        selectedRepo: session.selectedRepo,
        activeRequestId: session.activeRequestId,
        codexThreadId: session.codexThreadId,
        codexLastActiveAt: session.codexLastActiveAt,
        reasoningEffortOverride: session.reasoningEffortOverride,
        updatedAt: session.updatedAt ?? new Date().toISOString()
      });
    }
  }

  getOrCreate(chatId: number): SessionState {
    const existing = this.sessions.get(chatId);
    if (existing) {
      return existing;
    }

    const created: SessionState = {
      chatId,
      mode: this.defaultMode,
      updatedAt: new Date().toISOString()
    };

    this.sessions.set(chatId, created);
    return created;
  }

  setRepo(chatId: number, repoName: string): SessionState {
    const session = this.getOrCreate(chatId);
    session.selectedRepo = repoName;
    session.updatedAt = new Date().toISOString();
    this.emitChange();
    return session;
  }

  clearRepo(chatId: number): SessionState {
    const session = this.getOrCreate(chatId);
    session.selectedRepo = undefined;
    session.updatedAt = new Date().toISOString();
    this.emitChange();
    return session;
  }

  setMode(chatId: number, mode: PolicyMode): SessionState {
    const session = this.getOrCreate(chatId);
    session.mode = mode;
    session.updatedAt = new Date().toISOString();
    this.emitChange();
    return session;
  }

  setReasoningEffortOverride(chatId: number, reasoningEffort?: CodexReasoningEffort): SessionState {
    const session = this.getOrCreate(chatId);
    session.reasoningEffortOverride = reasoningEffort;
    session.updatedAt = new Date().toISOString();
    this.emitChange();
    return session;
  }

  setActiveRequest(chatId: number, requestId?: string): SessionState {
    const session = this.getOrCreate(chatId);
    session.activeRequestId = requestId;
    session.updatedAt = new Date().toISOString();
    this.emitChange();
    return session;
  }

  setCodexThread(chatId: number, threadId?: string): SessionState {
    const session = this.getOrCreate(chatId);
    session.codexThreadId = threadId;
    session.codexLastActiveAt = threadId ? new Date().toISOString() : undefined;
    session.updatedAt = new Date().toISOString();
    this.emitChange();
    return session;
  }

  touchCodexSession(chatId: number): SessionState {
    const session = this.getOrCreate(chatId);
    if (session.codexThreadId) {
      session.codexLastActiveAt = new Date().toISOString();
      session.updatedAt = new Date().toISOString();
      this.emitChange();
    }
    return session;
  }

  clearCodexSession(chatId: number): SessionState {
    return this.setCodexThread(chatId, undefined);
  }

  list(): SessionState[] {
    return [...this.sessions.values()].sort((left, right) => left.chatId - right.chatId);
  }

  private emitChange(): void {
    if (!this.onChange) {
      return;
    }
    const maybePromise = this.onChange(this.list());
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
      void (maybePromise as Promise<void>).catch((error) => {
        console.error(`Failed to persist sessions: ${String(error)}`);
      });
    }
  }
}
