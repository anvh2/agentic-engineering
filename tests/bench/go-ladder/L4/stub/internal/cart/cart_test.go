package cart

import "testing"

func TestSubtotal(t *testing.T) {
	items := []Item{{250, 2}, {199, 3}}
	if got := Subtotal(items); got != 1097 {
		t.Errorf("Subtotal = %d, want 1097", got)
	}
}

func TestDiscountCents(t *testing.T) {
	tests := []struct {
		sub  int
		code string
		want int
	}{
		{1000, "SAVE10", 100},
		{1000, "SAVE20", 200},
		{1000, "NOPE", 0},
		{15, "SAVE10", 2},
	}
	for _, tt := range tests {
		if got := DiscountCents(tt.sub, tt.code); got != tt.want {
			t.Errorf("DiscountCents(%d, %q) = %d, want %d", tt.sub, tt.code, got, tt.want)
		}
	}
}

func TestTaxCents(t *testing.T) {
	if got := TaxCents(1000, 8.25); got != 83 {
		t.Errorf("TaxCents(1000, 8.25) = %d, want 83", got)
	}
	if got := TaxCents(0, 10); got != 0 {
		t.Errorf("TaxCents(0, 10) = %d, want 0", got)
	}
}

func TestTotalCents(t *testing.T) {
	items := []Item{{1000, 1}}
	if got := TotalCents(items, "SAVE10", 10); got != 990 {
		t.Errorf("TotalCents = %d, want 990", got)
	}
	if got := TotalCents(items, "", 10); got != 1100 {
		t.Errorf("TotalCents (no code) = %d, want 1100", got)
	}
}
