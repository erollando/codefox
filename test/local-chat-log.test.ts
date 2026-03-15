import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalChatLog } from "../src/core/local-chat-log.js";

describe("LocalChatLog", () => {
  it("appends and tails messages by chat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codefox-chatlog-"));
    const filePath = path.join(root, "chat.log");
    const log = new LocalChatLog(filePath);

    await log.append({
      chatId: 100,
      userId: 1,
      direction: "inbound",
      channel: "telegram",
      text: "/status"
    });
    await log.append({
      chatId: 100,
      direction: "outbound",
      channel: "telegram",
      text: "Status reply"
    });
    await log.append({
      chatId: 200,
      direction: "outbound",
      channel: "telegram",
      text: "Other chat"
    });

    const chat100 = await log.tail(100, 20);
    expect(chat100).toHaveLength(2);
    expect(chat100.map((entry) => entry.text)).toEqual(["/status", "Status reply"]);
  });

  it("keeps only the newest messages within the configured file cap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codefox-chatlog-cap-"));
    const filePath = path.join(root, "chat.log");
    const log = new LocalChatLog(filePath, 260);

    await log.append({
      chatId: 100,
      direction: "outbound",
      channel: "telegram",
      text: "first message"
    });
    await log.append({
      chatId: 100,
      direction: "outbound",
      channel: "telegram",
      text: "second message"
    });
    await log.append({
      chatId: 100,
      direction: "outbound",
      channel: "telegram",
      text: "third message"
    });

    const retained = await log.tail(100, 20);
    expect(retained.map((entry) => entry.text)).toEqual(["third message"]);
  });
});
