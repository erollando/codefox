import type { CodexChangelogStateSnapshot } from "../types/domain.js";

export const CODEX_CHANGELOG_SOURCE_URL = "https://developers.openai.com/codex/changelog/rss.xml";

export type CodexChangelogImpactCategory = "config" | "session" | "policy" | "multimodal" | "operator";
export type CodexChangelogDecision = "implement now" | "document only" | "no action";

export interface CodexChangelogEntry {
  id: string;
  title: string;
  link?: string;
  publishedAt?: string;
  summary: string;
}

export interface CodexChangelogImpactHint {
  category: CodexChangelogImpactCategory;
  rationale: string;
  suggestedChange: string;
}

export interface CodexChangelogEntryAssessment extends CodexChangelogEntry {
  impactHints: CodexChangelogImpactHint[];
  decision: CodexChangelogDecision;
}

export interface CodexChangelogCheckResult {
  sourceUrl: string;
  checkedAt: string;
  latestEntry?: CodexChangelogEntry;
  newEntries: CodexChangelogEntryAssessment[];
  state: CodexChangelogStateSnapshot;
}

export interface CodexChangelogTracker {
  check(previous?: CodexChangelogStateSnapshot): Promise<CodexChangelogCheckResult>;
}

interface FeedEntry {
  title: string;
  link?: string;
  guid?: string;
  description?: string;
  pubDate?: string;
}

interface ImpactRule {
  category: CodexChangelogImpactCategory;
  keywords: string[];
  suggestedChange: string;
}

const IMPACT_RULES: ImpactRule[] = [
  {
    category: "config",
    keywords: ["flag", "flags", "config", "configuration", "model", "profile", "reasoning", "env", "environment"],
    suggestedChange: "Review whether this should change CodeFox's exposed codex config surface or safe defaults."
  },
  {
    category: "session",
    keywords: ["session", "resume", "thread", "steer", "steering", "continue", "inject", "interrupt", "handoff"],
    suggestedChange: "Check whether session continuity, resume, or steer fallback behavior should be updated."
  },
  {
    category: "policy",
    keywords: ["sandbox", "approval", "permission", "policy", "write", "read-only", "danger-full-access", "security"],
    suggestedChange: "Re-evaluate policy, sandbox mapping, approvals, or safety messaging for this capability."
  },
  {
    category: "multimodal",
    keywords: ["image", "images", "vision", "file", "files", "document", "documents", "attachment", "audio", "multimodal"],
    suggestedChange: "Assess whether Telegram/local attachment handling should expose this Codex capability."
  },
  {
    category: "operator",
    keywords: ["cli", "terminal", "interactive", "output", "ui", "display", "message", "messages", "docs", "documentation"],
    suggestedChange: "Review README/OPERATIONS/help output so operator UX stays aligned with Codex behavior."
  }
];

export class RssCodexChangelogTracker implements CodexChangelogTracker {
  constructor(
    private readonly sourceUrl: string = CODEX_CHANGELOG_SOURCE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async check(previous?: CodexChangelogStateSnapshot): Promise<CodexChangelogCheckResult> {
    const response = await this.fetchImpl(this.sourceUrl, {
      headers: {
        accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1"
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    const xml = await response.text();
    const entries = parseRssEntries(xml);
    const latestEntry = entries[0];
    const seenIds = new Set(previous?.seenEntryIds ?? []);
    const checkedAt = this.now();
    const newEntries = entries.filter((entry) => !seenIds.has(entry.id)).map(assessEntry);

    return {
      sourceUrl: this.sourceUrl,
      checkedAt,
      latestEntry,
      newEntries,
      state: {
        sourceUrl: this.sourceUrl,
        seenEntryIds: entries.map((entry) => entry.id).slice(0, 100),
        lastCheckedAt: checkedAt,
        latestEntryId: latestEntry?.id,
        latestEntryTitle: latestEntry?.title,
        latestEntryPublishedAt: latestEntry?.publishedAt
      }
    };
  }
}

export function parseRssEntries(xml: string): CodexChangelogEntry[] {
  const entries: CodexChangelogEntry[] = [];
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const item of itemMatches) {
    const rawEntry = parseFeedEntry(item);
    const title = cleanText(rawEntry.title);
    const link = cleanText(rawEntry.link);
    const summary = cleanText(stripHtml(stripCdata(rawEntry.description ?? "")));
    const publishedAt = normalizeDate(rawEntry.pubDate);
    const id = cleanText(rawEntry.guid) || link || [title, publishedAt].filter(Boolean).join("#");
    if (!id || !title) {
      continue;
    }
    entries.push({
      id,
      title,
      link: link || undefined,
      publishedAt,
      summary
    });
  }

  return entries;
}

export function assessEntry(entry: CodexChangelogEntry): CodexChangelogEntryAssessment {
  const content = `${entry.title}\n${entry.summary}`.toLowerCase();
  const impactHints = IMPACT_RULES.flatMap((rule) => {
    const matched = rule.keywords.filter((keyword) => content.includes(keyword));
    if (matched.length === 0) {
      return [];
    }
    return [
      {
        category: rule.category,
        rationale: `matched keywords: ${matched.slice(0, 3).join(", ")}`,
        suggestedChange: rule.suggestedChange
      } satisfies CodexChangelogImpactHint
    ];
  });

  if (impactHints.length === 0) {
    impactHints.push({
      category: "operator",
      rationale: "no direct config/session/policy/multimodal keywords matched",
      suggestedChange: "Record the item, then revisit only if later operator/docs drift appears."
    });
  }

  return {
    ...entry,
    impactHints,
    decision: decideImpact(impactHints)
  };
}

function decideImpact(hints: CodexChangelogImpactHint[]): CodexChangelogDecision {
  if (hints.some((hint) => hint.category === "config" || hint.category === "session" || hint.category === "policy" || hint.category === "multimodal")) {
    return "implement now";
  }
  if (hints.some((hint) => hint.category === "operator" && hint.rationale !== "no direct config/session/policy/multimodal keywords matched")) {
    return "document only";
  }
  return "no action";
}

function parseFeedEntry(itemXml: string): FeedEntry {
  return {
    title: extractTag(itemXml, "title") ?? "",
    link: extractTag(itemXml, "link"),
    guid: extractTag(itemXml, "guid"),
    description: extractTag(itemXml, "description"),
    pubDate: extractTag(itemXml, "pubDate")
  };
}

function extractTag(xml: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = pattern.exec(xml);
  return match?.[1];
}

function cleanText(input: string | undefined): string {
  if (!input) {
    return "";
  }
  return decodeXmlEntities(stripCdata(input))
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function stripCdata(input: string): string {
  return input.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ");
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeDate(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}
