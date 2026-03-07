import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/core/env.js";

describe("loadEnvFile", () => {
  const touchedKeys = ["CODEFOX_TEST_A", "CODEFOX_TEST_B"];

  afterEach(() => {
    for (const key of touchedKeys) {
      delete process.env[key];
    }
  });

  it("loads variables from env file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codefox-env-"));
    const envPath = path.join(dir, ".env");

    await writeFile(envPath, "CODEFOX_TEST_A=alpha\nCODEFOX_TEST_B='beta'\n", "utf8");

    await loadEnvFile(envPath);

    expect(process.env.CODEFOX_TEST_A).toBe("alpha");
    expect(process.env.CODEFOX_TEST_B).toBe("beta");
  });

  it("does not override existing environment variables", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codefox-env-"));
    const envPath = path.join(dir, ".env");

    process.env.CODEFOX_TEST_A = "existing";
    await writeFile(envPath, "CODEFOX_TEST_A=from_file\n", "utf8");

    await loadEnvFile(envPath);

    expect(process.env.CODEFOX_TEST_A).toBe("existing");
  });

  it("ignores missing env file", async () => {
    await expect(loadEnvFile("/tmp/does-not-exist-codefox-env")).resolves.toBeUndefined();
  });
});
