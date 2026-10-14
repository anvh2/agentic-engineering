# JavaScript implementation conventions

Shared HLD/LLD and acceptance invariants take priority over style.

- Preserve repository CJS/ESM conventions, API contracts and error semantics.
- Explicitly handle rejected promises, cancellation, cleanup and idempotency.
- Respect approved module boundaries and dependency direction; no unapproved dependencies.
- Use scoped offline `npx --no-install jest` verification with tightly allow-listed arguments.
- Worker edits one approved source file; tests and Oracle are immutable.
