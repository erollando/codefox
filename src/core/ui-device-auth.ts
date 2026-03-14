import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface UiDeviceRecord {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent?: string;
}

interface UiDeviceStore {
  devices: UiDeviceRecord[];
}

const EMPTY_STORE: UiDeviceStore = {
  devices: []
};

export class UiDeviceAuthStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async count(): Promise<number> {
    const store = await this.load();
    return store.devices.length;
  }

  async findByToken(token: string): Promise<{ id: string; label: string } | undefined> {
    const normalized = token.trim();
    if (!normalized) {
      return undefined;
    }
    const hash = hashToken(normalized);
    const store = await this.load();
    const device = store.devices.find((entry) => entry.tokenHash === hash);
    if (!device) {
      return undefined;
    }
    return {
      id: device.id,
      label: device.label
    };
  }

  async registerDevice(input: { label?: string; userAgent?: string }): Promise<{ token: string; id: string; label: string }> {
    const token = randomToken(32);
    const now = new Date().toISOString();
    const id = `dev_${randomToken(6)}`;
    const store = await this.load();
    const nextNumber = store.devices.length + 1;
    const label = (input.label?.trim() || `mobile-${nextNumber}`).slice(0, 64);
    const device: UiDeviceRecord = {
      id,
      label,
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
      userAgent: input.userAgent?.slice(0, 240)
    };
    const next: UiDeviceStore = {
      devices: [...store.devices, device]
    };
    await this.save(next);
    return {
      token,
      id,
      label
    };
  }

  async touch(deviceId: string): Promise<void> {
    const store = await this.load();
    let changed = false;
    const updated = store.devices.map((device) => {
      if (device.id !== deviceId) {
        return device;
      }
      changed = true;
      return {
        ...device,
        lastSeenAt: new Date().toISOString()
      };
    });
    if (!changed) {
      return;
    }
    await this.save({
      devices: updated
    });
  }

  private async load(): Promise<UiDeviceStore> {
    await this.writeQueue;
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      return EMPTY_STORE;
    }
    try {
      const parsed = JSON.parse(raw) as UiDeviceStore;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.devices)) {
        return EMPTY_STORE;
      }
      return {
        devices: parsed.devices
          .filter((entry) => entry && typeof entry.id === "string" && typeof entry.tokenHash === "string")
          .map((entry) => ({
            id: entry.id,
            label: typeof entry.label === "string" ? entry.label : "mobile",
            tokenHash: entry.tokenHash,
            createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
            lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : new Date().toISOString(),
            userAgent: typeof entry.userAgent === "string" ? entry.userAgent : undefined
          }))
      };
    } catch {
      return EMPTY_STORE;
    }
  }

  private async save(store: UiDeviceStore): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const parentDir = path.dirname(this.filePath);
      await mkdir(parentDir, { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });
    await this.writeQueue;
  }
}

export function defaultUiDeviceStorePath(stateFilePath: string): string {
  return path.join(path.dirname(path.resolve(stateFilePath)), "ui-devices.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
