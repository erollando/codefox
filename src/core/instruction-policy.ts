export interface InstructionPolicyDecision {
  allowed: boolean;
  reason?: string;
  matchedPattern?: string;
  blockedDomain?: string;
  blockedPathPattern?: string;
}

export interface InstructionPolicyConfig {
  blockedPatterns: string[];
  allowedDownloadDomains: string[];
  forbiddenPathPatterns?: string[];
}

export interface InstructionPolicySummary {
  blockedPatternCount: number;
  allowedDownloadDomainCount: number;
  forbiddenPathPatternCount: number;
}

export class InstructionPolicy {
  private readonly blockedPatterns: string[];
  private readonly allowedDomains: string[];
  private readonly forbiddenPathMatchers: ForbiddenPathMatcher[];
  private readonly forbiddenPathPatterns: string[];

  constructor(private readonly config: InstructionPolicyConfig) {
    this.blockedPatterns = config.blockedPatterns
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    this.allowedDomains = config.allowedDownloadDomains.map((entry) => normalizeDomain(entry)).filter(Boolean);
    this.forbiddenPathPatterns = (config.forbiddenPathPatterns ?? []).map((entry) => normalizePath(entry)).filter(Boolean);
    this.forbiddenPathMatchers = this.forbiddenPathPatterns.map((pattern) => makePathMatcher(pattern));
  }

  decide(instruction: string): InstructionPolicyDecision {
    const normalizedInstruction = instruction.toLowerCase();

    for (const blocked of this.blockedPatterns) {
      if (normalizedInstruction.includes(blocked)) {
        return {
          allowed: false,
          reason: "instruction contains a blocked pattern",
          matchedPattern: blocked
        };
      }
    }

    const blockedPathPattern = this.findBlockedPathPattern(instruction);
    if (blockedPathPattern) {
      return {
        allowed: false,
        reason: "instruction references a forbidden path pattern",
        blockedPathPattern
      };
    }

    if (this.allowedDomains.length > 0) {
      for (const host of extractInstructionDomains(instruction)) {
        if (!isAllowedDomain(host, this.allowedDomains)) {
          return {
            allowed: false,
            reason: "instruction references a non-allowlisted download domain",
            blockedDomain: host
          };
        }
      }
    }

    return { allowed: true };
  }

  buildExecutionGuidance(): string[] {
    if (this.forbiddenPathPatterns.length === 0) {
      return [];
    }

    const preview = this.forbiddenPathPatterns.slice(0, 8).join(", ");
    const suffix = this.forbiddenPathPatterns.length > 8 ? ", ..." : "";
    return [
      "CodeFox safety policy:",
      `Never read, print, exfiltrate, or modify files/paths matching: ${preview}${suffix}.`,
      "If the user request appears to require these paths, refuse and report the limitation."
    ];
  }

  summary(): InstructionPolicySummary {
    return {
      blockedPatternCount: this.blockedPatterns.length,
      allowedDownloadDomainCount: this.allowedDomains.length,
      forbiddenPathPatternCount: this.forbiddenPathPatterns.length
    };
  }

  private findBlockedPathPattern(instruction: string): string | undefined {
    const normalized = normalizePath(instruction);
    for (const matcher of this.forbiddenPathMatchers) {
      if (matcher.kind === "contains") {
        if (normalized.includes(matcher.needle)) {
          return matcher.pattern;
        }
        continue;
      }

      if (matcher.regex.test(normalized)) {
        return matcher.pattern;
      }
    }

    return undefined;
  }
}

function extractInstructionDomains(instruction: string): string[] {
  const urls = instruction.match(/https?:\/\/[^\s)]+/gi) ?? [];
  const domains = new Set<string>();

  for (const rawUrl of urls) {
    try {
      const host = normalizeDomain(new URL(rawUrl).hostname);
      if (host) {
        domains.add(host);
      }
    } catch {
      // Ignore malformed URLs in prompt text.
    }
  }

  return [...domains];
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "");
}

function normalizePath(value: string): string {
  return value.trim().toLowerCase().replaceAll("\\", "/");
}

function isAllowedDomain(host: string, allowlist: string[]): boolean {
  for (const allowed of allowlist) {
    if (host === allowed || host.endsWith(`.${allowed}`)) {
      return true;
    }
  }
  return false;
}

type ForbiddenPathMatcher =
  | { kind: "contains"; pattern: string; needle: string }
  | { kind: "regex"; pattern: string; regex: RegExp };

function makePathMatcher(pattern: string): ForbiddenPathMatcher {
  if (!pattern.includes("*")) {
    return { kind: "contains", pattern, needle: pattern };
  }

  const escaped = escapeRegex(pattern)
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^\\s'\"`)]*");
  return {
    kind: "regex",
    pattern,
    regex: new RegExp(escaped, "i")
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
