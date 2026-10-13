# Integration ownership and interrupted recovery

Integration has two ownership layers. An atomic directory creation at
`<git-common-dir>/agentic-integration-guard` serializes cooperating integrators
across processes, worktree managers, repository aliases and scheduler databases.
It is held across all awaited Git and verification operations. Inside that gate,
a renewable scheduler lease uses a fresh UUID generation for each invocation.
Renewal cannot resurrect an expired generation; ownership loss is sticky and
prevents further Git operations, rollback and DONE transitions. Release is
conditional on the generation. Claude-direct completion takes the same gate.

The ownership checks are **not atomic with asynchronous Git commands**. The
non-expiring gate closes that race: expiry alone never admits another integrator
while the old command is running. A replacement database lease alone does not
confer integration ownership. It must also hold the repository gate. Integrators
from older runtime versions do not follow this protocol and must be stopped
before upgrading. Manual Git writers must not operate concurrently with an
integrator; the protocol does not fence arbitrary external Git commands.

## Fail-closed crash limitation

There is deliberately no automatic gate stealing, PID liveness heuristic or
expiry timeout. A process death may leave live detached children, and PID reuse
cannot prove ownership. An orphan gate blocks integration until an operator:

1. Stops integration entrypoints and establishes that the previous integrator
   **and all its Git/verification descendants** are quiescent.
2. Reads the gate's `owner` evidence and the task's `artifacts.integration` journal;
   preserves any unrelated changes and checks the dedicated integration worktree.
3. Removes only that reconciled gate's `owner` file and empty gate directory.
   Allows the old database lease to expire (or conditionally releases that exact
   owner), then retries integration.

Never remove the gate while a holder or child can still write. Uncertain process
state is BLOCKED and requires investigation, not a force-unlock. A partial gate
without its owner file also remains blocked. There is no operational database
migration and no automated database repair command.

Recovery resets only an exact journaled `expectedTip`, or the unchanged `preSha`.
An external descendant is not considered owned simply because `preSha` is its
ancestor. A crash between a Git commit and journal persistence therefore requires
manual reconciliation; recovery preserves that commit. Interrupted merges are
aborted only when MERGE_HEAD names the integrating task's reviewed commit.
Unknown tracked edits and unknown untracked/ignored paths block rollback before
`reset --hard` can overwrite checkout obstructions. Broad `git clean` is never used. Only exact
oracle content belonging to the interrupted task may be removed. A new staged
oracle is discardable only if it is absent from HEAD and both its index and
working-tree bytes match the owned content; foreign edits still block recovery.

`ownership.test.ts` deterministically advances lease time, drives renewal timers,
injects renewal faults and pauses at the Git check/act boundary. Ordinary recovery,
stale generation release, external commits and orphan gates are covered as well.
