package kv

import (
	"reflect"
	"testing"
)

func TestParseExistingBehavior(t *testing.T) {
	tests := []struct {
		in   string
		want map[string]string
	}{
		{"a=1,b=2", map[string]string{"a": "1", "b": "2"}},
		{" a = 1 , b=2 ", map[string]string{"a": "1", "b": "2"}},
		{",,a=1,,", map[string]string{"a": "1"}},
		{"flag", map[string]string{"flag": ""}},
		{"a=1,a=2", map[string]string{"a": "2"}},
		{"a=b=c", map[string]string{"a": "b=c"}},
		{"", map[string]string{}},
	}
	for _, tt := range tests {
		if got := Parse(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("Parse(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestParseQuotedValues(t *testing.T) {
	tests := []struct {
		in   string
		want map[string]string
	}{
		{`a="x,y",b=2`, map[string]string{"a": "x,y", "b": "2"}},
		{`a=" padded ",b=c`, map[string]string{"a": " padded ", "b": "c"}},
	}
	for _, tt := range tests {
		if got := Parse(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("Parse(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}
