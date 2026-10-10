package accounting

import (
	"errors"
	"testing"
)

func mustKnown(t *testing.T, m int64) Amount {
	t.Helper()
	a, err := Known(m)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestAccountingTask(t *testing.T) {
	if _, err := Known(-1); !errors.Is(err, ErrNegativeAmount) {
		t.Fatalf("Known(-1) err = %v", err)
	}
	if m, ok := Unknown().Micros(); ok || m != 0 {
		t.Fatalf("Unknown().Micros() = %d, %v", m, ok)
	}
	l, err := NewLedger(Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := l.Record(Attempt{VideoID: "v1", Outcome: Rejected, Generation: mustKnown(t, 100), Review: mustKnown(t, 10), Processing: mustKnown(t, 1)}); err != nil {
		t.Fatal(err)
	}
	if err := l.Record(Attempt{VideoID: "v1", Outcome: Accepted, Generation: mustKnown(t, 100), Review: mustKnown(t, 10), Processing: mustKnown(t, 1)}); err != nil {
		t.Fatal(err)
	}
	s := l.Summary()
	if s.Attempts != 2 || s.AcceptedVideos != 1 || s.KnownSpendMicros != 222 || s.RejectedSpendMicros != 111 || !s.CostComplete {
		t.Fatalf("summary = %+v", s)
	}
	if s.CostPerAccepted != (Ratio{222, 1}) || s.AttemptsPerAccepted != (Ratio{2, 1}) {
		t.Fatalf("ratios = %+v %+v", s.CostPerAccepted, s.AttemptsPerAccepted)
	}
	if r, ok := (Ratio{1, 2}).RoundHalfUp(); !ok || r != 1 {
		t.Fatalf("RoundHalfUp(1/2) = %d, %v", r, ok)
	}
	if err := l.Record(Attempt{VideoID: "", Outcome: Accepted}); !errors.Is(err, ErrInvalidAttempt) {
		t.Fatalf("empty video err = %v", err)
	}
}
