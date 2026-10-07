package slug

import "testing"

func TestSlugifyHidden(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Café au lait", "caf-au-lait"},
		{"a_b", "a-b"},
		{"  ABC123 ", "abc123"},
		{"ñandú", "and"},
		{"!!!", ""},
		{"one--two__three", "one-two-three"},
		{"Version 2.0 Release", "version-2-0-release"},
	}
	for _, tt := range tests {
		if got := Slugify(tt.in); got != tt.want {
			t.Errorf("Slugify(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
