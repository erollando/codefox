import { describe, expect, it } from "vitest";
import { assessEntry, parseRssEntries, RssCodexChangelogTracker } from "../src/core/codex-changelog.js";

describe("codex changelog tracker", () => {
  it("parses RSS items into normalized entries", () => {
    const entries = parseRssEntries(`
      <rss>
        <channel>
          <item>
            <title><![CDATA[Codex adds image input flag]]></title>
            <link>https://developers.openai.com/codex/changelog/item-1</link>
            <guid>item-1</guid>
            <pubDate>Sat, 15 Mar 2026 12:00:00 GMT</pubDate>
            <description><![CDATA[Adds <b>image</b> support with a new CLI flag.]]></description>
          </item>
        </channel>
      </rss>
    `);

    expect(entries).toEqual([
      {
        id: "item-1",
        title: "Codex adds image input flag",
        link: "https://developers.openai.com/codex/changelog/item-1",
        publishedAt: "2026-03-15T12:00:00.000Z",
        summary: "Adds image support with a new CLI flag."
      }
    ]);
  });

  it("classifies likely CodeFox impact hints", () => {
    const assessed = assessEntry({
      id: "item-1",
      title: "Codex adds image input flag",
      summary: "Adds image support with a new CLI flag.",
      publishedAt: "2026-03-15T12:00:00.000Z"
    });

    expect(assessed.decision).toBe("implement now");
    expect(assessed.impactHints.map((hint) => hint.category)).toEqual(
      expect.arrayContaining(["config", "multimodal", "operator"])
    );
  });

  it("reports only unseen entries and updates the persisted baseline", async () => {
    const tracker = new RssCodexChangelogTracker(
      "https://developers.openai.com/codex/changelog/rss.xml",
      async () =>
        new Response(
          `<rss><channel>
            <item>
              <title>Codex adds image input flag</title>
              <link>https://developers.openai.com/codex/changelog/item-2</link>
              <guid>item-2</guid>
              <pubDate>Sat, 15 Mar 2026 12:00:00 GMT</pubDate>
              <description>Adds image support with a new CLI flag.</description>
            </item>
            <item>
              <title>Codex improves session resume</title>
              <link>https://developers.openai.com/codex/changelog/item-1</link>
              <guid>item-1</guid>
              <pubDate>Fri, 14 Mar 2026 12:00:00 GMT</pubDate>
              <description>Resume now preserves more session context.</description>
            </item>
          </channel></rss>`,
          { status: 200 }
        ),
      () => "2026-03-15T13:00:00.000Z"
    );

    const result = await tracker.check({
      sourceUrl: "https://developers.openai.com/codex/changelog/rss.xml",
      seenEntryIds: ["item-1"],
      lastCheckedAt: "2026-03-14T12:00:00.000Z"
    });

    expect(result.newEntries).toHaveLength(1);
    expect(result.newEntries[0]?.id).toBe("item-2");
    expect(result.state.seenEntryIds).toEqual(["item-2", "item-1"]);
    expect(result.state.lastCheckedAt).toBe("2026-03-15T13:00:00.000Z");
  });
});
