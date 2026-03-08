# AGENTS.md

Treat these as forbidden unless explicitly approved for a single file:
- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `.aws/**`
- `.ssh/**`
- `credentials/**`
- `secrets/**`

## Project
<PROJECT_NAME>

## Objective
Build and maintain a clean, testable Node.js/TypeScript application.

## Node.js baseline

- Use the project-defined Node.js version (LTS unless specified otherwise).
- Use one package manager consistently (`npm`, `pnpm`, or `yarn`).
- Keep and respect the lockfile (`package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`).

## Dependency and scripts discipline

- Keep dependencies minimal and actively maintained.
- Prefer `npm ci` in CI-like flows when lockfile is present.
- Ensure standard scripts exist and are used when relevant:
  - `build`
  - `test`
  - `lint` (if linting is configured)
- If dependencies change, update lockfile in the same task.

## Testing and quality

- Add/update tests alongside behavior changes.
- Keep command output concise and actionable in summaries.
- Report exact commands used and failures clearly.

## Long-horizon docs

- Keep these repo-root docs updated when planning/executing non-trivial work:
  - `SPEC.md`
  - `MILESTONES.md`
  - `RUNBOOK.md`
  - `VERIFY.md`
  - `STATUS.md`
- `STATUS.md` should track progress against `MILESTONES.md`.
- If this repo is managed through CodeFox, `/repo playbook <name>` can scaffold missing docs.

## Scope boundaries

- Do not access or print secret files.
- Do not operate outside the configured repository root.
- Keep changes focused; avoid unrelated refactors.
