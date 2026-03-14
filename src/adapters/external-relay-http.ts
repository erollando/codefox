import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ExternalBindRequest, ExternalCodexEvent, ExternalCodexHandoffBundle } from "../core/external-codex-integration.js";
import { ExternalCodexRelay, type ExternalRouteEntry } from "../core/external-codex-relay.js";

const MAX_BODY_BYTES = 256 * 1024;

export interface ExternalRelayHttpServerOptions {
  relay: ExternalCodexRelay;
  host: string;
  port: number;
  authToken?: string;
  getRoutes: () => ExternalRouteEntry[];
}

export interface ExternalRelayHttpAddress {
  host: string;
  port: number;
}

export class ExternalRelayHttpServer {
  private server: Server | undefined;
  private startedAddress: ExternalRelayHttpAddress | undefined;

  constructor(private readonly options: ExternalRelayHttpServerOptions) {}

  async start(): Promise<ExternalRelayHttpAddress> {
    if (this.server) {
      return this.startedAddress ?? { host: this.options.host, port: this.options.port };
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, this.options.host, () => {
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      this.startedAddress = { host: this.options.host, port: this.options.port };
    } else {
      this.startedAddress = {
        host: address.address,
        port: address.port
      };
    }

    return this.startedAddress;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.server = undefined;
    this.startedAddress = undefined;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.options.authToken) {
      const authorization = req.headers.authorization ?? "";
      if (authorization !== `Bearer ${this.options.authToken}`) {
        sendJson(res, 401, {
          ok: false,
          error: "Unauthorized"
        });
        return;
      }
    }

    this.options.relay.setRoutes(this.options.getRoutes());

    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && url === "/v1/external-codex/routes") {
      sendJson(res, 200, {
        ok: true,
        routes: this.options.relay.listRoutes()
      });
      return;
    }

    if (method === "POST" && url === "/v1/external-codex/bind") {
      const body = await readJson<ExternalBindRequest>(req).catch((error) => {
        sendJson(res, 400, { ok: false, error: String(error) });
        return undefined;
      });
      if (!body) {
        return;
      }

      const decision = this.options.relay.bind(body);
      sendJson(res, decision.ok ? 200 : 400, decision);
      return;
    }

    if (method === "POST" && url === "/v1/external-codex/event") {
      const body = await readJson<ExternalCodexEvent>(req).catch((error) => {
        sendJson(res, 400, { ok: false, error: String(error) });
        return undefined;
      });
      if (!body) {
        return;
      }

      const relay = await this.options.relay.relayEvent(body);
      sendJson(res, relay.decision.ok ? 202 : 400, relay);
      return;
    }

    if (method === "POST" && url === "/v1/external-codex/handoff") {
      const body = await readJson<ExternalCodexHandoffBundle>(req).catch((error) => {
        sendJson(res, 400, { ok: false, error: String(error) });
        return undefined;
      });
      if (!body) {
        return;
      }

      const relay = await this.options.relay.relayHandoff(body);
      sendJson(res, relay.decision.ok ? 202 : 400, relay);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Not found"
    });
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body too large.");
    }
    chunks.push(data);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("Request body is required.");
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}
