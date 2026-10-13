## Summary

<!-- What changed, why, and which behavior or safety invariants are affected? -->
- Purpose:
- Scope / non-goals:
- Risk level (low / medium / high) and rationale:
- Base and candidate SHA:

## Implementation scope

<!-- Key files, architecture boundaries, migration or compatibility changes. -->
- Changed components:
- Data/control-plane effects:
- Rollback strategy:

## Verification — actual evidence only

<!-- PASS must be supported by the exact target SHA, command, environment and log/artifact. Never mark missing evidence PASS. -->
| Gate | Result (PASS / FAIL / NOT RUN / BLOCKED) | Command, commit, evidence link / limitations |
|---|---|---|
| Typecheck / lint | NOT RUN | |
| Targeted unit/integration tests | NOT RUN | |
| Full regression | NOT RUN | |
| Acceptance oracle | NOT RUN | |
| Baseline negative controls | NOT RUN | |
| Mutation controls (if applicable) | NOT RUN | |
| CI / independent checks | NOT RUN | |

- Test environment (OS / Node / Go / other):
- Provider/model calls, credentials and costs (or **none**):
- Negative controls / known flakes:
- Reproduction steps and evidence artifacts:

## Safety and security review

- [ ] No unexpected provider calls, spending, Git writes, or customer-data access
- [ ] File allowlists, process sandbox, and credential boundaries preserved
- [ ] Cancellation, lease ownership, fencing, retries, and verifier invariants preserved
- [ ] No secrets, private source snippets, raw prompts, or sensitive logs committed
- [ ] No undocumented schema migration or operational state mutation
- [ ] Safety-sensitive changes have independently reviewed contracts or an explicit risk disposition
- [ ] Local full-suite evidence is not misrepresented as green GitHub CI
- [ ] No auto-merge or unattended production deployment without operator approval

## Operational impact

- Schema / migration and backup prerequisites:
- Existing workloads, compatibility and restart needs:
- Lock renewal / fencing and concurrency implications:
- Deployment / rollback procedure:
- Known limitations / residual risks:

## Merge gates and sign-off

<!-- Checked only after evidence exists. Note if an exception is explicitly accepted, with owner, rationale and expiry. -->
- [ ] Scope and final diff reviewed at exact candidate SHA
- [ ] Required deterministic verification and security gates passed
- [ ] Unresolved P0/P1 risks fixed or explicitly dispositioned
- [ ] CI / branch protection requirements satisfied
- [ ] Operator-approved migration/deployment plan, if applicable
- [ ] Release/merge authorized by the responsible reviewer

**Verdict:** DRAFT / PARTIAL / READY FOR REVIEW / MERGE CLEARED

**Reviewer / operator:** 

**Outstanding blockers and owner:** 
