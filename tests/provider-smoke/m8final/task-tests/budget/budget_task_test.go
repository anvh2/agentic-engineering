package budget

import (
	"testing"

	"example.com/videoeconomics/accounting"
)

func TestBudgetTask(t *testing.T) {
	// Dependency check: the accounting package of the previous task must already be implemented in this worktree.
	if a, err := accounting.Known(5); err != nil {
		t.Fatalf("dependency check: accounting.Known(5): %v (is the previous task integrated?)", err)
	} else if m, ok := a.Micros(); !ok || m != 5 {
		t.Fatalf("dependency check: Micros() = %d, %v", m, ok)
	}
	l, err := accounting.NewLedger(accounting.Config{})
	if err != nil {
		t.Fatal(err)
	}
	gen, _ := accounting.Known(300_000)
	zero, _ := accounting.Known(0)
	if err := l.Record(accounting.Attempt{VideoID: "v1", Outcome: accounting.Accepted, Generation: gen, Review: zero, Processing: zero}); err != nil {
		t.Fatal(err)
	}
	res, err := Evaluate(l.Summary(), Policy{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict != WithinTarget || res.Basis != Measured || res.CeilingMicros != HardCeilingMicros {
		t.Fatalf("result = %+v", res)
	}
	over, err := EvaluateForecast(600_000, Policy{})
	if err != nil || over.Verdict != OverBudget || over.Basis != Forecast {
		t.Fatalf("forecast = %+v, %v", over, err)
	}
	if _, err := Evaluate(l.Summary(), Policy{CeilingMicros: HardCeilingMicros + 1}); err == nil {
		t.Fatal("expected an invalid-policy error")
	}
}
