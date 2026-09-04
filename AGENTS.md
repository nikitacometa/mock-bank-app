# Cometa agent entrypoint

Read `CLAUDE.md` in full before changing code, infrastructure, or project state. It is the canonical
project instruction set and its invariants are mandatory.

- Read `docs/spec.md` before architecture or product changes.
- Read `docs/handoff.md` and `docs/next-phase.md` before resuming the paused milestone.
- Read `deploy/standalone/README.md` before any Irena, DNS, TLS, bot, or rollback work; do not use a
  generic remote Git-pull deployment for this project.
- Preserve the intentional four-account, 437-transaction demo fixture unless the owner explicitly
  requests a data change.
- Never store or display credentials, raw bot tokens, passwords, or private key material.
