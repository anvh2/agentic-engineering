package kv

import "strings"

// Parse parses comma-separated "key=value" pairs into a map.
//
//   - Whitespace around keys and values is trimmed.
//   - Empty segments are ignored.
//   - A segment without "=" becomes a key with an empty value.
//   - If a key appears more than once, the last value wins.
func Parse(s string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out
}
