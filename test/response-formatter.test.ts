import { describe, expect, it } from "vitest";
import { formatTaskResult } from "../src/core/response-formatter.js";

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

    expect(message).toContain("Run completed.");
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

    expect(aborted).toContain("Run aborted.");
    expect(timedOut).toContain("Run timed out.");
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
});
