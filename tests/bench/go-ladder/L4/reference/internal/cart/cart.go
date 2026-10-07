package cart

import "math"

// Item is one line on an order. Amounts are in cents.
type Item struct {
	PriceCents int
	Qty        int
}

// Subtotal returns the sum of price*qty over all items.
func Subtotal(items []Item) int {
	total := 0
	for _, it := range items {
		total += it.PriceCents * it.Qty
	}
	return total
}

// DiscountCents returns the discount, in cents, that promo code gives on a subtotal.
func DiscountCents(subtotalCents int, code string) int {
	if subtotalCents <= 0 {
		return 0
	}
	switch code {
	case "SAVE10":
		return (subtotalCents*10 + 50) / 100
	case "SAVE20":
		return (subtotalCents*20 + 50) / 100
	case "FLAT5":
		if subtotalCents < 500 {
			return subtotalCents
		}
		return 500
	}
	return 0
}

// TaxCents returns the tax, in cents, for amountCents at ratePercent.
func TaxCents(amountCents int, ratePercent float64) int {
	if amountCents <= 0 {
		return 0
	}
	return int(math.Floor(float64(amountCents)*ratePercent/100 + 0.5))
}

// TotalCents returns what the customer pays, in cents.
func TotalCents(items []Item, code string, ratePercent float64) int {
	sub := Subtotal(items)
	discounted := sub - DiscountCents(sub, code)
	return discounted + TaxCents(discounted, ratePercent)
}
