package slug

import "testing"

func TestSlugify(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Hello World", "hello-world"},
		{"  Go  is   fun  ", "go-is-fun"},
		{"Already-slugged", "already-slugged"},
		{"Rock & Roll!", "rock-roll"},
		{"", ""},
		{"---", ""},
	}
	for _, tt := range tests {
		if got := Slugify(tt.in); got != tt.want {
			t.Errorf("Slugify(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
