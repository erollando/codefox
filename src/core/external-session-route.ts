import type { PolicyMode, SessionState } from "../types/domain.js";
import type { ExternalRouteEntry } from "./external-codex-relay.js";

export function buildExternalSessionId(chatId: number, repoName: string, mode: PolicyMode): string {
  return `chat:${chatId}/repo:${repoName}/mode:${mode}`;
}

export function deriveExternalRoutes(sessions: SessionState[]): ExternalRouteEntry[] {
  const routes: ExternalRouteEntry[] = [];
  for (const session of sessions) {
    if (!session.selectedRepo) {
      continue;
    }
    routes.push({
      sessionId: buildExternalSessionId(session.chatId, session.selectedRepo, session.mode),
      chatId: session.chatId
    });
  }
  return routes;
}
