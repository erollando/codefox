import crypto from "node:crypto";

export function makeRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}
