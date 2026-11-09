# Demo runbook (Studio on port 4111)

Shows the real chain for one mission: request → issue → mission → execution → verification → PR. Every value on screen
comes from the scheduler database or GitHub. Nothing here is simulated, except CloudFarm's future sample farm data,
which is labelled as such.

## Preconditions

- The canonical Studio is running on `http://127.0.0.1:4111` (owned by its own session; do not restart it).
- `gh auth status` succeeds for an account that can read `anvh2/cloudfarm` (private).

```shell
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4111/            # 200
curl -s 'http://127.0.0.1:4111/control-center/v1/snapshot?project=cloudfarm' | head -c 300
```

## 1. The request

Open [kickoff-brief.md](kickoff-brief.md) (verbatim) and CloudFarm's `docs/discussions/2026-11-09-kickoff.md` (the
Lead's interpretation and decisions D-001 to D-003).

## 2. The backlog on GitHub

```shell
gh issue list --repo anvh2/cloudfarm --state all
gh api repos/anvh2/cloudfarm/milestones --jq '.[] | "\(.number) \(.title) open=\(.open_issues) closed=\(.closed_issues)"'
```

Show issue #1 (acceptance criteria), #2 (decisions the Architect owns) and #12 (the fail-open finding).

## 3. CloudFarm as a project in Studio

1. Open `http://127.0.0.1:4111/organization`.
2. In **Project**, choose `cloudfarm`. The scope line reads "All 1 objectives of cloudfarm" (batch `CF-M0`).
3. Open **Runs**: missions `CF-M0.gh1` (DONE), `CF-M0.gh3` and `CF-M0.gh5` (waiting). Titles carry the issue
   reference `anvh2/cloudfarm#N`.
4. Select `CF-M0.gh1`; its "Persisted lifecycle & recovery events" timeline shows BACKLOG → READY → CODING → DONE.

Command-line equivalent (same source):

```shell
npm run lead:tasks -- --batch CF-M0
npm run lead:status -- --batch CF-M0
```

## 4. The verification evidence

```shell
sqlite3 -readonly .workdir/scheduler/scheduler.db \
  "select json_extract(artifacts,'$.claudeDirect') from tasks where id='CF-M0.gh1';"
```

This shows the integrated commit `81e2364` and the runtime's own run of both `docscheck` commands with exit code 0.
The Lead's note is a claim; the exit codes are the evidence.

## 5. The PR

```shell
gh pr view 13 --repo anvh2/cloudfarm
```

The PR names the mission and the verification, and waits for the Architect's review. Merging uses a merge commit.

## What this demo cannot show yet

| Missing | Why | Tracked |
| --- | --- | --- |
| Issues listed inside Studio, with links to missions | No GitHub link field or mirror yet | [MASTRA-WORKFLOW](MASTRA-WORKFLOW.md#proposed-github-link-and-sync) |
| A CloudFarm meeting or discussion thread in Studio | Meetings need a model-backed participant; Ollama is down | README status table |
| A local worker run and its Mastra trace | No implementation task is specified yet, and Ollama is down | CloudFarm M1 |
| CI results on the PR | No CI yet | anvh2/cloudfarm#5 |
