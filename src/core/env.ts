import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ENV_FILE = ".env";

export async function loadEnvFile(customPath?: string): Promise<void> {
  const sourcePath = customPath ?? process.env.CODEFOX_ENV_FILE ?? DEFAULT_ENV_FILE;
  const resolved = path.resolve(sourcePath);

  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const rawValue = normalized.slice(equalsIndex + 1).trim();
    process.env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue: string): string {
  if (rawValue.length === 0) {
    return "";
  }

  const quote = rawValue[0];
  if ((quote === '"' || quote === "'") && rawValue.endsWith(quote)) {
    return rawValue.slice(1, -1);
  }

  const inlineComment = rawValue.indexOf(" #");
  if (inlineComment >= 0) {
    return rawValue.slice(0, inlineComment).trim();
  }

  return rawValue;
}
