# Phase 4B Evaluation: True In-Flight Steer

Date: 2026-03-08

## Goal

Determine whether CodeFox can support true in-flight `/steer` message injection into an already-running Codex task, instead of interrupt-and-resume fallback.

## Evidence gathered

Local CLI inspection:

- `codex exec --help`
  - Non-interactive mode accepts one initial prompt (arg or stdin) and runs to completion.
  - No documented runtime input channel for extra prompts during execution.
- `codex exec resume --help`
  - Accepts one prompt after resume (arg or stdin).
  - No attach/inject/subsequent message API for an in-progress run.
- `codex features list`
  - `steer` is marked `removed`.
  - `realtime_conversation` is `under development` and disabled.
  - No stable feature indicating supported mid-turn injection for `exec`.

## Decision

Phase 4B is **not implementable in a stable way** with the currently available Codex CLI non-interactive surface used by CodeFox.

CodeFox should continue using Phase 4A deterministic behavior:
- capture steer request
- interrupt active run
- resume same session/thread with steer directive

## Why this is correct for CodeFox

- Keeps CodeFox thin and aligned with Codex capabilities.
- Avoids building an unofficial interactive runtime/protocol shim.
- Preserves deterministic, auditable behavior today.

## Revisit trigger

Re-evaluate Phase 4B when Codex exposes a stable API for in-flight message injection in non-interactive or programmatic mode.
