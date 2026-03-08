import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTemplateName } from "../types/domain.js";

export const AGENT_TEMPLATE_NAMES: AgentTemplateName[] = ["python", "java", "nodejs"];
export const PLAYBOOK_FILE_NAMES = [
  "SPEC.md",
  "MILESTONES.md",
  "RUNBOOK.md",
  "VERIFY.md",
  "STATUS.md"
] as const;

export async function applyAgentTemplate(params: {
  repoPath: string;
  templateName: AgentTemplateName;
  templateRootPath?: string;
  overwrite?: boolean;
}): Promise<{
  agentsPath: string;
  written: boolean;
  templatePath: string;
}> {
  const templateRootPath = params.templateRootPath ?? path.resolve(process.cwd(), "templates", "agents");
  const templatePath = path.join(templateRootPath, `${params.templateName}.AGENTS.md`);
  const templateContent = await readFile(templatePath, "utf8");
  const agentsPath = path.join(params.repoPath, "AGENTS.md");
  const current = await readFile(agentsPath, "utf8").catch((error) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  const shouldWrite =
    typeof current === "undefined" || (Boolean(params.overwrite) && current.trimEnd() !== templateContent.trimEnd());
  if (shouldWrite) {
    await writeFile(agentsPath, templateContent, "utf8");
  }

  return {
    agentsPath,
    written: shouldWrite,
    templatePath
  };
}

export async function applyPlaybookDocs(params: {
  repoPath: string;
  repoName: string;
  overwrite?: boolean;
}): Promise<{
  written: string[];
  kept: string[];
}> {
  const written: string[] = [];
  const kept: string[] = [];

  const docs = buildPlaybookDocs(params.repoName);
  for (const [fileName, content] of Object.entries(docs)) {
    const targetPath = path.join(params.repoPath, fileName);
    const existing = await readFile(targetPath, "utf8").catch((error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });

    if (typeof existing === "undefined") {
      await writeFile(targetPath, content, "utf8");
      written.push(fileName);
      continue;
    }

    if (params.overwrite && existing.trimEnd() !== content.trimEnd()) {
      await writeFile(targetPath, content, "utf8");
      written.push(fileName);
      continue;
    }

    kept.push(fileName);
  }

  return { written, kept };
}

function buildPlaybookDocs(repoName: string): Record<(typeof PLAYBOOK_FILE_NAMES)[number], string> {
  return {
    "SPEC.md": [
      "# SPEC",
      "",
      `Project: ${repoName}`,
      "",
      "## Purpose",
      "Define the target behavior, constraints, and non-goals for the current objective.",
      "",
      "## Outcomes",
      "1. Primary functional outcome",
      "2. Safety and quality expectations",
      "3. Validation expectations",
      "",
      "## Non-goals",
      "1. Explicitly list what this effort will not do.",
      "",
      "## Constraints",
      "- Repo/root boundaries",
      "- Security/secret handling",
      "- Platform/runtime constraints",
      "",
      "## Success criteria",
      "1. Measurable acceptance criteria"
    ].join("\n"),
    "MILESTONES.md": [
      "# MILESTONES",
      "",
      `Project: ${repoName}`,
      "",
      "## M1",
      "- Scope:",
      "- Exit criteria:",
      "",
      "## M2",
      "- Scope:",
      "- Exit criteria:",
      "",
      "## M3",
      "- Scope:",
      "- Exit criteria:"
    ].join("\n"),
    "RUNBOOK.md": [
      "# RUNBOOK",
      "",
      `Project: ${repoName}`,
      "",
      "## Execution loop",
      "1. Plan against SPEC + MILESTONES",
      "2. Implement smallest safe change",
      "3. Verify",
      "4. Fix-forward on failures",
      "5. Report outcomes and remaining risk",
      "",
      "## Steering policy",
      "- How mid-task instruction updates are handled",
      "",
      "## Safety policy",
      "- Forbidden paths/secrets handling",
      "- Out-of-scope boundaries"
    ].join("\n"),
    "VERIFY.md": [
      "# VERIFY",
      "",
      `Project: ${repoName}`,
      "",
      "## Mandatory checks",
      "1. Build command",
      "2. Test command",
      "",
      "## Feature-specific checks",
      "1. Parser/command behavior",
      "2. Policy/session transitions",
      "3. Adapter/runtime behavior",
      "",
      "## Manual smoke checks",
      "1. Key command flows",
      "2. Recovery/error paths"
    ].join("\n"),
    "STATUS.md": [
      "# STATUS",
      "",
      `Project: ${repoName}`,
      "",
      "## Milestone status",
      "- M1: pending",
      "- M2: pending",
      "- M3: pending",
      "",
      "## Current state",
      "- Active objective:",
      "- In-progress task:",
      "- Last verification:",
      "- Known risks:",
      "- Next action:"
    ].join("\n")
  };
}
