# Agent Templates

This folder provides starter `AGENTS.md` templates for downstream repositories.

Current templates:

- `python.AGENTS.md`
- `java.AGENTS.md`
- `nodejs.AGENTS.md`

How to use:

1. Copy the template that matches your project language into the target repo as `AGENTS.md`.
2. Edit project-specific sections (goal, scope, constraints, stack).
3. Keep safety rules explicit (forbidden secret paths, approval behavior, repo boundaries).
4. Keep long-horizon docs (`SPEC.md`, `MILESTONES.md`, `RUNBOOK.md`, `VERIFY.md`, `STATUS.md`) in repo root and aligned with active work.

These templates are intentionally thin and practical. They guide Codex behavior without reimplementing an agent runtime in CodeFox.
