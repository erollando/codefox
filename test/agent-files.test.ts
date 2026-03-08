import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLAYBOOK_FILE_NAMES, applyAgentTemplate, applyPlaybookDocs } from "../src/core/agent-files.js";

describe("agent files", () => {
  it("writes AGENTS.md from selected template and keeps existing file by default", async () => {
    const repoPath = await mkdtemp(path.join(os.tmpdir(), "codefox-agent-template-"));

    const first = await applyAgentTemplate({
      repoPath,
      templateName: "python"
    });
    expect(first.written).toBe(true);
    const initial = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");
    expect(initial.toLowerCase()).toContain("python");

    await writeFile(path.join(repoPath, "AGENTS.md"), "# custom local agents\n", "utf8");
    const second = await applyAgentTemplate({
      repoPath,
      templateName: "java"
    });
    const current = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");

    expect(second.written).toBe(false);
    expect(current).toBe("# custom local agents\n");
  });

  it("writes playbook docs and keeps existing files unless overwrite is requested", async () => {
    const repoPath = await mkdtemp(path.join(os.tmpdir(), "codefox-playbook-template-"));

    const first = await applyPlaybookDocs({
      repoPath,
      repoName: "demo-repo"
    });

    expect(first.written.sort()).toEqual([...PLAYBOOK_FILE_NAMES].sort());
    expect(first.kept).toEqual([]);
    const firstStatus = await readFile(path.join(repoPath, "STATUS.md"), "utf8");
    expect(firstStatus).toContain("Milestone status");

    await writeFile(path.join(repoPath, "STATUS.md"), "# custom status\n", "utf8");
    const second = await applyPlaybookDocs({
      repoPath,
      repoName: "demo-repo"
    });
    const secondStatus = await readFile(path.join(repoPath, "STATUS.md"), "utf8");
    expect(second.written).toEqual([]);
    expect(second.kept.sort()).toEqual([...PLAYBOOK_FILE_NAMES].sort());
    expect(secondStatus).toBe("# custom status\n");

    const third = await applyPlaybookDocs({
      repoPath,
      repoName: "demo-repo",
      overwrite: true
    });
    const thirdStatus = await readFile(path.join(repoPath, "STATUS.md"), "utf8");
    expect(third.written).toEqual(["STATUS.md"]);
    expect(third.kept.sort()).toEqual(
      PLAYBOOK_FILE_NAMES.filter((name) => name !== "STATUS.md").sort()
    );
    expect(thirdStatus).toContain("Milestone status");
  });
});
