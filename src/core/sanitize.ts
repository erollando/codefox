const MAX_AUDIT_TEXT_PREVIEW = 240;

const SENSITIVE_PATTERNS: RegExp[] = [
  /(token|password|secret|api[_-]?key)(\s*[:=]\s*)([^\s]+)/gi,
  /(authorization)(\s*[:=]\s*bearer\s+)([^\s]+)/gi,
  /(bearer\s+)([a-z0-9._~+\/-]+=*)/gi
];
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;

export function redactSensitive(input: string): string {
  let output = input;
  output = output.replace(PRIVATE_KEY_BLOCK, "[REDACTED_PRIVATE_KEY]");
  output = output.replace(SENSITIVE_PATTERNS[0], "$1$2[REDACTED]");
  output = output.replace(SENSITIVE_PATTERNS[1], "$1$2[REDACTED]");
  output = output.replace(SENSITIVE_PATTERNS[2], "$1[REDACTED]");
  return output;
}

export function toAuditPreview(input: string, maxLength: number = MAX_AUDIT_TEXT_PREVIEW): string {
  const compact = input.replace(/\s+/g, " ").trim();
  const redacted = redactSensitive(compact);
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, maxLength)}...`;
}
