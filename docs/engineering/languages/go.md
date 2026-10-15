# Go implementation conventions

All changes must satisfy the shared HLD/LLD, acceptance contract and safety policy first.

- Package boundaries follow LLD components. Prefer small interfaces at consumers, explicit dependencies and idiomatic naming.
- Propagate `context.Context` for request-scoped cancellation. Define ownership for goroutines, timers and channels.
- Wrap errors with context; do not suppress verifier errors or panic for ordinary failures.
- Preserve idempotency, transaction boundaries, concurrency constraints and observability defined in LLD.
- `gofmt` and allow-listed `go test` are necessary but do not replace independent acceptance.
- Worker may only edit the approved one-file scope; never modify `*_test.go`, security gates or Oracle.
