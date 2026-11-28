# Acceptance and task breakdown

Codex, 2026-11-26 UTC. Proposed tests, not claims of passing behavior. Track each result on exact reviewed commit/tree. Foundation is the immediate priority; later scope is not silently dropped.

| ID | Task / suggested owner | Observable acceptance | Dependency |
| --- | --- | --- | --- |
| F01 | Core types, Claude; Codex review | Reviewed exported Go types and error semantics; MCP imports no SQL | Joint contract |
| F02 | SQLite schema, Claude | Migration atomicity; FK checks; reopen persists; unsupported version refused; V1 sentinel unchanged | F01 |
| F03 | Session authority, Claude | 256-bit random token; digest-only storage; revoked/expired principal rejected on each mutation | F02 |
| F04 | Durable messages, Claude | Duplicate identical send returns same sequence; altered duplicate conflicts; cross-scope recipient refused; stable bounded pagination | F02/F03 |
| F05 | Task ownership, Claude | Concurrent claims have exactly one winner; stale revisions and foreign owner denied; submit != accept | F02/F03 |
| F06 | MCP transport, Codex | SDK client initializes, lists tools, executes calls; loopback only; foreign Host/Origin denied; no bearer denied; body cap | F01/F03 |
| F07 | Tool handlers, Codex | Strict schemas; forged author/scope rejected; every core error mapped safely; no approval-granting tool | F04/F05/F06 |
| F08 | Integrated adversarial tests, joint | Token A cannot read B scope; revocation during active request cannot commit stale effects; duplicate after restart stays single | F07 |
| F09 | Native compatibility, joint | Installed Claude and Codex independently discover/call same MCP; exact binary versions and configuration provenance recorded | F08 |
| F10 | Dogfood migration, joint | Both exchange review and ownership through V2; persist proof; bootstrap records migration pointer; no inference polling | F09 |
| N01 | Native lifecycle | Start intent, native ID, role hash and usage fields recorded before substantive work; permissions remain native | F10 |
| N02 | Wake/resume | Explicit target session; message delivery dedup; no automatic retry of uncertain side effects; capability absence visible | N01 |
| N03 | Cancellation/recovery | Only owned process signaled; confirmed exit distinct from request; interrupted state on restart; stale result denied | N01 |
| N04 | Context/knowledge | Full fundamentals hash matches snapshot; approved versions only; native skills preserved; resume/compaction experiment | N01 |
| N05 | Usage/events | Replay does not double count; last/total semantics preserved; null not zero; source gaps visible; cost kinds separate | N01 |
| V01 | Verification | Generated code tested in fail-closed sandbox; protected paths and side effects checked; exact revision bound to result | N03 |
| V02 | Cross-review/integration | Reviewer inspects diff/source; high findings resolved; integrated tree retested; master merge awaits human | V01 |
| U01 | Real UI state | Existing styling preserved; Go-backed data, explicit empty/error states, no demo metrics in real mode | F10 |
| U02 | Project/objective workflow | Shared repo links, unlink preserves files; task/session scopes valid; restart durable | U01/N01 |
| U03 | Decisions/DNA | Agent proposals separate from human approval; exact-version approval; no silent policy update | N04/U01 |
| U04 | Session observability | Source events, true lifecycle, usage and test evidence; no fabricated reasoning/acknowledgement | N05/U01 |
| D01 | Reproducible app build | Wails build from clean worktree; embedded assets and migration/default-knowledge manifest | U04 |
| D02 | DMG installation | Apple Silicon clean-user install launches without Go/Node/npm/Wails; missing CLIs guided | D01 |
| D03 | Upgrade/uninstall | Backup/restore tested; existing DB retained; signing and notarization reported accurately | D02 |
| E01 | Bounded collaborative objective | Both agents implement/review through app; interruption recovery; accepted code and honest usage measured | V02/D03 |

Open numerical thresholds: cost per accepted objective, intervention reduction, multi-hour completion rate. Establish a representative baseline and authorized budget first; do not invent targets or infer unlimited inference authorization.
