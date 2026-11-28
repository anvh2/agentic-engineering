package agent

import (
	"context"
	"errors"
	"fmt"
)

// CodexAdapter executes one Codex CLI turn with the native session, workspace
// sandbox, and all existing user configuration intact.
type CodexAdapter struct{}

func (CodexAdapter) Kind() Kind { return Codex }

func (CodexAdapter) Run(ctx context.Context, spec TurnSpec, emit func(Event)) (TurnResult, error) {
	args, err := CodexArgs(spec)
	if err != nil {
		return TurnResult{}, fmt.Errorf("prepare codex turn: %w", err)
	}
	stream := &codexStream{token: spec.Token, emit: emit}
	outcome, err := RunProcess(ctx, ProcessSpec{
		Path:   spec.Binary.Path,
		Args:   args,
		Env:    CleanEnv(map[string]string{TokenEnv: spec.Token}),
		Dir:    spec.Workdir,
		Stdin:  []byte(spec.Prompt),
		OnLine: stream.line,
	})
	if err != nil {
		// An unusable stream must not pass validation. Cancellation is still
		// classified as interrupted when the launcher returned after SIGINT.
		if ctx.Err() != nil {
			stream.result.Interrupted = true
			return stream.result, nil
		}
		return stream.result, fmt.Errorf("run codex: %w", err)
	}
	result, err := stream.finish(outcome.ExitCode, outcome.Interrupted, nil)
	if err != nil {
		// Interrupted and provider-reported failures are durable outcomes.
		if result.Interrupted || result.ExitCode != 0 || result.NativeError != "" {
			return result, nil
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			result.Interrupted = true
			return result, nil
		}
		return result, fmt.Errorf("verify codex completion: %w", err)
	}
	return result, nil
}
