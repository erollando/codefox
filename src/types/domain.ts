export type PolicyMode = "observe" | "active" | "full-access";
export type RunKind = "run" | "steer";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type TaskAttachmentKind = "image" | "document";

export interface TaskAttachment {
  kind: TaskAttachmentKind;
  localPath: string;
  originalName?: string;
  mimeType?: string;
}

export interface RepoConfig {
  name: string;
  rootPath: string;
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  allowedChatIds?: number[];
  pollingTimeoutSeconds: number;
  pollIntervalMs: number;
  discardBacklogOnStart: boolean;
}

export interface CodexConfig {
  command: string;
  baseArgs: string[];
  model?: string;
  profile?: string;
  reasoningEffort?: CodexReasoningEffort;
  configOverrides?: string[];
  runArgTemplate: string[];
  repoArgTemplate: string[];
  timeoutMs: number;
  blockedEnvVars: string[];
  preflightEnabled: boolean;
  preflightArgs: string[];
  preflightTimeoutMs: number;
}

export interface PolicyConfig {
  defaultMode: PolicyMode;
}

export interface SafetyConfig {
  requireAgentsForRuns: boolean;
  instructionPolicy: {
    blockedPatterns: string[];
    allowedDownloadDomains: string[];
    forbiddenPathPatterns: string[];
  };
}

export interface AuditConfig {
  logFilePath: string;
}

export interface RepoInitConfig {
  defaultParentPath: string;
}

export interface StateConfig {
  filePath: string;
  sessionTtlHours?: number;
  approvalTtlHours?: number;
  codexSessionIdleMinutes: number;
}

export interface AppConfig {
  telegram: TelegramConfig;
  repos: RepoConfig[];
  codex: CodexConfig;
  policy: PolicyConfig;
  safety: SafetyConfig;
  repoInit: RepoInitConfig;
  state: StateConfig;
  audit: AuditConfig;
}

export interface SessionState {
  chatId: number;
  selectedRepo?: string;
  mode: PolicyMode;
  activeRequestId?: string;
  codexThreadId?: string;
  codexLastActiveAt?: string;
  reasoningEffortOverride?: CodexReasoningEffort;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  chatId: number;
  userId: number;
  repoName: string;
  mode: PolicyMode;
  instruction: string;
  createdAt: string;
}

export interface TaskContext {
  chatId: number;
  userId: number;
  repoName: string;
  mode: PolicyMode;
  instruction: string;
  requestId: string;
  runKind: RunKind;
  systemGuidance?: string[];
  resumeThreadId?: string;
  reasoningEffortOverride?: CodexReasoningEffort;
  attachments?: TaskAttachment[];
}

export interface TaskResult {
  ok: boolean;
  summary: string;
  outputTail?: string;
  exitCode?: number;
  approvalRequired?: boolean;
  aborted?: boolean;
  timedOut?: boolean;
  threadId?: string;
  resumeRejected?: boolean;
}

export interface ProgressEvent {
  requestId: string;
  line: string;
}
