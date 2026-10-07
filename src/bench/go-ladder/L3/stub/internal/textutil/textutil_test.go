package textutil

import "testing"

func TestPadLeft(t *testing.T) {
	if got := PadLeft("ab", 5); got != "   ab" {
		t.Errorf("PadLeft(ab, 5) = %q", got)
	}
	if got := PadLeft("héllo", 5); got != "héllo" {
		t.Errorf("PadLeft(héllo, 5) = %q", got)
	}
}

func TestCountWords(t *testing.T) {
	if got := CountWords("  one two\tthree\n"); got != 3 {
		t.Errorf("CountWords = %d, want 3", got)
	}
	if got := CountWords(""); got != 0 {
		t.Errorf("CountWords(empty) = %d, want 0", got)
	}
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		in   string
		max  int
		want string
	}{
		{"short", 10, "short"},
		{"exactly10!", 10, "exactly10!"},
		{"hello world", 8, "hello..."},
	}
	for _, tt := range tests {
		if got := Truncate(tt.in, tt.max); got != tt.want {
			t.Errorf("Truncate(%q, %d) = %q, want %q", tt.in, tt.max, got, tt.want)
		}
	}
}
