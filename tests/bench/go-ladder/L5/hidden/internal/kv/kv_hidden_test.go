package kv

import (
	"reflect"
	"testing"
)

func TestParseQuotedHidden(t *testing.T) {
	tests := []struct {
		in   string
		want map[string]string
	}{
		{`a="say \"hi\"",b=1`, map[string]string{"a": `say "hi"`, "b": "1"}},
		{`a="x=y"`, map[string]string{"a": "x=y"}},
		{`a="back\\slash"`, map[string]string{"a": `back\slash`}},
		{`a="unterminated,b=2`, map[string]string{"a": "unterminated,b=2"}},
		{`a=b"c,d=1`, map[string]string{"a": `b"c`, "d": "1"}},
		{`a="x"junk,b=2`, map[string]string{"a": "x", "b": "2"}},
		{`a="",b=1`, map[string]string{"a": "", "b": "1"}},
		{`a = "q,r" , b = 2`, map[string]string{"a": "q,r", "b": "2"}},
		{`"k"=v`, map[string]string{`"k"`: "v"}},
	}
	for _, tt := range tests {
		if got := Parse(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("Parse(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestParseBackwardCompatibleHidden(t *testing.T) {
	tests := []struct {
		in   string
		want map[string]string
	}{
		{"=1", map[string]string{"": "1"}},
		{"a=", map[string]string{"a": ""}},
		{"  ", map[string]string{}},
		{"a==b", map[string]string{"a": "=b"}},
		{"x=1,y,z=3", map[string]string{"x": "1", "y": "", "z": "3"}},
		{"a=1, b = two words ,c=3", map[string]string{"a": "1", "b": "two words", "c": "3"}},
	}
	for _, tt := range tests {
		if got := Parse(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("Parse(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}
