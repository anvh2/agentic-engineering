package cart

import "testing"

func TestDiscountCentsHidden(t *testing.T) {
	tests := []struct {
		sub  int
		code string
		want int
	}{
		{5, "SAVE10", 1},
		{14, "SAVE10", 1},
		{7, "SAVE20", 1},
		{8, "SAVE20", 2},
		{1000, "FLAT5", 500},
		{300, "FLAT5", 300},
		{0, "FLAT5", 0},
		{1000, "", 0},
		{1000, "BOGUS", 0},
	}
	for _, tt := range tests {
		if got := DiscountCents(tt.sub, tt.code); got != tt.want {
			t.Errorf("DiscountCents(%d, %q) = %d, want %d", tt.sub, tt.code, got, tt.want)
		}
	}
}

func TestTaxCentsHidden(t *testing.T) {
	tests := []struct {
		amount int
		rate   float64
		want   int
	}{
		{999, 10, 100},
		{10, 5, 1},
		{-100, 10, 0},
		{1000, 0, 0},
	}
	for _, tt := range tests {
		if got := TaxCents(tt.amount, tt.rate); got != tt.want {
			t.Errorf("TaxCents(%d, %v) = %d, want %d", tt.amount, tt.rate, got, tt.want)
		}
	}
}

func TestTotalCentsHidden(t *testing.T) {
	tests := []struct {
		items []Item
		code  string
		rate  float64
		want  int
	}{
		{[]Item{{250, 2}, {199, 3}}, "", 8, 1185},
		{[]Item{{400, 1}}, "FLAT5", 8, 0},
		{[]Item{{1000, 1}}, "SAVE20", 8.25, 866},
		{[]Item{{1000, 1}}, "SAVE10", 10, 990},
		{nil, "SAVE10", 10, 0},
	}
	for _, tt := range tests {
		if got := TotalCents(tt.items, tt.code, tt.rate); got != tt.want {
			t.Errorf("TotalCents(%v, %q, %v) = %d, want %d", tt.items, tt.code, tt.rate, got, tt.want)
		}
	}
}

func TestSubtotalUnchangedHidden(t *testing.T) {
	if got := Subtotal(nil); got != 0 {
		t.Errorf("Subtotal(nil) = %d", got)
	}
	if got := Subtotal([]Item{{100, 0}, {50, 2}}); got != 100 {
		t.Errorf("Subtotal = %d, want 100", got)
	}
}
