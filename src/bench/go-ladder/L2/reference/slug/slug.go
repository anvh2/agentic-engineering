package slug

import "strings"

// Slugify converts s into a URL slug.
func Slugify(s string) string {
	var b strings.Builder
	pendingDash := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z':
			c = c - 'A' + 'a'
			fallthrough
		case (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'):
			if pendingDash && b.Len() > 0 {
				b.WriteByte('-')
			}
			pendingDash = false
			b.WriteByte(c)
		default:
			pendingDash = true
		}
	}
	return b.String()
}
