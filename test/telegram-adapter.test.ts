import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramPollingAdapter } from "../src/adapters/telegram.js";

describe("TelegramPollingAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues polling when update handler throws", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = _url.split("/").at(-1);
      if (method !== "getUpdates") {
        return {
          ok: true,
          json: async () => ({ ok: true, result: true })
        } as Response;
      }

      const payload = JSON.parse(String(init?.body ?? "{}")) as { offset?: number };
      if (!payload.offset || payload.offset === 0) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  text: "/help",
                  from: { id: 1 },
                  chat: { id: 100 }
                }
              }
            ]
          })
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ ok: true, result: [] })
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramPollingAdapter("token", 1, 1, false);
    let handled = 0;

    const polling = adapter.start(async () => {
      handled += 1;
      throw new Error("handler-failure");
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    adapter.stop();
    await polling;

    expect(handled).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("sends messages through Telegram sendMessage API", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramPollingAdapter("token", 1, 1, false);
    await adapter.sendMessage(100, "hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));

    expect(url).toContain("/sendMessage");
    expect(payload.chat_id).toBe(100);
    expect(payload.text).toBe("hello");
  });

  it("attaches one-tap command keyboard when command buttons are provided", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramPollingAdapter("token", 1, 1, false);
    await adapter.sendMessage(100, "handoff ready", {
      commandButtons: ["Handoff details", "Continue handoff"]
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.reply_markup.keyboard).toEqual([
      [{ text: "Handoff details" }, { text: "Continue handoff" }]
    ]);
    expect(payload.reply_markup.one_time_keyboard).toBe(true);
  });

  it("splits long outgoing messages into multiple Telegram messages", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramPollingAdapter("token", 1, 1, false);
    await adapter.sendMessage(100, "x".repeat(9000));

    expect(fetchMock.mock.calls.length).toBe(3);
    const firstPayload = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const secondPayload = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    const thirdPayload = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));

    expect(String(firstPayload.text)).toContain("[1/3]");
    expect(String(secondPayload.text)).toContain("[2/3]");
    expect(String(thirdPayload.text)).toContain("[3/3]");

    const stripPrefix = (value: string): string => value.replace(/^\[\d+\/\d+\]\n/, "");
    const reassembled = [firstPayload.text, secondPayload.text, thirdPayload.text].map(String).map(stripPrefix).join("");
    expect(reassembled).toBe("x".repeat(9000));
  });

  it("attaches command buttons on the final chunk when message is split", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramPollingAdapter("token", 1, 1, false);
    await adapter.sendMessage(100, "x".repeat(9000), {
      commandButtons: ["/status", "/continue"]
    });

    expect(fetchMock.mock.calls.length).toBe(3);
    const firstPayload = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const secondPayload = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    const thirdPayload = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));

    expect(firstPayload.reply_markup).toBeUndefined();
    expect(secondPayload.reply_markup).toBeUndefined();
    expect(thirdPayload.reply_markup.keyboard).toEqual([[{ text: "/status" }, { text: "/continue" }]]);
  });

  it("discards backlog updates on startup when enabled", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { offset?: number };
      const offset = payload.offset ?? 0;

      if (offset === -1) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 20,
                message: {
                  message_id: 1,
                  text: "/run stale",
                  from: { id: 1 },
                  chat: { id: 100 }
                }
              }
            ]
          })
        } as Response;
      }

      if (offset === 21) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 21,
                message: {
                  message_id: 2,
                  text: "/run fresh",
                  from: { id: 1 },
                  chat: { id: 100 }
                }
              }
            ]
          })
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ ok: true, result: [] })
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramPollingAdapter("token", 1, 1, true);
    const handled: string[] = [];

    const polling = adapter.start(async (update) => {
      handled.push(update.message?.text ?? "");
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    adapter.stop();
    await polling;

    expect(handled).toEqual(["/run fresh"]);
  });
});
