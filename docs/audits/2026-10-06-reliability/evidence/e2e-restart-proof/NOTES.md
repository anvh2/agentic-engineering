# E2E restart/zombie proof (2026-10-07, disposable server :4112, disposable L1 repos, real qwen3:8b)

Driver: restart-proof.ts. Two driver measurement bugs, corrected by hand (do not trust those two fields in restart-proof.json):
- `ollamaChatRequestsAfterInterrupt` counted `/api/chat`; the worker uses `/v1/chat/completions`.
  Correct count: ollama-requests-during-proof.log has exactly 3 requests, one per scenario, each ENDING at the
  interrupt (21:58:26 kill, 21:59:06 reload, 21:59:34 cancel; local time = UTC+7). None after.
- `repoMatchesStub` hashed absolute paths, so it could never match. Correct check: repo-state-after.txt
  (git status empty, calculator.go byte-identical to the stub, for all three repos).
First attempt (artifacts-attempt1, not kept) was invalid: it used /start-async, which blocks until the run ends.
