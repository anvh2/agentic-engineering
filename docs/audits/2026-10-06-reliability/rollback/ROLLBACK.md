# Rolling back the reliability patch

Only do this while `mastra dev` is stopped (any edit under src/mastra reloads it).

```bash
cd /Users/anvh/go/src/github.com/anvh2/harness-engineering
# Option A: reverse-apply the exact patch
git apply -R lead/audits/2026-10-06-reliability/reliability-audit-fixes.patch
# Option B: restore the pre-patch bytes and remove the files the patch added
tar -xzf lead/audits/2026-10-06-reliability/rollback/pre-patch-files.tgz
xargs rm -f < lead/audits/2026-10-06-reliability/rollback/files-added-by-patch.txt
shasum -a 256 -c lead/audits/2026-10-06-reliability/rollback/pre-patch.sha256
```
The refusal markers in `.workdir/lead-delegations/.executions/` are inert without the patch; delete them only after rollback if wanted.
