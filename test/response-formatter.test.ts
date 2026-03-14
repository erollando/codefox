import { describe, expect, it } from "vitest";
import { formatAuditLookup, formatPolicySummary, formatSessionStatus, formatTaskResult } from "../src/core/response-formatter.js";
import { formatCapabilitiesSummary } from "../src/core/response-formatter.js";

describe("response formatter", () => {
  it("does not include raw output tail on successful runs", () => {
    const message = formatTaskResult(
      {
        ok: true,
        summary: "done",
        outputTail: "OpenAI Codex v0.111.0\\n...very noisy transcript..."
      },
      "payments-api",
      "active"
    );

    expect(message).toContain("Completed: done");
    expect(message).not.toContain("output:");
    expect(message).not.toContain("very noisy transcript");
  });

  it("preserves long output blocks for adapter-level chunking", () => {
    const longOutput = "x".repeat(2000);
    const message = formatTaskResult(
      {
        ok: false,
        summary: "failure",
        outputTail: longOutput
      },
      "payments-api",
      "active"
    );

    expect(message).toContain(longOutput);
    expect(message).not.toContain("... (truncated)");
  });

  it("renders aborted and timed-out states explicitly", () => {
    const aborted = formatTaskResult(
      {
        ok: false,
        summary: "Run aborted by user.",
        aborted: true
      },
      "payments-api",
      "active"
    );
    const timedOut = formatTaskResult(
      {
        ok: false,
        summary: "Codex run timed out after 1ms.",
        timedOut: true
      },
      "payments-api",
      "active"
    );

    expect(aborted).toContain("Aborted:");
    expect(timedOut).toContain("Timed out:");
  });

  it("redacts sensitive tokens in summary and output", () => {
    const message = formatTaskResult(
      {
        ok: false,
        summary: "failed: TELEGRAM_BOT_TOKEN=abc123",
        outputTail: "Authorization: Bearer secret-token"
      },
      "payments-api",
      "active"
    );

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("abc123");
    expect(message).not.toContain("secret-token");
  });

  it("shows available tokens in status when remaining budget is known", () => {
    const status = formatSessionStatus(
      {
        chatId: 100,
        mode: "active",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastRunAt: "2026-01-01T02:03:04.000Z",
        lastTokenUsage: { remaining: 123456 }
      },
      120,
      "high",
      {
        mode: "active",
        requireApprovedSpecForRun: true,
        allowForceApproval: false,
        requiredSectionsForApproval: ["CONSTRAINTS", "DONE_WHEN"]
      }
    );

    expect(status).toContain("available tokens: 123,456");
    expect(status).toContain("available tokens as of: 2026-01-01T02:03:04.000Z");
    expect(status).toContain("spec policy: mode=active");
    expect(status).toContain("spec requires approved for /run: yes");
    expect(status).toContain("spec force approval: blocked");
    expect(status).toContain("spec required sections for approval: CONSTRAINTS, DONE_WHEN");
  });

  it("renders policy summary with global and per-mode details", () => {
    const policy = formatPolicySummary({
      currentMode: "active",
      effectiveMode: "full-access",
      requireAgentsForRuns: true,
      instructionPolicy: {
        blockedPatternCount: 2,
        allowedDownloadDomainCount: 1,
        forbiddenPathPatternCount: 3
      },
      specPolicies: [
        {
          mode: "observe",
          requireApprovedSpecForRun: false,
          allowForceApproval: true,
          requiredSectionsForApproval: []
        },
        {
          mode: "active",
          requireApprovedSpecForRun: true,
          allowForceApproval: false,
          requiredSectionsForApproval: ["CONSTRAINTS", "DONE_WHEN"]
        },
        {
          mode: "full-access",
          requireApprovedSpecForRun: true,
          allowForceApproval: false,
          requiredSectionsForApproval: ["CONSTRAINTS", "DONE_WHEN"]
        }
      ]
    });

    expect(policy).toContain("Policy:");
    expect(policy).toContain("current mode: active");
    expect(policy).toContain("effective mode: full-access");
    expect(policy).toContain("agents guard required for mutating runs: yes");
    expect(policy).toContain("instruction policy: blockedPatterns=2, allowedDomains=1, forbiddenPathPatterns=3");
    expect(policy).toContain("- active: requireApprovedSpecForRun=yes, allowForceApproval=no");
  });

  it("renders audit lookup results", () => {
    const found = formatAuditLookup("view_abcd1234", {
      type: "status_viewed",
      timestamp: "2026-01-01T00:00:00.000Z",
      mode: "active"
    });
    const missing = formatAuditLookup("view_missing");

    expect(found).toContain("Audit event:");
    expect(found).toContain("view id: view_abcd1234");
    expect(found).toContain("type: status_viewed");
    expect(found).toContain("details: mode=active");
    expect(missing).toContain("No audit event found for view id 'view_missing'.");
  });

  it("renders capability summaries", () => {
    const overview = formatCapabilitiesSummary({
      mode: "active",
      packs: [
        { pack: "repo", actionCount: 3, runnableInModeCount: 3 },
        { pack: "jira", actionCount: 3, runnableInModeCount: 3 }
      ],
      actions: []
    });
    const detail = formatCapabilitiesSummary({
      mode: "active",
      pack: "repo",
      packs: [],
      actions: [
        {
          pack: "repo",
          action: "run_checks",
          description: "Run tests",
          riskLevel: "low",
          approvalLevel: "auto-allowed",
          executionContext: "local",
          mutatesState: false,
          inputSchema: [{ name: "checkProfile", type: "enum", required: false, description: "profile" }],
          auditPayloadFields: [{ key: "resultSummary", description: "summary" }],
          rollbackHints: []
        }
      ]
    });

    expect(overview).toContain("Capabilities (mode: active):");
    expect(overview).toContain("- repo: actions=3, runnable=3");
    expect(overview).toContain("Use /capabilities <pack> for action details.");
    expect(detail).toContain("Capabilities pack 'repo' (mode: active):");
    expect(detail).toContain("- run_checks: risk=low, approval=auto-allowed, context=local, mutates=no");
    expect(detail).toContain("inputs: checkProfile:enum");
    expect(detail).toContain("audit: resultSummary");
    expect(detail).toContain("rollback: (none)");
  });
});
