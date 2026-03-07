import { describe, expect, it } from "vitest";
import { redactSensitive, toAuditPreview } from "../src/core/sanitize.js";

describe("sanitize", () => {
  it("redacts common secret patterns", () => {
    const input = "token=abc123 password:xyz Bearer aa.bb.cc";
    const output = redactSensitive(input);

    expect(output).toContain("token=[REDACTED]");
    expect(output).toContain("password:[REDACTED]");
    expect(output).toContain("Bearer [REDACTED]");
  });

  it("creates compact bounded audit previews", () => {
    const output = toAuditPreview("  a   b   c  ", 5);
    expect(output).toBe("a b c");

    const truncated = toAuditPreview("x".repeat(50), 10);
    expect(truncated).toBe("xxxxxxxxxx...");
  });

  it("redacts private key blocks", () => {
    const output = redactSensitive(
      "-----BEGIN PRIVATE KEY-----\nverysecret\n-----END PRIVATE KEY-----"
    );
    expect(output).toContain("[REDACTED_PRIVATE_KEY]");
    expect(output).not.toContain("verysecret");
  });
});
