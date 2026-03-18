import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export interface TelegramUser {
  id: number;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface DownloadedTelegramFile {
  localPath: string;
  originalName?: string;
  mimeType?: string;
}

export interface TelegramSendOptions {
  commandButtons?: string[];
}

export interface TelegramAdapter {
  start(onUpdate: (update: TelegramUpdate) => Promise<void>): Promise<void>;
  stop(): void;
  sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<void>;
  downloadFile(fileId: string, metadata?: { originalName?: string; mimeType?: string }): Promise<DownloadedTelegramFile>;
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

  async sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<void> {
    const parts = splitMessage(text, TELEGRAM_MESSAGE_LIMIT);
    const replyMarkup = resolveReplyMarkup(options?.commandButtons);
    if (parts.length === 1) {
      await this.request("sendMessage", {
        chat_id: chatId,
        text: parts[0],
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
      return;
    }

    for (let i = 0; i < parts.length; i += 1) {
      await this.request("sendMessage", {
        chat_id: chatId,
        text: `[${i + 1}/${parts.length}]\n${parts[i]}`,
        ...(i === parts.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {})
      });
    }
  }

  async downloadFile(
    fileId: string,
    metadata?: { originalName?: string; mimeType?: string }
  ): Promise<DownloadedTelegramFile> {
    const file = await this.request<TelegramFile>("getFile", {
      file_id: fileId
    });

    if (!file.file_path) {
      throw new Error(`Telegram getFile did not return file_path for ${fileId}`);
    }

    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) {
      throw new Error(`Telegram file download HTTP error ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const baseName = metadata?.originalName?.trim() || path.basename(file.file_path) || `${fileId}.bin`;
    const safeBaseName = sanitizeFileName(baseName);
    const targetDir = path.join(os.tmpdir(), "codefox-uploads");
    await mkdir(targetDir, { recursive: true });
    const localPath = path.join(targetDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBaseName}`);
    await writeFile(localPath, bytes);

    return {
      localPath,
      originalName: metadata?.originalName,
      mimeType: metadata?.mimeType
    };
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

function resolveReplyMarkup(commands?: string[]): Record<string, unknown> | undefined {
  if (!Array.isArray(commands)) {
    return {
      remove_keyboard: true
    };
  }
  const buttons = commands.map((entry) => entry.trim()).filter(Boolean);
  if (buttons.length === 0) {
    return {
      remove_keyboard: true
    };
  }
  return buildCommandKeyboard(buttons);
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
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

function sanitizeFileName(name: string): string {
  const normalized = name.replace(/[^\w.\-]+/g, "_");
  return normalized.length > 0 ? normalized : "file.bin";
}

function buildCommandKeyboard(commands: string[]): Record<string, unknown> {
  const buttons = [...new Set(commands.map((entry) => entry.trim()).filter(Boolean))];
  const rows: Array<Array<{ text: string }>> = [];
  for (let index = 0; index < buttons.length; index += 2) {
    const first = buttons[index];
    const second = buttons[index + 1];
    rows.push(second ? [{ text: first }, { text: second }] : [{ text: first }]);
  }
  return {
    keyboard: rows,
    one_time_keyboard: false,
    is_persistent: true,
    resize_keyboard: true
  };
}
