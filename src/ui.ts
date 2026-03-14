import http from "node:http";
import os from "node:os";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { loadEnvFile } from "./core/env.js";
import { loadConfig, resolveConfigPath } from "./core/config.js";
import { JsonStateStore, pruneStateByTtl } from "./core/state-store.js";
import { FileLocalCommandQueue, defaultLocalCommandQueuePath } from "./core/local-command-queue.js";
import { LocalChatLog, defaultLocalChatLogPath } from "./core/local-chat-log.js";
import { getCurrentRevision } from "./core/spec-workflow.js";
import { ensureCodeFoxRunning } from "./core/dev-runtime.js";
import { UiDeviceAuthStore, defaultUiDeviceStorePath } from "./core/ui-device-auth.js";

interface UiArgs {
  configPath?: string;
  host: string;
  port: number;
  userId?: number;
  pairTtlSeconds: number;
}

interface UiStateResponse {
  ok: true;
  selectedChatId?: number;
  sessions: Array<{
    chatId: number;
    repo?: string;
    mode: string;
    activeRequestId?: string;
    updatedAt: string;
  }>;
  selected: {
    chatId: number;
    repo?: string;
    mode: string;
    activeRequestId?: string;
    approvalCount: number;
    spec?: {
      revision: string;
      stage: string;
      status: string;
      updatedAt: string;
    };
    handoff?: {
      id: string;
      taskId: string;
      remainingTotal: number;
      remainingOpen: number;
      next?: string;
    };
    quickCommands: string[];
  } | null;
  messages: Array<{
    id: string;
    timestamp: string;
    direction: "inbound" | "outbound";
    channel: "telegram" | "local";
    text: string;
    commandButtons?: string[];
  }>;
}

await loadEnvFile();

const args = parseArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(args.error ?? "Invalid UI arguments.");
  process.exitCode = 1;
} else {
  const configPath = resolveConfigPath(args.value.configPath);
  const config = await loadConfig(configPath);
  const store = new JsonStateStore(config.state.filePath);
  const queue = new FileLocalCommandQueue(defaultLocalCommandQueuePath(config.state.filePath));
  const chatLog = new LocalChatLog(defaultLocalChatLogPath(config.state.filePath));
  const deviceAuth = new UiDeviceAuthStore(defaultUiDeviceStorePath(config.state.filePath));
  const defaultUserId = args.value.userId ?? config.telegram.allowedUserIds[0];
  const pairCodes = new Map<string, number>();

  if (!defaultUserId) {
    console.error("No allowed user id configured. Set telegram.allowedUserIds or pass --user <id>.");
    process.exitCode = 1;
  } else {
    try {
      const ensured = await ensureCodeFoxRunning({
        resolvedConfigPath: configPath,
        stateFilePath: config.state.filePath
      });
      if (ensured.started) {
        console.log(`CodeFox was not running. Started background service (pid ${ensured.pid}).`);
      }
    } catch (error) {
      console.error(`Failed to auto-start CodeFox runtime: ${String(error)}`);
      process.exitCode = 1;
      process.exit();
    }

    const firstPair = issuePairCode(pairCodes, args.value.pairTtlSeconds);
    const firstPairUrls = buildPairUrls(args.value.host, args.value.port, firstPair.code);

    const server = http.createServer(async (request, response) => {
      try {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", `http://${args.value.host}:${args.value.port}`);
        const remoteAddress = request.socket.remoteAddress ?? "";
        const loopback = isLoopbackAddress(remoteAddress);

        if (method === "GET" && url.pathname === "/pair") {
          const code = url.searchParams.get("code")?.trim() || "";
          if (!consumePairCode(pairCodes, code)) {
            writePairInvalidHtml(response);
            return;
          }
          const device = await deviceAuth.registerDevice({
            userAgent: request.headers["user-agent"]
          });
          setUiDeviceCookie(response, device.token);
          writePairSuccessHtml(response, device.label);
          return;
        }

        const authorized = await isAuthorizedRequest({
          request,
          loopback,
          deviceAuth
        });
        if (!authorized) {
          writeUnauthorizedHtml(response);
          return;
        }

        if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          writeHtml(response);
          return;
        }
        if (method === "GET" && url.pathname === "/api/state") {
          const chatParam = url.searchParams.get("chatId");
          const chatId = toPositiveInteger(chatParam);
          const state = await buildUiState({
            store,
            config,
            chatLog,
            requestedChatId: chatId
          });
          writeJson(response, 200, state);
          return;
        }
        if (method === "POST" && url.pathname === "/api/send") {
          const body = await readJsonBody(request);
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) {
            writeJson(response, 400, { ok: false, error: "text is required." });
            return;
          }
          const explicitChatId = toPositiveInteger(body.chatId);
          const state = await store.load();
          const pruned = pruneStateByTtl(state, {
            sessionTtlHours: config.state.sessionTtlHours,
            approvalTtlHours: config.state.approvalTtlHours
          }).state;
          const resolvedChatId = resolveDefaultChatId(explicitChatId, config.telegram.allowedChatIds ?? [], pruned.sessions);
          if (!resolvedChatId) {
            writeJson(response, 400, {
              ok: false,
              error:
                "Could not determine chatId. Select a session in UI first, or configure a single telegram.allowedChatIds entry."
            });
            return;
          }
          const queued = await queue.enqueue({
            chatId: resolvedChatId,
            userId: defaultUserId,
            text
          });
          writeJson(response, 200, { ok: true, queued });
          return;
        }

        writeJson(response, 404, { ok: false, error: "Not found." });
      } catch (error) {
        writeJson(response, 500, { ok: false, error: String(error) });
      }
    });

    server.listen(args.value.port, args.value.host, async () => {
      console.log(`CodeFox UI ready at http://${args.value.host}:${args.value.port}`);
      console.log("For live logs, optionally run `npm run dev` in another terminal.");
      const existingDevices = await deviceAuth.count();
      console.log(`Paired UI devices: ${existingDevices}.`);
      if (args.value.host === "127.0.0.1" || args.value.host.toLowerCase() === "localhost") {
        console.log("UI is bound to loopback. For phone pairing, restart with: npm run ui -- --host 0.0.0.0 --port 8789");
        return;
      }
      if (firstPairUrls.length > 0) {
        console.log(`Phone pair code TTL: ${args.value.pairTtlSeconds}s.`);
        console.log("Pair link(s):");
        for (const link of firstPairUrls) {
          console.log(`  ${link}`);
        }
        const qrTarget = firstPairUrls[0];
        try {
          const terminalQr = await QRCode.toString(qrTarget, {
            type: "terminal",
            small: true
          });
          console.log("Scan this QR from phone to pair:");
          console.log(terminalQr);
        } catch (error) {
          console.error(`Could not render QR in terminal: ${String(error)}`);
        }
      }
    });
  }
}

function parseArgs(argv: string[]): { ok: true; value: UiArgs } | { ok: false; error: string } {
  let configPath: string | undefined;
  let host = "127.0.0.1";
  let port = 8789;
  let userId: number | undefined;
  let pairTtlSeconds = 600;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    const readRequired = (flag: string): string | undefined => {
      if (!next) {
        return undefined;
      }
      index += 1;
      return next;
    };
    if (token === "--config") {
      const value = readRequired(token);
      if (!value) {
        return { ok: false, error: "Missing value for --config." };
      }
      configPath = value;
      continue;
    }
    if (token === "--host") {
      const value = readRequired(token);
      if (!value) {
        return { ok: false, error: "Missing value for --host." };
      }
      host = value;
      continue;
    }
    if (token === "--port") {
      const value = readRequired(token);
      if (!value) {
        return { ok: false, error: "Missing value for --port." };
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return { ok: false, error: "port must be a positive integer." };
      }
      port = parsed;
      continue;
    }
    if (token === "--user") {
      const value = readRequired(token);
      if (!value) {
        return { ok: false, error: "Missing value for --user." };
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return { ok: false, error: "user must be a positive integer." };
      }
      userId = parsed;
      continue;
    }
    if (token === "--pair-ttl-seconds") {
      const value = readRequired(token);
      if (!value) {
        return { ok: false, error: "Missing value for --pair-ttl-seconds." };
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 30) {
        return { ok: false, error: "pair ttl seconds must be an integer > 30." };
      }
      pairTtlSeconds = parsed;
      continue;
    }
    return { ok: false, error: `Unknown argument '${token}'.` };
  }

  return {
    ok: true,
    value: {
      configPath,
      host,
      port,
      userId,
      pairTtlSeconds
    }
  };
}

async function buildUiState(input: {
  store: JsonStateStore;
  config: Awaited<ReturnType<typeof loadConfig>>;
  chatLog: LocalChatLog;
  requestedChatId?: number;
}): Promise<UiStateResponse> {
  const loaded = await input.store.load();
  const pruned = pruneStateByTtl(loaded, {
    sessionTtlHours: input.config.state.sessionTtlHours,
    approvalTtlHours: input.config.state.approvalTtlHours
  }).state;

  const sortedSessions = [...pruned.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const selectedChatId = resolveDefaultChatId(input.requestedChatId, input.config.telegram.allowedChatIds ?? [], sortedSessions);

  const sessions = sortedSessions.map((session) => ({
    chatId: session.chatId,
    repo: session.selectedRepo,
    mode: session.mode,
    activeRequestId: session.activeRequestId,
    updatedAt: session.updatedAt
  }));

  if (!selectedChatId) {
    return {
      ok: true,
      sessions,
      selected: null,
      messages: []
    };
  }

  const selectedSession = sortedSessions.find((session) => session.chatId === selectedChatId);
  const approvals = pruned.approvals.filter((approval) => approval.chatId === selectedChatId);
  const specEntry = pruned.specWorkflows.find((entry) => entry.chatId === selectedChatId);
  const currentSpec = specEntry ? getCurrentRevision(specEntry.workflow) : undefined;
  const handoff = pruned.externalHandoffs.find((entry) => entry.chatId === selectedChatId);
  const remainingOpen = handoff
    ? handoff.handoff.remainingWork.filter((item) => !handoff.continuedWorkIds.includes(item.id)).length
    : 0;
  const nextWork = handoff
    ? handoff.handoff.remainingWork.find((item) => !handoff.continuedWorkIds.includes(item.id))
    : undefined;

  const messages = await input.chatLog.tail(selectedChatId, 80);

  return {
    ok: true,
    selectedChatId,
    sessions,
    selected: {
      chatId: selectedChatId,
      repo: selectedSession?.selectedRepo,
      mode: selectedSession?.mode ?? "observe",
      activeRequestId: selectedSession?.activeRequestId,
      approvalCount: approvals.length,
      spec: currentSpec
        ? {
            revision: `v${currentSpec.version}`,
            stage: currentSpec.stage,
            status: currentSpec.status,
            updatedAt: currentSpec.updatedAt
          }
        : undefined,
      handoff: handoff
        ? {
            id: handoff.handoff.handoffId,
            taskId: handoff.handoff.taskId,
            remainingTotal: handoff.handoff.remainingWork.length,
            remainingOpen,
            next: nextWork ? `${nextWork.id}: ${nextWork.summary}` : undefined
          }
        : undefined,
      quickCommands: buildQuickCommands(Boolean(selectedSession?.activeRequestId), approvals.length > 0, remainingOpen > 0)
    },
    messages: messages.map((message) => ({
      id: message.id,
      timestamp: message.timestamp,
      direction: message.direction,
      channel: message.channel,
      text: message.text,
      commandButtons: message.commandButtons
    }))
  };
}

function buildQuickCommands(activeRequest: boolean, hasApproval: boolean, hasOutstandingHandoff: boolean): string[] {
  if (hasApproval) {
    return ["/approve", "/deny", "/pending", "/status", "/service stop"];
  }
  if (activeRequest) {
    return ["/abort", "/status", "/details", "/service stop"];
  }
  if (hasOutstandingHandoff) {
    return ["/continue", "/handoff show", "/status", "/service stop"];
  }
  return ["/status", "/details", "/pending", "/handoff show", "/service stop"];
}

function resolveDefaultChatId(
  explicitChatId: number | undefined,
  allowedChatIds: number[],
  sessions: Array<{ chatId: number; updatedAt: string }>
): number | undefined {
  if (explicitChatId) {
    return explicitChatId;
  }
  if (allowedChatIds.length === 1) {
    return allowedChatIds[0];
  }
  const latest = [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return latest?.chatId;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 512 * 1024) {
      throw new Error("Request body too large.");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeHtml(response: http.ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(UI_HTML);
}

function issuePairCode(store: Map<string, number>, ttlSeconds: number): { code: string; expiresAtMs: number } {
  const code = randomBytes(18).toString("hex");
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  store.set(code, expiresAtMs);
  return {
    code,
    expiresAtMs
  };
}

function consumePairCode(store: Map<string, number>, code: string): boolean {
  if (!code) {
    return false;
  }
  const expiresAt = store.get(code);
  if (!expiresAt) {
    return false;
  }
  store.delete(code);
  if (Date.now() > expiresAt) {
    return false;
  }
  return true;
}

function buildPairUrls(host: string, port: number, code: string): string[] {
  const normalizedHost = host.trim().toLowerCase();
  if (!code) {
    return [];
  }
  if (normalizedHost === "127.0.0.1" || normalizedHost === "localhost") {
    return [`http://127.0.0.1:${port}/pair?code=${code}`];
  }
  if (normalizedHost === "0.0.0.0") {
    const candidates = getLanIpv4Addresses();
    return candidates.map((ip) => `http://${ip}:${port}/pair?code=${code}`);
  }
  return [`http://${host}:${port}/pair?code=${code}`];
}

function getLanIpv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses = new Set<string>();
  for (const list of Object.values(interfaces)) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (item.family !== "IPv4" || item.internal) {
        continue;
      }
      addresses.add(item.address);
    }
  }
  return [...addresses];
}

function isLoopbackAddress(address: string): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.trim().toLowerCase();
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1";
}

async function isAuthorizedRequest(input: {
  request: http.IncomingMessage;
  loopback: boolean;
  deviceAuth: UiDeviceAuthStore;
}): Promise<boolean> {
  if (input.loopback) {
    return true;
  }
  const cookies = parseCookies(input.request.headers.cookie);
  const token = cookies.codefox_ui_device;
  if (!token) {
    return false;
  }
  const device = await input.deviceAuth.findByToken(token);
  if (!device) {
    return false;
  }
  void input.deviceAuth.touch(device.id);
  return true;
}

function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue || headerValue.trim().length === 0) {
    return {};
  }
  const parts = headerValue.split(";");
  const result: Record<string, string> = {};
  for (const part of parts) {
    const raw = part.trim();
    if (!raw) {
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!key) {
      continue;
    }
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function setUiDeviceCookie(response: http.ServerResponse, token: string): void {
  const cookie = [
    `codefox_ui_device=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=15552000"
  ].join("; ");
  response.setHeader("set-cookie", cookie);
}

function writePairSuccessHtml(response: http.ServerResponse, label: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeFox Pairing</title></head>
<body style="font-family:Segoe UI,system-ui,sans-serif;padding:18px;">
  <h2>Device Paired</h2>
  <p>This browser is now authorized as <strong>${escapeHtml(label)}</strong>.</p>
  <p>Opening CodeFox UI...</p>
  <script>setTimeout(() => { window.location.href = "/"; }, 400);</script>
</body></html>`);
}

function writePairInvalidHtml(response: http.ServerResponse): void {
  response.statusCode = 400;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeFox Pairing</title></head>
<body style="font-family:Segoe UI,system-ui,sans-serif;padding:18px;">
  <h2>Pairing Link Invalid</h2>
  <p>This QR/link is expired or already used.</p>
  <p>Generate a new pair code from the laptop terminal by restarting <code>npm run ui</code>.</p>
</body></html>`);
}

function writeUnauthorizedHtml(response: http.ServerResponse): void {
  response.statusCode = 401;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeFox UI Auth</title></head>
<body style="font-family:Segoe UI,system-ui,sans-serif;padding:18px;">
  <h2>Device Not Paired</h2>
  <p>This device is not authorized for remote UI access.</p>
  <p>On the laptop terminal where <code>npm run ui</code> is running, scan the printed QR code from this phone.</p>
</body></html>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>CodeFox UI</title>
  <style>
    :root {
      --bg-top: #f8fafc;
      --bg-bottom: #edf2f7;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --line: #d8e2ee;
      --line-strong: #b6c6d9;
      --brand: #0f766e;
      --brand-soft: #d8f3ef;
      --brand-soft-2: #effaf8;
      --shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
    }
    html, body { height: 100%; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: linear-gradient(180deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
      color: var(--text);
      min-height: 100dvh;
      height: 100dvh;
      overflow: hidden;
    }
    .shell {
      max-width: 1240px;
      margin: 0 auto;
      padding: 18px;
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 14px;
      height: 100dvh;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }
    .sessions {
      padding: 12px;
      min-height: 0;
      overflow: auto;
    }
    #sessions { display: grid; gap: 10px; }
    .session-item {
      width: 100%;
      text-align: left;
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: border-color 120ms ease, transform 120ms ease, background-color 120ms ease;
    }
    .session-item:hover {
      border-color: var(--line-strong);
      transform: translateY(-1px);
    }
    .session-item.active {
      border-color: var(--brand);
      background: linear-gradient(180deg, var(--brand-soft) 0%, #e8faf7 100%);
    }
    .tiny {
      color: var(--muted);
      font-size: 12px;
    }
    .main {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .context,
    .composer {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }
    .context {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      background: #fbfdff;
      padding: 9px 12px;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 11px;
      background: #fff;
      color: #1e293b;
    }
    .quick {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      align-items: center;
      align-content: flex-start;
      background: #fdfefe;
    }
    .quick button,
    .composer button {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      border-radius: 999px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
      min-height: 28px;
      transition: border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
    }
    .quick button:hover,
    .composer button:hover {
      border-color: var(--brand);
      background: #f9fdfd;
      transform: translateY(-1px);
    }
    .feed {
      overflow: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: linear-gradient(180deg, #f8fbff 0%, #fdfefe 100%);
      min-height: 0;
    }
    .msg {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 9px 10px;
      background: #fff;
      box-shadow: 0 2px 10px rgba(15, 23, 42, 0.03);
    }
    .msg.outbound {
      border-left: 4px solid #0369a1;
    }
    .msg.inbound {
      border-left: 4px solid var(--brand);
    }
    .msg pre {
      margin: 5px 0 0;
      white-space: pre-wrap;
      font-family: "IBM Plex Mono", "Cascadia Code", monospace;
      font-size: 12px;
      line-height: 1.45;
    }
    .composer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      border-bottom: 0;
      background: #fff;
    }
    .composer input {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 11px 12px;
      font-size: 14px;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .composer input:focus {
      border-color: var(--brand);
      box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
    }
    .composer button {
      background: var(--brand);
      color: #fff;
      border-color: var(--brand);
      border-radius: 12px;
      padding: 0 16px;
      min-height: 42px;
      font-size: 13px;
    }
    @media (max-width: 860px) {
      .shell {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
        padding: 10px;
        gap: 10px;
        height: 100dvh;
      }
      .sessions {
        max-height: 116px;
        padding: 8px;
        overflow-x: auto;
        overflow-y: hidden;
      }
      #sessions {
        display: flex;
        gap: 8px;
      }
      .session-item {
        min-width: 210px;
        margin-bottom: 0;
      }
      .main {
        min-height: 0;
        height: 100%;
      }
      .context,
      .quick,
      .composer {
        padding-left: 10px;
        padding-right: 10px;
      }
      .quick {
        gap: 5px;
      }
    }
    body.mobile-mode .shell {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
      padding: 10px;
      gap: 10px;
      height: 100dvh;
    }
    body.mobile-mode .sessions {
      max-height: 116px;
      padding: 8px;
      overflow-x: auto;
      overflow-y: hidden;
    }
    body.mobile-mode #sessions {
      display: flex;
      gap: 8px;
    }
    body.mobile-mode .session-item {
      min-width: 210px;
      margin-bottom: 0;
    }
    body.mobile-mode .main {
      min-height: 0;
      height: 100%;
    }
    body.mobile-mode .context,
    body.mobile-mode .quick,
    body.mobile-mode .composer {
      padding-left: 10px;
      padding-right: 10px;
    }
    body.mobile-mode .quick {
      gap: 5px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="card sessions">
      <div id="sessions"></div>
    </aside>
    <section class="card main">
      <div class="context" id="context"></div>
      <div class="quick" id="quick"></div>
      <div class="feed" id="feed"></div>
      <form class="composer" id="composer">
        <input id="input" type="text" placeholder="Type plain text or /command..." />
        <button type="submit">Send</button>
      </form>
    </section>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const forcedMobile = params.get("mobile") === "1";
    if (forcedMobile) {
      document.body.classList.add("mobile-mode");
    }
    let selectedChatId;
    let lastMessageFingerprint = "";
    let forceScrollToBottom = true;
    let userNearBottom = true;
    const SCROLL_BOTTOM_THRESHOLD_PX = 48;
    const sessionsEl = document.getElementById("sessions");
    const contextEl = document.getElementById("context");
    const quickEl = document.getElementById("quick");
    const feedEl = document.getElementById("feed");
    const composerEl = document.getElementById("composer");
    const inputEl = document.getElementById("input");

    if (feedEl) {
      feedEl.addEventListener("scroll", () => {
        userNearBottom = isFeedNearBottom();
      });
    }

    async function fetchState() {
      const query = selectedChatId ? "?chatId=" + selectedChatId : "";
      const response = await fetch("/api/state" + query);
      const data = await response.json();
      if (!data.ok) {
        return;
      }
      selectedChatId = data.selectedChatId || selectedChatId;
      render(data);
    }

    function render(data) {
      const nextFingerprint = buildMessageFingerprint(data.messages || []);
      const hasNewMessages = nextFingerprint !== lastMessageFingerprint;
      lastMessageFingerprint = nextFingerprint;

      sessionsEl.innerHTML = "";
      for (const session of data.sessions) {
        const button = document.createElement("button");
        button.className = "session-item" + (session.chatId === selectedChatId ? " active" : "");
        button.innerHTML =
          "<strong>chat " + session.chatId + "</strong><br>" +
          "<span class='tiny'>repo=" + (session.repo || "(none)") + " mode=" + session.mode + "</span>";
        button.onclick = () => {
          selectedChatId = session.chatId;
          forceScrollToBottom = true;
          fetchState();
        };
        sessionsEl.appendChild(button);
      }

      const selected = data.selected;
      if (!selected) {
        contextEl.innerHTML = "<span class='tiny'>No active session yet. Start from Telegram, REPL, or handoff.</span>";
        quickEl.innerHTML = "";
        feedEl.innerHTML = "<div class='tiny'>No messages yet.</div>";
        forceScrollToBottom = false;
        return;
      }

      const pills = [];
      if (selected.activeRequestId) {
        pills.push("<span class='pill'>active: " + selected.activeRequestId + "</span>");
      }
      pills.push("<span class='pill'>approvals: " + selected.approvalCount + "</span>");
      if (selected.spec) {
        pills.push("<span class='pill'>spec: " + selected.spec.revision + " (" + selected.spec.stage + ")</span>");
      }
      if (selected.handoff) {
        pills.push("<span class='pill'>handoff: " + selected.handoff.remainingOpen + "/" + selected.handoff.remainingTotal + " open</span>");
      }
      contextEl.innerHTML = pills.join("");

      quickEl.innerHTML = "";
      for (const command of selected.quickCommands) {
        const button = document.createElement("button");
        button.textContent = formatCommandLabel(command);
        button.onclick = () => sendText(command);
        quickEl.appendChild(button);
      }

      feedEl.innerHTML = "";
      if (!data.messages || data.messages.length === 0) {
        feedEl.innerHTML = "<div class='tiny'>No messages yet.</div>";
      } else {
        for (const message of data.messages) {
          const card = document.createElement("div");
          card.className = "msg " + message.direction;
          const header = document.createElement("div");
          header.className = "tiny";
          header.textContent = message.timestamp + " • " + message.channel + " • " + message.direction;
          const body = document.createElement("pre");
          body.textContent = message.text;
          card.appendChild(header);
          card.appendChild(body);
          feedEl.appendChild(card);
        }
      }
      if (shouldAutoScroll(hasNewMessages)) {
        feedEl.scrollTop = feedEl.scrollHeight;
        userNearBottom = true;
      }
      forceScrollToBottom = false;
    }

    async function sendText(text) {
      if (!text || !text.trim()) {
        return;
      }
      const payload = { text: text.trim(), chatId: selectedChatId };
      const response = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!data.ok) {
        alert(data.error || "Failed to send command.");
        return;
      }
      inputEl.value = "";
      forceScrollToBottom = true;
      await fetchState();
    }

    function formatCommandLabel(command) {
      if (typeof command !== "string") {
        return "";
      }
      return command.startsWith("/") ? command.slice(1) : command;
    }

    function buildMessageFingerprint(messages) {
      if (!Array.isArray(messages) || messages.length === 0) {
        return "empty";
      }
      const last = messages[messages.length - 1];
      return String(messages.length) + ":" + String(last.id || "") + ":" + String(last.timestamp || "");
    }

    function isFeedNearBottom() {
      if (!feedEl) {
        return true;
      }
      const distance = feedEl.scrollHeight - (feedEl.scrollTop + feedEl.clientHeight);
      return distance <= SCROLL_BOTTOM_THRESHOLD_PX;
    }

    function shouldAutoScroll(hasNewMessages) {
      if (forceScrollToBottom) {
        return true;
      }
      return hasNewMessages && userNearBottom;
    }

    composerEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      await sendText(inputEl.value);
    });

    fetchState();
    setInterval(fetchState, 1500);
  </script>
</body>
</html>`;
