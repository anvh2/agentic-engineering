package textutil

import "testing"

func TestTruncateHidden(t *testing.T) {
	tests := []struct {
		in   string
		max  int
		want string
	}{
		{"héllo wörld", 8, "héllo..."},
		{"日本語のテキストです", 5, "日本..."},
		{"hello", 3, "hel"},
		{"hello", 2, "he"},
		{"abcdef", 4, "a..."},
		{"abc", 3, "abc"},
		{"x", 0, ""},
		{"hello", -1, ""},
		{"héllo", 5, "héllo"},
		{"", 5, ""},
	}
	for _, tt := range tests {
		if got := Truncate(tt.in, tt.max); got != tt.want {
			t.Errorf("Truncate(%q, %d) = %q, want %q", tt.in, tt.max, got, tt.want)
		}
	}
}

func TestOtherFunctionsUnchangedHidden(t *testing.T) {
	if got := PadLeft("日本", 4); got != "  日本" {
		t.Errorf("PadLeft = %q", got)
	}
	if got := PadLeft("abc", 2); got != "abc" {
		t.Errorf("PadLeft = %q", got)
	}
	if got := CountWords("a  b   c d"); got != 4 {
		t.Errorf("CountWords = %d", got)
	}
}
