package kv

import "strings"

// Parse parses comma-separated "key=value" pairs into a map.
//
//   - Whitespace around keys and values is trimmed.
//   - Empty segments are ignored.
//   - A segment without "=" becomes a key with an empty value.
//   - If a key appears more than once, the last value wins.
//   - A value whose first non-space character is a double quote is quoted.
func Parse(s string) map[string]string {
	out := map[string]string{}
	n := len(s)
	i := 0
	for i < n {
		start := i
		for i < n && s[i] != '=' && s[i] != ',' {
			i++
		}
		key := strings.TrimSpace(s[start:i])
		val := ""
		hasEq := false
		if i < n && s[i] == '=' {
			hasEq = true
			i++
			j := i
			for j < n && (s[j] == ' ' || s[j] == '\t') {
				j++
			}
			if j < n && s[j] == '"' {
				i = j + 1
				var b strings.Builder
				for i < n {
					c := s[i]
					if c == '\\' && i+1 < n && (s[i+1] == '"' || s[i+1] == '\\') {
						b.WriteByte(s[i+1])
						i += 2
						continue
					}
					if c == '"' {
						i++
						break
					}
					b.WriteByte(c)
					i++
				}
				val = b.String()
				for i < n && s[i] != ',' {
					i++
				}
			} else {
				vs := i
				for i < n && s[i] != ',' {
					i++
				}
				val = strings.TrimSpace(s[vs:i])
			}
		}
		if i < n && s[i] == ',' {
			i++
		}
		if key == "" && !hasEq {
			continue
		}
		out[key] = val
	}
	return out
}
