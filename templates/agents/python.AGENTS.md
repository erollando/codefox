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
Build and maintain a clean, testable Python service/application.

## Python baseline

- Use Python 3.11+ unless the project states otherwise.
- Use a project-local virtual environment named `.venv`.
- Reuse existing `.venv` if present; do not create extra venvs unless asked.
- Prefer interpreter-scoped commands:
  - Linux/macOS: `.venv/bin/python -m ...`
  - Windows: `.venv\\Scripts\\python.exe -m ...`
- Prefer `python -m pip` over plain `pip` to avoid interpreter mismatches.

## Dependency management

- Keep dependencies explicit and minimal.
- Ensure there is a dependency manifest:
  - preferred: `requirements.txt` (+ optional `requirements-dev.txt`)
  - acceptable: `pyproject.toml` with clear dependency groups
- If dependencies change, update the manifest in the same task.
- Do not install global packages for project work.

## Build and test

- Run tests with the same interpreter/environment used for install.
- Prefer deterministic commands and include exact commands in the summary.
- If setup fails due network/index access, report it clearly as an environment limitation.

## Scope boundaries

- Do not access or print secret files.
- Do not operate outside the configured repository root.
- Keep changes focused; avoid unrelated refactors.

