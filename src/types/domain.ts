export type PolicyMode = "observe" | "active" | "full-access";
export type RunKind = "run" | "steer";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type TaskAttachmentKind = "image" | "document";
export type AgentTemplateName = "python" | "java" | "nodejs";
export type CapabilityPackName = "mail" | "calendar" | "repo" | "jira" | "ops" | "docs";
export type CapabilityBackendStatus = "implemented" | "planned";
export type CapabilityRiskLevel = "low" | "medium" | "high";
export type CapabilityApprovalLevel =
  | "auto-allowed"
  | "approve-once"
  | "approve-each-write"
  | "local-presence-required"
  | "prohibited-remotely";
export type CapabilityExecutionContext = "cloud" | "local" | "either";
export type CapabilityInputFieldType = "string" | "integer" | "boolean" | "enum" | "uri" | "path";
export type SpecSectionName =
  | "REQUEST"
  | "GOAL"
  | "OUTCOME"
  | "CONSTRAINTS"
  | "NON_GOALS"
  | "CONTEXT"
  | "ASSUMPTIONS"
  | "QUESTIONS"
  | "PLAN"
  | "APPROVALS_REQUIRED"
  | "DONE_WHEN";

export interface TaskTokenUsage {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cachedInput?: number;
  remaining?: number;
}

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
  specPolicy?: SpecPolicyConfigOverride;
}

export interface SpecPolicyModeConfig {
  requireApprovedSpecForRun: boolean;
  allowForceApproval: boolean;
  requiredSectionsForApproval: SpecSectionName[];
}

export interface SpecPolicyConfig {
  observe: SpecPolicyModeConfig;
  active: SpecPolicyModeConfig;
  "full-access": SpecPolicyModeConfig;
}

export type SpecPolicyModeConfigOverride = Partial<SpecPolicyModeConfig>;

export interface SpecPolicyConfigOverride {
  observe?: SpecPolicyModeConfigOverride;
  active?: SpecPolicyModeConfigOverride;
  "full-access"?: SpecPolicyModeConfigOverride;
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
  maxFileBytes: number;
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

export interface ExternalRelayConfig {
  enabled: boolean;
  host: string;
  port: number;
  authTokenEnvVar?: string;
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
  externalRelay: ExternalRelayConfig;
}

export interface SessionState {
  chatId: number;
  selectedRepo?: string;
  mode: PolicyMode;
  activeRequestId?: string;
  codexThreadId?: string;
  codexLastActiveAt?: string;
  reasoningEffortOverride?: CodexReasoningEffort;
  lastReasoningEffort?: CodexReasoningEffort;
  lastTokenUsage?: TaskTokenUsage;
  lastRunAt?: string;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  chatId: number;
  userId: number;
  repoName: string;
  mode: PolicyMode;
  instruction: string;
  capabilityRef?: string;
  source?: "codefox" | "external-codex";
  externalApproval?: {
    leaseId: string;
    approvalKey: string;
  };
  createdAt: string;
}

export interface ExternalHandoffRemainingWork {
  id: string;
  summary: string;
  requestedCapabilityRef?: string;
  blockedByApproval?: boolean;
}

export interface ExternalHandoffBundleState {
  schemaVersion: string;
  leaseId: string;
  handoffId: string;
  clientId: string;
  createdAt: string;
  taskId: string;
  specRevisionRef: string;
  completedWork: string[];
  remainingWork: ExternalHandoffRemainingWork[];
  sourceRepo?: {
    name: string;
    rootPath?: string;
  };
  evidenceRefs?: string[];
  unresolvedQuestions?: string[];
  unresolvedRisks?: string[];
}

export interface ExternalHandoffStateSnapshot {
  chatId: number;
  leaseId: string;
  sourceSessionId?: string;
  sourceRepoName?: string;
  sourceRepoPath?: string;
  sourceMode?: PolicyMode;
  handoff: ExternalHandoffBundleState;
  receivedAt: string;
  continuedWorkIds: string[];
}

export interface TaskCapabilityContext {
  ref: string;
  pack: CapabilityPackName;
  action: string;
  riskLevel: CapabilityRiskLevel;
  approvalLevel: CapabilityApprovalLevel;
  executionContext: CapabilityExecutionContext;
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
  capability?: TaskCapabilityContext;
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
  reasoningEffort?: CodexReasoningEffort;
  tokenUsage?: TaskTokenUsage;
}

export interface ProgressEvent {
  requestId: string;
  line: string;
}
