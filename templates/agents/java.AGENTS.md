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
Build and maintain a clean, testable Java project.

## Java baseline

- Use the project-defined Java version (JDK) and keep it explicit.
- Prefer project wrapper commands:
  - Maven: `./mvnw` (Linux/macOS) or `mvnw.cmd` (Windows)
  - Gradle: `./gradlew` (Linux/macOS) or `gradlew.bat` (Windows)
- Avoid assuming globally installed Maven/Gradle when wrapper exists.

## Dependency and build discipline

- Keep dependency versions explicit and review transitive impact.
- Do not introduce unnecessary frameworks or plugins.
- Use standard lifecycle commands:
  - Maven: `./mvnw test`, `./mvnw verify`
  - Gradle: `./gradlew test`, `./gradlew build`

## Testing and quality

- Add/update tests with code changes.
- Prefer small, isolated unit tests first, then integration tests when needed.
- Report exact build/test commands and outcomes.

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
