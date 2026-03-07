export interface TelegramUser {
  id: number;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  from?: TelegramUser;
  chat: TelegramChat;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramAdapter {
  start(onUpdate: (update: TelegramUpdate) => Promise<void>): Promise<void>;
  stop(): void;
  sendMessage(chatId: number, text: string): Promise<void>;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
}

const TELEGRAM_MESSAGE_LIMIT = 3900;

export class TelegramPollingAdapter implements TelegramAdapter {
  private offset = 0;
  private running = false;

  constructor(
    private readonly token: string,
    private readonly pollingTimeoutSeconds: number,
    private readonly pollIntervalMs: number,
    private readonly discardBacklogOnStart: boolean = true
  ) {}

  async start(onUpdate: (update: TelegramUpdate) => Promise<void>): Promise<void> {
    this.running = true;
    if (this.discardBacklogOnStart) {
      await this.discardBacklog();
    }

    while (this.running) {
      try {
        const updates = await this.getUpdates();
        if (updates.length === 0) {
          await sleep(this.pollIntervalMs);
          continue;
        }
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await onUpdate(update);
          } catch (error) {
            console.error(`Telegram update handler error: ${String(error)}`);
          }
        }
      } catch (error) {
        console.error(`Telegram polling error: ${String(error)}`);
        await sleep(this.pollIntervalMs);
      }
    }
  }

  async startPolling(onUpdate: (update: TelegramUpdate) => Promise<void>): Promise<void> {
    await this.start(onUpdate);
  }

  stop(): void {
    this.running = false;
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const parts = splitMessage(text, TELEGRAM_MESSAGE_LIMIT);
    if (parts.length === 1) {
      await this.request("sendMessage", {
        chat_id: chatId,
        text: parts[0]
      });
      return;
    }

    for (let i = 0; i < parts.length; i += 1) {
      await this.request("sendMessage", {
        chat_id: chatId,
        text: `[${i + 1}/${parts.length}]\n${parts[i]}`
      });
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const data = await this.request<TelegramUpdate[]>("getUpdates", {
      offset: this.offset,
      timeout: this.pollingTimeoutSeconds
    });

    return data;
  }

  private async discardBacklog(): Promise<void> {
    try {
      const updates = await this.request<TelegramUpdate[]>("getUpdates", {
        offset: -1,
        timeout: 0
      });
      if (updates.length === 0) {
        return;
      }
      const maxUpdateId = Math.max(...updates.map((update) => update.update_id));
      this.offset = maxUpdateId + 1;
    } catch (error) {
      console.error(`Telegram backlog discard error: ${String(error)}`);
    }
  }

  private async request<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Telegram HTTP error ${response.status}`);
    }

    const parsed = (await response.json()) as TelegramApiResponse<T>;
    if (!parsed.ok) {
      throw new Error(`Telegram API error for ${method}`);
    }

    return parsed.result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const breakIndex = candidate.lastIndexOf("\n");
    const splitAt = breakIndex >= Math.floor(maxLength * 0.5) ? breakIndex + 1 : maxLength;
    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}
