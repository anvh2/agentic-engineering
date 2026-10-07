package calculator

import "testing"

func TestAddHidden(t *testing.T) {
	tests := []struct{ a, b, want int }{
		{1000000, 2000000, 3000000},
		{-1000000, 1, -999999},
		{7, -7, 0},
		{123456789, 987654321, 1111111110},
	}
	for _, tt := range tests {
		if got := Add(tt.a, tt.b); got != tt.want {
			t.Errorf("Add(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}
