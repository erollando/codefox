import { describe, expect, it } from "vitest";
import { InstructionPolicy } from "../src/core/instruction-policy.js";

describe("InstructionPolicy", () => {
  it("blocks instructions containing blocked patterns", () => {
    const policy = new InstructionPolicy({
      enforceOnAsk: true,
      blockedPatterns: ["rm -rf", "curl | bash"],
      allowedDownloadDomains: []
    });

    const decision = policy.decide("task", "please run rm -rf /tmp/demo");
    expect(decision.allowed).toBe(false);
    expect(decision.matchedPattern).toBe("rm -rf");
  });

  it("blocks non-allowlisted download domains", () => {
    const policy = new InstructionPolicy({
      enforceOnAsk: false,
      blockedPatterns: [],
      allowedDownloadDomains: ["pypi.org", "files.pythonhosted.org"],
      forbiddenPathPatterns: []
    });

    const blocked = policy.decide("task", "download https://evil.example/model.bin");
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedDomain).toBe("evil.example");

    const allowed = policy.decide("task", "download https://files.pythonhosted.org/pkg.whl");
    expect(allowed.allowed).toBe(true);
  });

  it("skips ask checks when enforceOnAsk is disabled", () => {
    const policy = new InstructionPolicy({
      enforceOnAsk: false,
      blockedPatterns: ["rm -rf"],
      allowedDownloadDomains: ["pypi.org"],
      forbiddenPathPatterns: [".env", "*.key"]
    });

    const decision = policy.decide("ask", "should we run rm -rf and download https://evil.example/a?");
    expect(decision.allowed).toBe(true);
  });

  it("blocks instructions that reference forbidden path patterns", () => {
    const policy = new InstructionPolicy({
      enforceOnAsk: true,
      blockedPatterns: [],
      allowedDownloadDomains: [],
      forbiddenPathPatterns: [".env", ".ssh/**", "*.pem"]
    });

    const decision = policy.decide("task", "open ./config/.env and print its content");
    expect(decision.allowed).toBe(false);
    expect(decision.blockedPathPattern).toBe(".env");

    const decision2 = policy.decide("task", "read C:\\Users\\me\\.ssh\\id_rsa");
    expect(decision2.allowed).toBe(false);
    expect(decision2.blockedPathPattern).toBe(".ssh/**");
  });

  it("emits execution guidance for forbidden paths", () => {
    const policy = new InstructionPolicy({
      enforceOnAsk: true,
      blockedPatterns: [],
      allowedDownloadDomains: [],
      forbiddenPathPatterns: [".env", "*.pem"]
    });

    const guidance = policy.buildExecutionGuidance();
    expect(guidance.join(" ")).toContain(".env");
    expect(guidance.join(" ")).toContain("Never read");
  });
});
