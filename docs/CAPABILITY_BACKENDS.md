# Capability Backends

Date: 2026-03-14

## Status Model

- `implemented`: pack has a native backend integration wired in CodeFox runtime surfaces.
- `planned`: pack is available as a policy/contract surface, but native backend integration is not wired yet.

## Current Pack Status

- `jira`: `implemented`
- `mail`: `planned`
- `calendar`: `planned`
- `repo`: `planned`
- `ops`: `planned`
- `docs`: `planned`

## Promotion Checklist (planned -> implemented)

1. Native backend integration is wired in CodeFox runtime for the pack.
2. User-facing `/capabilities` output reflects the pack as `implemented`.
3. Policy and approval behavior for pack actions is validated in tests.
4. Audit events include pack/action context for start and finish paths.
5. Operator docs (README + OPERATIONS) are updated for the new backend.
6. Rollback/recovery guidance exists for mutating actions in the pack.
