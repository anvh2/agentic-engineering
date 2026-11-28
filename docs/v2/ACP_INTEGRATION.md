# ACP integration spike

## Decision
Use the existing Apache-2.0 ACP adapters from agentclientprotocol/claude-agent-acp and agentclientprotocol/codex-acp, and the community Go SDK github.com/coder/acp-go-sdk v0.13.5. Start with stable ACP v1. No fork or custom protocol. Keep Wails, project selection, knowledge selection, and native permission boundaries.

## Migration
1. Verify installed adapter binaries with a no-inference initialize handshake using the isolated spike below.
2. Verify authenticated sessions in a disposable read-only workspace, including denied out-of-scope reads, cancellation and knowledge metadata.
3. Implement the application ACP client using the SDK, with explicit permission requests and fail-closed behavior. Do not advertise filesystem or terminal capabilities until scoped implementations exist.
4. Map typed session updates into existing ordered chat blocks; keep provider-specific details upstream. Do not display private reasoning or raw credentials.
5. Preserve session identity per project/agent, selected model, scoped additional directories, bootstrap budget and on-demand knowledge. Verify adapter support rather than assuming parity.
6. Replace native JSONL chat only after regression and authenticated E2E gates pass. No silent fallback on permission failures.

## Smoke test
Install reviewed, pinned adapter releases separately; do not download code during chat execution.
From app/spikes/acp:
    go mod tidy
    go run . claude-agent-acp
    go run . codex-acp

The probe initializes only; it does not send prompts, start a session, or grant permissions. This is a separate module to avoid changing the production dependency graph before validation.

## Open gates
Adapter release pins, auth/subscription compatibility, macOS distribution and process shutdown, additional directory semantics, native read-only scope, usage availability, UI component reuse, integration tests. ACP is a protocol, not a reusable chat UI. No production cutover yet.


## Persistent conversation sessions (PR #77)

The Wails Go backend maintains a dedicated ACP adapter process, JSON-RPC connection
and ACP session for each (provider, adapter path, working directory, project/agent
conversation, knowledge-policy fingerprint). New messages reuse the same session
ID rather than starting a fresh adapter. Claude and Codex remain independent.

- Idle timeout: 10 minutes by default; configure `AE_ACP_IDLE_TIMEOUT=5m`
  (supported range: 1 second through 24 hours). TTL begins when a turn ends,
  not while a response is streaming.
- Each prompt still has the existing 20-minute execution deadline.
- Stop, timeout, transport failure, adapter exit and app shutdown close the
  affected adapter. The next message starts a new session (not a silent
  cross-process resume). Changing repository, role, assigned knowledge, pack
  revision or bootstrap content also creates a different session identity.
- Initial turn injects the applicable bootstrap. Subsequent turns reuse the
  existing ACP context and only send the new user message and refreshed
  on-demand knowledge paths. Temporary paths are valid only within their turn.
- The frontend uses distinct conversation histories for each project/agent.
  Harness streams are still serialized per provider to avoid mixing updates.
- `ConsoleResult.sessionId` and `sessionReused` report the runtime outcome.
  `ACP session reused` is emitted as an activity event for troubleshooting.
- ACP remains fail-closed for permission, filesystem and terminal callbacks.
  This does **not** establish authenticated macOS live E2E parity, support
  persistent resume after application restart, or solve usage telemetry gaps.

### Verification

Run `cd app && go test ./...` and frontend `npm run build`; perform
authenticated two-turn Claude and Codex tests on macOS, verify that the
second turn recalls a nonce from the first, change project/agent and verify
no context crossover, then wait past the idle TTL to confirm a fresh session.
