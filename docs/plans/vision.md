> **Status: long-term target, not a description of the current code.** The directory tree and component boxes below are aspirational; the implemented architecture is in [../architecture/runtime.md](../architecture/runtime.md). Written before the rename from harness-engineering.

┌─────────────────────────────────────────────────────────────────────────────┐
│                                  YOU — AN                                   │
│                                                                             │
│   Intent / Goal / Deadline / Priority / Override                            │
│                                                                             │
│   "Làm feature X"                                                           │
│   "Cái này gấp"                                                             │
│   "Tối nay cứ chạy local"                                                   │
│   "Tôi muốn thử hướng Y"                                                    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PERSISTENT ENGINEERING LEAD                              │
│                         agentic-engineering                                 │
│                                                                             │
│   Externalized Engineering Brain                                            │
│                                                                             │
│   ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐   │
│   │ Engineering DNA    │  │ Project Memory     │  │ Decision Memory    │   │
│   │                    │  │                    │  │                    │   │
│   │ design principles  │  │ architecture       │  │ what / why         │   │
│   │ coding philosophy  │  │ components         │  │ rejected paths     │   │
│   │ review style       │  │ repo ownership     │  │ experiments        │   │
│   │ trade-offs         │  │ historical context │  │ evidence/results   │   │
│   └────────────────────┘  └────────────────────┘  └────────────────────┘   │
│                                                                             │
│   ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐   │
│   │ Active Task State  │  │ Repo Reconciler    │  │ Context Compiler   │   │
│   │                    │  │                    │  │                    │   │
│   │ goal               │  │ Git HEAD           │  │ Lead → primary     │   │
│   │ progress           │  │ working tree       │  │ primary → local    │   │
│   │ blockers           │  │ tests              │  │ minimal context    │   │
│   │ attempts           │  │ actual source      │  │ per task           │   │
│   │ next step          │  │ artifacts          │  │                    │   │
│   └────────────────────┘  └────────────────────┘  └────────────────────┘   │
│                                                                             │
│                         LEAD OWNS "WHY"                                     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     INTELLIGENCE / RESOURCE SCHEDULER                       │
│                                                                             │
│                           Task Analyzer                                     │
│                                │                                            │
│          ┌─────────────────────┼─────────────────────┐                      │
│          ▼                     ▼                     ▼                      │
│     Complexity              Risk                  Urgency                    │
│          │                     │                     │                      │
│          └─────────────────────┼─────────────────────┘                      │
│                                │                                            │
│                                +                                            │
│                                                                             │
│                       Runtime Resource State                                │
│                                                                             │
│       Claude Pro          Codex Plus          Local Compute                  │
│       ──────────          ──────────          ─────────────                  │
│       availability        availability        M2 resources                  │
│       window quota        quota               Ollama                        │
│       weekly quota        reset time          concurrency                   │
│       reset time          models              Qwen models                   │
│       model/effort        reasoning           load                          │
│                                                                             │
│                                │                                            │
│                                ▼                                            │
│                     QUOTA-AWARE MODEL ROUTER                                │
│                                                                             │
│       optimize: quality + time + quota + cost + failure risk                │
└───────────────┬─────────────────────┬──────────────────────┬────────────────┘
                │                     │                      │
                ▼                     ▼                      ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────────┐
│     CLAUDE CODE      │ │        CODEX         │ │   LOCAL AGENT GATEWAY    │
│                      │ │                      │ │                          │
│ Primary strong       │ │ Primary strong       │ │ Qwen / Ollama / future  │
│ execution engine     │ │ execution engine     │ │ local models             │
│                      │ │                      │ │                          │
│ native skills        │ │ native capabilities  │ │ cheap bounded work       │
│ native agents        │ │ agents/tools         │ │                          │
│ tools                │ │                      │ │ tests / search /         │
│ subagents            │ │                      │ │ boilerplate / mechanical │
│                      │ │                      │ │ refactor / fixtures      │
│ model selection      │ │ model selection      │ │                          │
│ effort selection     │ │ reasoning effort     │ │ sandboxed repo tools     │
└──────────┬───────────┘ └──────────┬───────────┘ └────────────┬─────────────┘
           │                        │                           │
           │       can delegate bounded local tasks            │
           ├──────────────────────────────────────────────────►│
           │                        │                           │
           │                        ├──────────────────────────►│
           │                        │                           │
           │                        │◄──────────────────────────┤
           │◄──────────────────────────────────────────────────┤
           │             candidate patch / evidence            │
           │                                                    │
           └───────────────────────┬────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VERIFICATION / REVIEW                               │
│                                                                             │
│       tests → lint → typecheck → diff → contract → architecture review      │
│                                                                             │
│             local output NEVER has architectural authority                  │
│                                                                             │
│                       failure / uncertainty                                 │
│                               │                                             │
│                               ▼                                             │
│                           ESCALATION                                        │
│                    Local → Codex/Claude → Lead                              │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            TARGET WORKSPACE                                 │
│                                                                             │
│             ┌────────────────────┐       ┌────────────────────┐             │
│             │       eshop        │       │    future repos    │             │
│             │                    │       │                    │             │
│             │ actual product     │       │ services/libs/etc. │             │
│             │ domain logic       │       │                    │             │
│             │ UI/API/jobs        │       │                    │             │
│             │ AI generation      │       │                    │             │
│             └────────────────────┘       └────────────────────┘             │
│                                                                             │
│              agentic-engineering DOES NOT own product logic                 │
└─────────────────────────────────────────────────────────────────────────────┘


Task
 │
 ├─ complexity
 ├─ risk
 ├─ urgency/deadline
 ├─ expected duration
 └─ parallelizability
        │
        +
        │
Current resources
 │
 ├─ Claude quota/reset
 ├─ Codex quota/reset
 ├─ Claude available models
 ├─ Codex available models
 ├─ reasoning/effort levels
 ├─ local model availability
 └─ machine capacity
        │
        ▼
     ROUTER
        │
        ├── engine
        ├── model
        ├── effort
        ├── number of agents
        ├── local delegation %
        └── quota reserve

```yaml
accounts:
  claude:
    plan: pro
    reserve: 20%

  codex:
    plan: plus
    reserve: 15%

routing:
  prefer_local_for:
    - repository_search
    - boilerplate
    - fixtures
    - repetitive_tests
    - mechanical_refactor

  require_strong_reasoning_for:
    - architecture
    - cross_repo_contract
    - concurrency
    - database_migration
    - destructive_change

```

```go
agentic-engineering/
│
├── lead/
│   ├── engineering-dna/
│   ├── project-memory/
│   ├── decisions/
│   ├── active-task/
│   ├── context-compiler/
│   └── reconciler/
│
├── scheduler/
│   ├── task-analyzer/
│   ├── quota/
│   │   ├── claude/
│   │   ├── codex/
│   │   └── local/
│   ├── model-router/
│   ├── effort-router/
│   └── escalation-policy/
│
├── adapters/
│   ├── claude-code/
│   ├── codex/
│   └── future/
│
├── local-agent/
│   ├── gateway/
│   ├── ollama/
│   ├── qwen/
│   ├── sandbox/
│   └── contracts/
│
├── skills/
│   ├── checkpoint/
│   ├── handoff/
│   ├── delegate-local/
│   ├── reconcile/
│   └── review/
│
└── cli/
    ├── lead-run
    ├── lead-status
    ├── lead-checkpoint
    └── lead-handoff
```

                    USER INTENT
                        │
                        ▼
                 ┌─────────────┐
                 │    LEAD     │
                 │ understand  │
                 └──────┬──────┘
                        │
                        ▼
                RECONCILE REALITY
              memory + git + tests
                        │
                        ▼
                  ANALYZE TASK
          complexity / risk / urgency
                        │
                        ▼
                 CHECK RESOURCES
          Claude / Codex / Local quota
                        │
                        ▼
                    PLAN DAG
                        │
             ┌──────────┼──────────┐
             ▼          ▼          ▼
          Task A      Task B      Task C
          hard        medium      cheap
             │          │          │
             ▼          ▼          ▼
          Claude      Codex       Qwen
          high        medium      local
             │          │          │
             │          │      retry/test
             │          │          │
             └──────────┼──────────┘
                        ▼
                     REVIEW
                        │
                   tests/diff
                        │
              ┌─────────┴─────────┐
              │                   │
            PASS                 FAIL
              │                   │
              │              classify failure
              │                   │
              │           local retry / escalate
              │                   │
              └─────────┬─────────┘
                        ▼
                    CHECKPOINT
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
            Git      Memory    Decisions
                        │
                        ▼
                  NEXT TASK / DONE


                     AN
                      │
              GOALS + JUDGMENT
                      │
                      ▼
             ┌─────────────────┐
             │ ENGINEERING LEAD│
             │                 │
             │ remembers       │
             │ reasons         │
             │ challenges      │
             │ plans           │
             │ budgets         │
             │ reviews         │
             └────────┬────────┘
                      │
          buys intelligence when needed
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
    Claude          Codex          Local
   expensive       expensive        cheap
   powerful        powerful        abundant
       │              │              │
       └──────────────┼──────────────┘
                      ▼
                  SOFTWARE



                    ┌─────────────────┐
                    │      YOU        │
                    │ Founder / Human │
                    │ Approval Gates  │
                    └────────┬────────┘
                             │
             ┌───────────────┴───────────────┐
             ▼                               ▼
      ┌──────────────┐                ┌──────────────┐
      │  Marketing   │                │   Product    │
      │    Team      │───────────────▶│    Team      │
      └──────────────┘  market signal └──────┬───────┘
                                             │
                                      Product Spec
                                             │
                                             ▼
                                   ┌──────────────────┐
                                   │ Engineering Lead │
                                   │  strong model    │
                                   └────────┬─────────┘
                                            │
                                    Coding Tasks
                                            │
                         ┌──────────────────┼──────────────────┐
                         ▼                  ▼                  ▼
                   ┌──────────┐       ┌──────────┐       ┌──────────┐
                   │ Coding   │       │ Coding   │       │ Coding   │
                   │ Worker 1 │       │ Worker 2 │       │ Worker N │
                   │ LOCAL    │       │ LOCAL    │       │ LOCAL    │
                   └────┬─────┘       └──────────┘       └──────────┘
                        │
                        ▼
                deterministic tools
             lint / test / build / diff
                        │
                        ▼
                 Engineering Lead
                   review / merge