import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UiDeviceAuthStore } from "../src/core/ui-device-auth.js";

describe("UiDeviceAuthStore", () => {
  it("registers devices and validates tokens", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codefox-ui-auth-"));
    const filePath = path.join(root, "ui-devices.json");
    const store = new UiDeviceAuthStore(filePath);

    expect(await store.count()).toBe(0);

    const device = await store.registerDevice({
      label: "my-phone",
      userAgent: "Mobile Safari"
    });
    expect(device.id).toMatch(/^dev_/);
    expect(device.token.length).toBeGreaterThan(20);
    expect(await store.count()).toBe(1);

    const found = await store.findByToken(device.token);
    expect(found?.id).toBe(device.id);
    expect(found?.label).toBe("my-phone");

    await store.touch(device.id);
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("my-phone");
  });
});
