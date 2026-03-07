export type PolicyMode = "observe" | "active";

export type TaskType = "ask" | "task";
export type PlainTextMode = "task" | "ask";

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
  plainTextMode: PlainTextMode;
}

export interface CodexConfig {
  command: string;
  baseArgs: string[];
  askArgTemplate: string[];
  taskArgTemplate: string[];
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
  requireAgentsForMutatingTasks: boolean;
  instructionPolicy: {
    enforceOnAsk: boolean;
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
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  chatId: number;
  userId: number;
  repoName: string;
  mode: PolicyMode;
  taskType: TaskType;
  instruction: string;
  createdAt: string;
}

export interface TaskContext {
  chatId: number;
  userId: number;
  repoName: string;
  mode: PolicyMode;
  instruction: string;
  taskType: TaskType;
  requestId: string;
  systemGuidance?: string[];
}

export interface TaskResult {
  ok: boolean;
  summary: string;
  outputTail?: string;
  exitCode?: number;
  approvalRequired?: boolean;
  aborted?: boolean;
  timedOut?: boolean;
}

export interface ProgressEvent {
  requestId: string;
  line: string;
}
