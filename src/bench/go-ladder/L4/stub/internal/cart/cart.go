package cart

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
	switch code {
	case "SAVE10":
		return subtotalCents / 10
	case "SAVE20":
		return subtotalCents / 5
	}
	return 0
}

// TaxCents returns the tax, in cents, for amountCents at ratePercent.
func TaxCents(amountCents int, ratePercent float64) int {
	return int(float64(amountCents) * ratePercent / 100)
}

// TotalCents returns what the customer pays, in cents.
func TotalCents(items []Item, code string, ratePercent float64) int {
	sub := Subtotal(items)
	return sub + TaxCents(sub, ratePercent)
}
