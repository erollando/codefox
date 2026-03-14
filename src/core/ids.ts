import crypto from "node:crypto";

export function makeRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function makeViewId(): string {
  return `view_${crypto.randomUUID().slice(0, 8)}`;
}
