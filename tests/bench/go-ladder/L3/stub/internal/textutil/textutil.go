package textutil

import "strings"

// PadLeft pads s on the left with spaces until it is at least width runes long.
func PadLeft(s string, width int) string {
	n := len([]rune(s))
	if n >= width {
		return s
	}
	return strings.Repeat(" ", width-n) + s
}

// CountWords returns the number of whitespace-separated words in s.
func CountWords(s string) int {
	return len(strings.Fields(s))
}

// Truncate shortens s so that it is at most max runes long, marking a cut with "...".
func Truncate(s string, max int) string {
	if len(s) < max {
		return s
	}
	return s[:max-3] + "..."
}
