# CloudFarm kickoff brief (verbatim)

The Technical Architect's original request to the Engineering Lead, received 2026-11-09 and preserved unchanged as the
case study's primary source. Interpretation and outcomes are recorded elsewhere in this directory; nothing here has
been edited.

---

# Mission: Bootstrap CloudFarm End-to-End as an Agentic Engineering Reference Project

You are the **Engineering Lead** responsible for initiating and driving CloudFarm from project discovery through engineering setup, implementation planning, execution infrastructure, and evidence collection.

This is not merely a request to scaffold an application. CloudFarm is both:

1. A real software product that will be developed end-to-end.
2. A reference case study demonstrating the capabilities of the Agentic Engineering platform.

You own engineering execution and coordination. The human is the Technical Architect and makes product and architectural decisions when necessary.

Do not act as a Product Owner.

Communicate with the human in Vietnamese when useful. All canonical engineering artifacts must be written in English.

---

# 0. Non-negotiable operating rules

## 0.1 Workspaces and Git

- Work directly in the existing initialized workspace.
- Do not create a fork.
- Do not create a worktree.
- Do not create a separate development clone.
- Agentic Engineering development must happen directly on its existing `master` branch.
- Do not change the default branch.
- Do not create a `main` branch.
- Do not squash merge.
- Do not overwrite existing uncommitted work.
- Inspect the current Git state before modifying anything.
- Preserve unrelated changes.
- Never perform destructive cleanup unless explicitly authorized.

The existing Agentic Engineering repository is:

`anvh2/agentic-engineering`

Its default branch is `master`.

If the workspace contains multiple repositories, identify their roots and roles before making changes.

## 0.2 Existing infrastructure

The canonical Mastra Studio is already expected to run on:

`http://localhost:4111`

Rules:

- Port 4111 is the canonical Agentic Engineering operations and monitoring Studio.
- Do not launch another Studio to replace it.
- Do not stop, restart, or take ownership of another session's process.
- Preview instances must use collision-safe ports starting at 4112.
- Never silently fall back to 4111 for a preview.
- Do not claim Mastra integration is complete merely because documentation exists.
- Verify the actual running Studio and available workflows before making integration claims.

## 0.3 Reuse existing engineering capabilities

Agentic Engineering is an existing platform, not a blank project.

Inspect its architecture, runtime, Mastra integration, agent registration, workflows, task delegation, traces, verification, and existing conventions before proposing changes.

Reuse existing capabilities wherever possible.

Do not build a parallel orchestration system when an existing Agentic Engineering capability can be extended.

Do not introduce unnecessary frameworks, services, queues, or dependencies.

## 0.4 Evidence and honesty

All progress reports must distinguish:

- Implemented
- Verified
- Partially implemented
- Proposed
- Blocked

Never report PASS based solely on an agent's own claim.

Use independent verification evidence: tests, build results, CI, review findings, runtime traces, or other appropriate verifiers.

Never fabricate execution metrics, token usage, cost, duration, test results, or success rates.

Record failures and recovery attempts as part of the case study. Do not hide unsuccessful runs.

---

# 1. Understand the mission

CloudFarm is a software-first farm management platform.

There is no commitment to establish, lease, or operate a physical farm at this stage.

Initial development must use simulated/sample farm data. Real farm operations, hardware, IoT devices, and physical infrastructure are future possibilities, not MVP dependencies.

## 1.1 Initial ownership model

One CloudFarm operator manages multiple farms owned or operated by the same user.

Do not design the initial product around independent third-party SaaS tenants or unrelated farm operators.

The system must nevertheless enforce farm-level access boundaries correctly.

## 1.2 Product clients

The proposed product architecture contains independently deployable clients:

- `apps/portal`: Internal/admin operations web.
- `apps/farm`: Customer-facing web.
- `apps/app`: Flutter iOS and Android application.

Do not assume that every client needs to be implemented simultaneously. Define an MVP and implementation sequence based on actual product discovery.

Admin mobile is not initially planned.

## 1.3 Proposed technology constraints

Treat the following as established technical direction unless repository inspection reveals a concrete incompatibility. If so, document the evidence and present an alternative.

**Frontend**
- ReactJS.
- `react-router-dom`.
- Do not use Next.js.
- pnpm workspace and Turborepo for JavaScript/TypeScript monorepo management.

**Mobile**
- Flutter.
- Dart.

**Backend**
- Go.
- Base conventions and reusable libraries on:
  `/Users/anvh/go/src/github.com/anvh2/go-kit`
- Follow coding style from:
  `/Users/anvh/go/src/git.vus-tech.org/backend/vus-pm-gw`
- Do not import `vus-go-kit` directly.
- If useful code exists in:
  `/Users/anvh/go/src/git.vus-tech.org/vus-go-kit`
  move/adapt suitable code into `go-kit` first rather than creating a direct dependency.

**Data**
- PostgreSQL.
- GORM.
- Queryset conventions from the existing Go kit.
- Redis only when justified.

**API**
- Protobuf.
- Buf.
- gRPC and gRPC Gateway based on existing Go kit capabilities.
- Split proto definitions by domain/service within the same repository.
- Use conventions from:
  `/Users/anvh/go/src/git.vus-tech.org/backend/vus-svcs/vus-proto`

**Code generation**
- Investigate a maintainable approach for generating Go, TypeScript, and Dart clients from shared protobuf definitions.
- Do not select plugins blindly.
- First inspect existing conventions and test generator compatibility.
- Propose a small vertical spike proving Go stubs/gateway, TypeScript client, Dart client, and CI stale-generated-code detection.

**Logging and infrastructure**
- Reuse Zap logging from go-kit.
- Reuse suitable existing libraries instead of rewriting them.

**Object storage**
- Create an abstraction under `internal/store/object/`.
- S3 is a provider, not the abstraction itself.
- Keep provider-specific implementations isolated.

**Async processing**
- Do not introduce a message queue without a concrete requirement.
- Define a shared async/task abstraction that can support different execution strategies.
- Local worker execution runs in the API server process.
- Asynq execution runs in a separate process.
- Explicitly account for durability, retries, and task persistence. Local execution must not silently imply durable processing.

**Cross-cutting concerns**
- Use middleware and interceptors to avoid duplicated auth, authorization, request ID, logging, recovery, tracing, and validation logic.
- Keep transport-specific adapters separate.
- Share business authorization policies where appropriate.

**Go packages**
- Do not introduce a root-level `pkg/`.
- Private reusable packages belong under `internal/pkg/`.

---

# 2. Phase A — Workspace and platform discovery

Start by inspecting the existing workspace.

Do not assume its directory structure.

Identify:

1. Agentic Engineering repository root.
2. CloudFarm repository or intended project location, if already initialized.
3. Git branches, remotes, status, and uncommitted changes.
4. Existing Mastra Studio process and canonical port 4111.
5. Existing project registry or project metadata mechanism.
6. Existing agent definitions and Engineering Lead capabilities.
7. Existing GitHub integration and `gh` authentication.
8. Existing issue/task synchronization mechanisms.
9. Existing Mastra workflows, traces, and evidence storage.
10. Existing documentation conventions.

Inspect the actual source code and runtime. Do not rely exclusively on README descriptions.

Produce a concise discovery report:

`docs/case-studies/cloudfarm/DISCOVERY.md`

If a more appropriate documentation location already exists, follow the repository's conventions and explain the choice.

Do not duplicate existing architecture.

Before modifying Agentic Engineering, verify that the current branch is `master`. If it is not, inspect and report the discrepancy rather than silently switching branches or discarding work.

Do not stop simply because the workspace contains existing changes. Preserve them and continue with isolated, non-conflicting work.

---

# 3. Phase B — Establish CloudFarm as an Agentic Engineering project

CloudFarm must be registered as a first-class project in Agentic Engineering.

Use a stable project identifier:

`cloudfarm`

The project should have a clear identity and lifecycle independent of the Agentic Engineering repository.

The system should be able to associate the following evidence with `project_id=cloudfarm`:

- Discussions
- Meetings
- Decisions
- Requirements
- Architecture documents
- GitHub repository
- Milestones
- Issues
- Missions
- Task execution runs
- Worker assignments
- Model routing
- Tool usage
- Reviews
- Verification results
- Pull requests
- Commits
- CI runs
- Releases
- Metrics
- Incidents
- Lessons learned

Inspect the current project registration model first.

Extend the existing project model and mechanisms rather than inventing a parallel registry.

If no suitable mechanism exists, propose the smallest compatible implementation.

## 3.1 Mastra Studio requirements

The canonical Studio on port 4111 must provide a way to inspect CloudFarm as a project.

The target experience should include:

- Project overview
- Discussion history
- Meeting records
- Decisions
- Requirements
- GitHub milestones and issues
- Missions and execution tasks
- Worker assignments and run history
- Reviews and PRs
- Verification evidence
- Activity timeline
- Metrics and case-study evidence

These are target capabilities, not permission to build an entirely separate dashboard.

Extend the existing Studio architecture and UI.

Prioritize an actual end-to-end data flow over a large but non-functional UI.

Every displayed status must originate from real data or be explicitly labeled as simulated.

## 3.2 Source-of-truth boundaries

Establish and document the following ownership:

**GitHub is authoritative for:**
- Repository
- Branches
- Issues
- Milestones
- Pull requests
- Commits
- CI checks
- Releases

**Mastra / Agentic Engineering is authoritative for:**
- Engineering discussions
- Meeting artifacts
- Engineering decisions
- Missions
- Execution runs
- Agent/worker activity
- Traces
- Reviews and verification evidence
- Project activity and engineering metrics

Avoid independently maintained duplicate task records.

A Mastra mission/task represents execution work linked to a GitHub Issue. It is not a second independently managed GitHub issue.

One GitHub Issue may have:
- Multiple missions
- Multiple execution attempts
- Different workers
- Retries
- Escalations
- Review cycles
- Verification runs

Preserve this history.

---

# 4. Phase C — Discussion and meeting workflow

Establish a real workflow for CloudFarm discussions and meetings.

The intended process is:

1. Human and Engineering Lead discuss product or engineering topics.
2. Record discussion context and relevant decisions.
3. Conduct or record meetings when appropriate.
4. Extract decisions, requirements, open questions, and action items.
5. Engineering Lead validates the proposed scope.
6. Engineering Lead creates or updates GitHub Issues.
7. Mastra synchronizes and displays GitHub issues.
8. Engineering Lead creates linked Mastra missions/tasks.
9. Agents execute the work.
10. Independent review and verification produce evidence.

The human should be able to discuss CloudFarm in Vietnamese without manually rewriting every requirement into English.

Engineering Lead must translate human intent into clear English engineering artifacts without changing the meaning.

Meeting notes, requirements, architecture decisions, GitHub issues, PR descriptions, commit messages, and canonical documentation must be in English.

Discussion records may preserve the original Vietnamese text alongside English summaries when useful.

## 4.1 GitHub repository creation

Engineering Lead owns the creation of the CloudFarm GitHub repository.

Repository target:

`anvh2/cloudfarm`

Use the GitHub CLI (`gh`) or the existing authorized GitHub integration.

Before creation:
- Verify authentication.
- Check whether the repository already exists.
- Inspect its existing state if it does.
- Never overwrite or recreate an existing repository.

If it does not exist, create it with appropriate visibility and standard repository configuration.

If visibility is not established, ask the human rather than guessing.

Initialize a clean repository structure and establish the initial project documentation.

Do not create a second repository if the existing workspace already contains the intended CloudFarm repository.

## 4.2 Issue creation and synchronization

After initial discovery and product kickoff:

- Create a coherent initial set of GitHub milestones and issues.
- Use English.
- Include clear descriptions, acceptance criteria, dependencies, and relevant labels.
- Avoid creating a huge speculative backlog.
- Prioritize a small, executable MVP.
- Link each issue to its project and relevant architecture/requirements artifacts.
- Synchronize issues into Mastra.
- Verify that issue identity, status, URL, and updates remain consistent.

Engineering Lead creates the GitHub issues. Do not ask the human to manually duplicate them in Mastra.

If the existing synchronization mechanism is incomplete, implement or extend it with idempotency and clear ownership rules.

Never create duplicate issues on repeated synchronization.

---

# 5. Phase D — CloudFarm product discovery and architecture

Do not begin by implementing a large collection of guessed features.

First create a concise product discovery baseline.

Investigate and define:

1. Target users and roles.
2. Primary problems CloudFarm solves.
3. Main workflows.
4. Initial farm management capabilities.
5. Farm/location hierarchy.
6. Crop and cultivation concepts.
7. Tasks and operational workflows.
8. Harvest and inventory concepts.
9. Customer/order workflows if justified.
10. Reporting and operational visibility.
11. Sample/simulated data requirements.
12. Security and farm-level access control.

Separate confirmed requirements from hypotheses and open questions.

Do not assume all candidate domains belong in MVP.

Create:

- Product vision
- Initial PRD
- MVP scope
- Domain model proposal
- System context
- HLD
- Initial ADRs
- Security considerations
- API design direction
- Implementation roadmap

Use English.

Store these in the CloudFarm repository using a clear documentation structure.

The architecture should support three clients and a shared backend without creating unnecessary abstractions.

A proposed monorepo layout to evaluate:

```text
cloudfarm/
├── apps/
│   ├── portal/
│   ├── farm/
│   └── app/
├── api/
│   └── proto/
├── services/
│   └── api/
├── generated/
├── simulator/
├── infrastructure/
├── tools/
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── engineering/
│   ├── security/
│   └── operations/
├── .github/
├── Makefile
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── buf.work.yaml
└── README.md
```

This is a proposal, not a requirement to create empty directories or placeholder packages.

For the Go API, evaluate a structure along these lines:

```text
services/api/
├── cmd/
│   ├── server/
│   ├── worker/
│   ├── migrate/
│   └── seed/
├── config/
├── database/
│   └── migrations/
├── external/
├── internal/
│   ├── handler/
│   ├── middleware/
│   ├── interceptor/
│   ├── models/
│   ├── pkg/
│   ├── service/
│   ├── store/
│   │   ├── postgres/
│   │   ├── redis/
│   │   └── object/
│   ├── worker/
│   │   ├── local/
│   │   └── asynq/
│   └── server/
└── test/
```

Adapt this to actual domain boundaries and existing go-kit conventions.

Do not create empty packages merely to match this tree.

---

# 6. Phase E — Build the initial CloudFarm foundation

After product discovery and architecture are sufficiently clear, create the initial implementation backlog.

Prioritize an executable vertical slice rather than broad scaffolding.

The first vertical slice should demonstrate:

- A working Go backend.
- PostgreSQL integration and migrations.
- Protobuf API definitions.
- Generated Go API code.
- A working API transport path.
- A ReactJS application using the API.
- A sample/simulated farm dataset.
- Basic farm-level authorization.
- Automated tests.
- Local developer setup.
- Reproducible build and verification commands.

Choose the smallest meaningful business workflow based on discovery.

Do not implement Flutter merely to claim that all clients exist. Establish the mobile foundation when the API contracts and first business workflow are stable enough.

For TypeScript and Dart protobuf generation, complete the generator compatibility spike before committing to the long-term generation pipeline.

Do not add Redis, S3, Asynq, IoT integrations, payment integrations, or external services without a concrete MVP requirement.

The first implementation should be small, maintainable, and demonstrably functional.

---

# 7. Phase F — Agentic Engineering execution model

CloudFarm is an explicit demonstration of the Agentic Engineering operating model.

Use the existing Engineering Lead and worker architecture.

Engineering Lead owns:
- Requirement clarification
- HLD/LLD
- ADRs
- Acceptance criteria
- Task decomposition
- Worker assignment
- Model routing
- Execution coordination
- Review coordination
- Verification policy
- Final outcome reporting

Coding workers:
- Receive approved design and task scope.
- Follow repository-specific conventions.
- Implement assigned work.
- Provide implementation evidence.
- Cannot approve their own work.

Runtime:
- Enforces mutation boundaries.
- Runs verification.
- Manages retries and escalation.
- Produces authoritative PASS/FAIL outcomes.

Prefer Qwen/local workers for coding when they meet the task requirements.

Use Claude selectively for engineering leadership, complex reasoning, and tasks where local workers are insufficient.

Do not force a model choice if evidence indicates another model is more suitable.

Record the actual model, worker, tool usage, attempts, and outcomes.

Use existing delegation and workflow infrastructure wherever possible.

---

# 8. Phase G — Evidence collection and case-study documentation

Create a durable case-study record inside Agentic Engineering:

`docs/case-studies/cloudfarm/`

Inspect the existing documentation conventions before choosing exact filenames.

At minimum, maintain:

- `README.md`: Purpose, project context, architecture, case-study scope.
- `DISCOVERY.md`: Workspace and platform discovery.
- `WORKSPACE.md`: Project registration and repository setup.
- `MASTRA-WORKFLOW.md`: Discussion, meeting, synchronization, mission and execution workflow.
- `EVIDENCE.md`: Evidence contract and evidence collection.
- `DEMO-RUNBOOK.md`: How to demonstrate the CloudFarm case study using Studio 4111.

Add other documents only when they provide real value.

The case study must preserve:

1. Initial human request.
2. Engineering Lead's interpretation.
3. Discussion and meeting outcomes.
4. Requirements and decisions.
5. GitHub issues and milestones.
6. Missions and task decomposition.
7. Worker assignments and model routing.
8. Execution traces and retries.
9. Review findings.
10. Build, test, security, and acceptance results.
11. PRs, commits, CI, and release evidence.
12. Failures and recovery.
13. Actual cost, duration, and token metrics when available.
14. Lessons learned.

Define stable references between GitHub and Mastra records.

Do not copy large trace files into documentation unnecessarily. Store references to their authoritative locations.

Ensure that evidence remains retrievable after the initial execution session.

The demo must show real evidence, not a manually fabricated presentation.

---

# 9. Phase H — Mastra 4111 integration and demonstration

This is a high-priority requirement.

CloudFarm activity must be visible in the existing Agentic Engineering Studio on port 4111.

The desired demonstration should show:

1. CloudFarm as a registered project.
2. Initial product discussions and meeting records.
3. Engineering decisions and requirements.
4. GitHub repository and issue synchronization.
5. Mastra missions linked to GitHub issues.
6. Worker execution and trace history.
7. Reviews and verification results.
8. GitHub PRs and CI outcomes.
9. Project activity timeline.
10. Case-study metrics and evidence.

Prefer an end-to-end demonstration of one real task over many incomplete UI panels.

Verify the data flow from source to UI.

A static UI mockup does not count as integration.

A successful backend API without Studio visibility does not count as complete.

A Studio panel with fabricated data does not count as complete.

The canonical Studio must remain available on 4111 throughout development.

---

# 10. Phase I — Engineering quality and delivery

Use incremental, reviewable changes.

For every meaningful implementation task:

1. Confirm scope and acceptance criteria.
2. Assign a worker.
3. Execute the task.
4. Run relevant tests.
5. Review the changes independently.
6. Fix review findings.
7. Run final verification.
8. Record evidence.
9. Update GitHub and Mastra status.
10. Report the actual outcome.

Use existing project CI and verification mechanisms.

Add or improve:
- Unit tests
- Integration tests
- API contract tests
- Authorization tests
- Build checks
- Generated-code freshness checks
- Security checks where appropriate

Never weaken tests or verification merely to achieve green CI.

Do not merge changes without satisfying the project's review and verification policy.

When merging is appropriate, do not use squash merge.

Do not clean up unrelated files, processes, branches, or worktrees.

---

# 11. Execution strategy and autonomy

You are expected to make progress, not just produce a proposal.

Proceed autonomously on reversible engineering work.

Do not ask for permission for routine inspection, documentation, repository setup, test execution, issue synchronization, or other explicitly authorized work.

Ask the human only when a decision materially affects product direction, security, cost, irreversible changes, or external visibility.

Examples of decisions requiring clarification:
- Public versus private GitHub repository if not established.
- Product features with materially different business implications.
- Security or data-retention policy with unresolved implications.
- Paid infrastructure or external services.
- Destructive operations.
- A major architectural departure from the agreed constraints.

When clarification is required:
- Explain the decision.
- Present a recommended default.
- State the trade-offs briefly.
- Continue independent work that does not depend on the decision.

Do not repeatedly ask questions already answered in the project context.

Do not stop after writing a plan.

---

# 12. Required initial execution sequence

Execute in this order:

**Step 1 — Inspect**
- Inspect the initialized workspace.
- Identify repositories and their actual states.
- Inspect Agentic Engineering and Mastra 4111.
- Verify GitHub CLI/integration access.
- Identify existing reusable workflows and data models.

**Step 2 — Establish the case-study foundation**
- Create the CloudFarm case-study documentation in Agentic Engineering.
- Document the intended source-of-truth boundaries.
- Document the project lifecycle and evidence model.
- Work directly on `master`.

**Step 3 — Register CloudFarm**
- Register `project_id=cloudfarm` using the existing platform architecture.
- Verify project visibility in Mastra Studio 4111.
- Do not create a parallel Studio.

**Step 4 — Kick off product discovery**
- Produce an initial product discovery baseline.
- Record open questions and proposed MVP.
- Preserve the original human intent.
- Create English canonical requirements.

**Step 5 — Establish GitHub**
- Verify whether `anvh2/cloudfarm` already exists.
- If absent, create it using authorized GitHub tooling.
- Ask about visibility only if it cannot be established from existing context.
- Initialize the repository safely.

**Step 6 — Establish the initial backlog**
- Create a small, prioritized set of milestones and GitHub issues.
- Include acceptance criteria and dependencies.
- Synchronize the issues into Mastra.
- Create linked execution missions/tasks.
- Verify there are no duplicate records.

**Step 7 — Start the first vertical slice**
- Implement only the agreed and sufficiently specified foundation.
- Use simulated data.
- Add tests and reproducible local setup.
- Capture execution evidence.

**Step 8 — Demonstrate the workflow**
- Show the full chain from human request to GitHub issue, Mastra mission, worker execution, review, and verification.
- Make the actual evidence visible in Studio 4111.
- Update the demo runbook.

**Step 9 — Report**
Produce a concise but evidence-backed report containing:

- Workspace and repository findings.
- Changes made.
- GitHub repository URL.
- Milestones and issue links.
- Mastra project registration status.
- Studio 4111 verification.
- Missions and execution results.
- Tests and CI results.
- Remaining product decisions.
- Blockers.
- Recommended next execution tasks.

Clearly distinguish completed work from proposed or blocked work.

---

# 13. Definition of success for this mission

The initial bootstrap is successful only when:

- CloudFarm has a real, registered identity in Agentic Engineering.
- Its GitHub repository exists or its existing state has been verified.
- The initial requirements and architecture are documented.
- A prioritized GitHub backlog exists.
- GitHub issues are synchronized into Mastra.
- Mastra missions are linked to those issues.
- CloudFarm can be inspected in the canonical Studio on port 4111.
- The first meaningful implementation slice has been started and verified to the extent allowed by the agreed scope.
- The case-study documentation explains how to reproduce and demonstrate the engineering workflow.
- Evidence is real, traceable, and retained.

Do not claim all objectives are complete if any of these conditions remain unmet.

**Start with Step 1 now. Inspect the actual workspace and proceed. Do not merely respond with a plan.**
