package issues

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
)

const maxActivityCommandBytes = 200

var (
	shellWrapper = regexp.MustCompile(`^(?:\S*/)?(?:ba|z)?sh\s+-l?c\s+`)
	testInvoker  = regexp.MustCompile(`^(?:[A-Za-z_]\w*=\S*\s+)*(?:go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:npx\s+)?(?:vitest|jest)\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|node\s+(?:--\S+\s+)*--test\b|cargo\s+test\b|make\s+(?:\S+\s+)*(?:test|check)\b|mvn\s+(?:\S+\s+)*(?:test|verify)\b|(?:\./)?gradlew?\s+(?:\S+\s+)*(?:test|check)\b|swift\s+test\b|dotnet\s+test\b|(?:bundle\s+exec\s+)?rspec\b|(?:\./)?(?:vendor/bin/)?phpunit\b)`)
)

// isTestCommand reports whether any simple command in the line starts a known
// test runner. It is a label for the Director, not proof that tests passed.
func isTestCommand(command string) bool {
	command = shellWrapper.ReplaceAllString(strings.TrimSpace(command), "")
	command = strings.Trim(command, `"'`)
	separators := strings.NewReplacer("&&", "\n", "||", "\n", ";", "\n", "|", "\n")
	for _, part := range strings.Split(separators.Replace(command), "\n") {
		if testInvoker.MatchString(strings.TrimLeft(part, " \t(")) {
			return true
		}
	}
	return false
}

// describe renders an observed native action for the activity log.
func describe(o agent.Observation) string {
	command := o.Command
	if len(command) > maxActivityCommandBytes {
		command = strings.ToValidUTF8(command[:maxActivityCommandBytes], "") + "…"
	}
	if o.Kind == agent.ObservedCommand {
		outcome := "succeeded"
		if o.Background {
			outcome = "started in background; result not observed"
		} else if o.ExitCode != nil {
			outcome = fmt.Sprintf("exit %d", *o.ExitCode)
		} else if o.Failed {
			outcome = "failed"
		}
		return fmt.Sprintf("ran `%s` (%s)", command, outcome)
	}
	if o.Kind == agent.ObservedEdit {
		verb := "edited"
		if o.Failed {
			verb = "failed to edit"
		}
		return verb + " " + strings.Join(o.Paths, ", ")
	}
	if o.Kind == agent.ObservedCollaboration {
		if o.Failed {
			return "MCP " + o.Tool + " returned an error"
		}
		return "called MCP " + o.Tool
	}
	target := command
	if target == "" {
		target = o.Tool
	}
	return fmt.Sprintf("native permission or hook refused `%s`", target)
}
