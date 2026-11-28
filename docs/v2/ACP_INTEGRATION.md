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
