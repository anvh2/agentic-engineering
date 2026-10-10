package videoeconomics_test

import (
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"example.com/videoeconomics/accounting"
	"example.com/videoeconomics/budget"
)

// ---- helpers

func known(t *testing.T, m int64) accounting.Amount {
	t.Helper()
	a, err := accounting.Known(m)
	if err != nil {
		t.Fatalf("Known(%d): %v", m, err)
	}
	return a
}

func att(t *testing.T, video string, out accounting.Outcome, gen, rev, proc int64) accounting.Attempt {
	t.Helper()
	return accounting.Attempt{VideoID: video, Outcome: out, Generation: known(t, gen), Review: known(t, rev), Processing: known(t, proc)}
}

func ledger(t *testing.T, cfg accounting.Config, attempts ...accounting.Attempt) *accounting.Ledger {
	t.Helper()
	l, err := accounting.NewLedger(cfg)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	for i, a := range attempts {
		if err := l.Record(a); err != nil {
			t.Fatalf("Record #%d: %v", i, err)
		}
	}
	return l
}

// accepted returns a ledger with n accepted single-attempt videos whose total generation cost is totalMicros (review and processing known zero).
func acceptedLedger(t *testing.T, n int, totalMicros int64) *accounting.Ledger {
	t.Helper()
	l := ledger(t, accounting.Config{})
	for i := 0; i < n; i++ {
		g := totalMicros / int64(n)
		if i == 0 {
			g += totalMicros % int64(n)
		}
		if err := l.Record(att(t, string(rune('a'+i)), accounting.Accepted, g, 0, 0)); err != nil {
			t.Fatal(err)
		}
	}
	return l
}

func eval(t *testing.T, l *accounting.Ledger, p budget.Policy) budget.Result {
	t.Helper()
	r, err := budget.Evaluate(l.Summary(), p)
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	return r
}

// ---- Task A: cost accounting

func TestAccounting_MultiAttemptAcceptedAndRejectedSpend(t *testing.T) {
	l := ledger(t, accounting.Config{},
		att(t, "v1", accounting.Rejected, 100_000, 20_000, 5_000),
		att(t, "v1", accounting.Rejected, 100_000, 20_000, 5_000),
		att(t, "v1", accounting.Accepted, 100_000, 20_000, 5_000),
	)
	s := l.Summary()
	want := accounting.Summary{
		Attempts: 3, Videos: 1, AcceptedVideos: 1, RejectedAttempts: 2,
		GenerationMicros: 300_000, ReviewMicros: 60_000, ProcessingMicros: 15_000,
		KnownSpendMicros: 375_000, RejectedSpendMicros: 250_000,
		UnknownCostAttempts: 0, CostComplete: true,
		CostPerAccepted:     accounting.Ratio{Num: 375_000, Den: 1},
		AcceptanceRate:      accounting.Ratio{Num: 1, Den: 1},
		AttemptsPerAccepted: accounting.Ratio{Num: 3, Den: 1},
	}
	if s != want {
		t.Fatalf("summary\n got %+v\nwant %+v", s, want)
	}
	// a second video that is never accepted: its spend still counts, the acceptance rate drops
	if err := l.Record(att(t, "v2", accounting.Rejected, 50_000, 10_000, 1_000)); err != nil {
		t.Fatal(err)
	}
	s = l.Summary()
	if s.Attempts != 4 || s.Videos != 2 || s.AcceptedVideos != 1 || s.RejectedAttempts != 3 {
		t.Fatalf("counts after v2: %+v", s)
	}
	if s.KnownSpendMicros != 436_000 || s.RejectedSpendMicros != 311_000 {
		t.Fatalf("spend after v2: known %d rejected %d", s.KnownSpendMicros, s.RejectedSpendMicros)
	}
	if s.AcceptanceRate != (accounting.Ratio{Num: 1, Den: 2}) || s.AttemptsPerAccepted != (accounting.Ratio{Num: 4, Den: 1}) || s.CostPerAccepted != (accounting.Ratio{Num: 436_000, Den: 1}) {
		t.Fatalf("ratios after v2: %+v %+v %+v", s.AcceptanceRate, s.AttemptsPerAccepted, s.CostPerAccepted)
	}
}

func TestAccounting_TwoAcceptedVideosAverage(t *testing.T) {
	l := ledger(t, accounting.Config{},
		att(t, "a", accounting.Accepted, 300_000, 0, 0),
		att(t, "b", accounting.Rejected, 200_000, 0, 0),
		att(t, "b", accounting.Accepted, 200_000, 0, 0),
	)
	s := l.Summary()
	if s.Videos != 2 || s.AcceptedVideos != 2 || s.Attempts != 3 {
		t.Fatalf("counts: %+v", s)
	}
	if s.CostPerAccepted != (accounting.Ratio{Num: 700_000, Den: 2}) || s.AttemptsPerAccepted != (accounting.Ratio{Num: 3, Den: 2}) || s.AcceptanceRate != (accounting.Ratio{Num: 2, Den: 2}) {
		t.Fatalf("ratios: %+v", s)
	}
}

func TestAccounting_ZeroAcceptedAndEmpty(t *testing.T) {
	l := ledger(t, accounting.Config{},
		att(t, "v1", accounting.Rejected, 10, 20, 30),
		att(t, "v2", accounting.Rejected, 1, 2, 3),
	)
	s := l.Summary()
	if s.AcceptedVideos != 0 || s.KnownSpendMicros != 66 || s.RejectedSpendMicros != 66 || s.Attempts != 2 || s.Videos != 2 {
		t.Fatalf("zero accepted summary: %+v", s)
	}
	if s.CostPerAccepted.Defined() || s.AttemptsPerAccepted.Defined() {
		t.Fatalf("cost per accepted and attempts per accepted must be undefined: %+v %+v", s.CostPerAccepted, s.AttemptsPerAccepted)
	}
	if !s.AcceptanceRate.Defined() || s.AcceptanceRate != (accounting.Ratio{Num: 0, Den: 2}) {
		t.Fatalf("acceptance rate = %+v, want 0/2", s.AcceptanceRate)
	}
	if _, ok := s.CostPerAccepted.RoundHalfUp(); ok {
		t.Fatal("RoundHalfUp of an undefined ratio must report ok=false")
	}

	empty := ledger(t, accounting.Config{}).Summary()
	if empty.Attempts != 0 || empty.Videos != 0 || empty.KnownSpendMicros != 0 || !empty.CostComplete {
		t.Fatalf("empty summary: %+v", empty)
	}
	if empty.AcceptanceRate.Defined() || empty.CostPerAccepted.Defined() || empty.AttemptsPerAccepted.Defined() {
		t.Fatalf("every ratio of an empty ledger must be undefined: %+v", empty)
	}
}

func TestAccounting_MissingCostIsNotZero(t *testing.T) {
	var zeroValue accounting.Amount
	if m, ok := zeroValue.Micros(); ok || m != 0 {
		t.Fatalf("the zero Amount must be unknown, got (%d, %v)", m, ok)
	}
	if m, ok := accounting.Unknown().Micros(); ok || m != 0 {
		t.Fatalf("Unknown() = (%d, %v)", m, ok)
	}
	if m, ok := known(t, 0).Micros(); !ok || m != 0 {
		t.Fatalf("Known(0) = (%d, %v), want known zero", m, ok)
	}

	missingReview := accounting.Attempt{VideoID: "v1", Outcome: accounting.Accepted, Generation: known(t, 100_000), Processing: known(t, 5_000)} // Review omitted: unknown
	l := ledger(t, accounting.Config{}, missingReview)
	s := l.Summary()
	if s.UnknownCostAttempts != 1 || s.CostComplete {
		t.Fatalf("a missing component must be counted: %+v", s)
	}
	if s.KnownSpendMicros != 105_000 || s.GenerationMicros != 100_000 || s.ReviewMicros != 0 || s.ProcessingMicros != 5_000 {
		t.Fatalf("known sums: %+v", s)
	}

	zeroReview := ledger(t, accounting.Config{}, att(t, "v1", accounting.Accepted, 100_000, 0, 5_000)).Summary()
	if zeroReview.UnknownCostAttempts != 0 || !zeroReview.CostComplete {
		t.Fatalf("a recorded zero is complete information: %+v", zeroReview)
	}
	if zeroReview.KnownSpendMicros != s.KnownSpendMicros {
		t.Fatal("known spend should match; only completeness differs")
	}

	allUnknown := ledger(t, accounting.Config{}, accounting.Attempt{VideoID: "x", Outcome: accounting.Rejected}, att(t, "y", accounting.Rejected, 1, 1, 1)).Summary()
	if allUnknown.UnknownCostAttempts != 1 || allUnknown.CostComplete || allUnknown.KnownSpendMicros != 3 || allUnknown.RejectedSpendMicros != 3 {
		t.Fatalf("attempt with every component unknown: %+v", allUnknown)
	}
}

func TestAccounting_InvalidInputs(t *testing.T) {
	for _, m := range []int64{-1, -1_000_000, -9_000_000_000_000} {
		if _, err := accounting.Known(m); !errors.Is(err, accounting.ErrNegativeAmount) {
			t.Fatalf("Known(%d) err = %v, want ErrNegativeAmount", m, err)
		}
	}
	if _, err := accounting.NewLedger(accounting.Config{MaxAttemptsPerVideo: -1}); !errors.Is(err, accounting.ErrInvalidConfig) {
		t.Fatalf("NewLedger(-1) err = %v", err)
	}
	l := ledger(t, accounting.Config{})
	bad := []accounting.Attempt{
		{VideoID: "", Outcome: accounting.Accepted},
		{VideoID: "v", Outcome: ""},
		{VideoID: "v", Outcome: "MAYBE"},
		{VideoID: "v", Outcome: "accepted"},
	}
	for i, a := range bad {
		if err := l.Record(a); !errors.Is(err, accounting.ErrInvalidAttempt) {
			t.Fatalf("bad attempt #%d err = %v, want ErrInvalidAttempt", i, err)
		}
	}
	if s := l.Summary(); s.Attempts != 0 || s.Videos != 0 || s.KnownSpendMicros != 0 {
		t.Fatalf("rejected attempts must not be recorded: %+v", s)
	}
}

func TestAccounting_RetryCeilingAndAcceptedVideos(t *testing.T) {
	l := ledger(t, accounting.Config{MaxAttemptsPerVideo: 2},
		att(t, "v1", accounting.Rejected, 10, 0, 0),
		att(t, "v1", accounting.Rejected, 10, 0, 0),
	)
	if err := l.Record(att(t, "v1", accounting.Accepted, 10, 0, 0)); !errors.Is(err, accounting.ErrRetryCeiling) {
		t.Fatalf("3rd attempt err = %v, want ErrRetryCeiling", err)
	}
	if s := l.Summary(); s.Attempts != 2 || s.KnownSpendMicros != 20 || s.AcceptedVideos != 0 {
		t.Fatalf("a refused attempt must leave no trace: %+v", s)
	}
	// the ceiling is per video
	if err := l.Record(att(t, "v2", accounting.Rejected, 10, 0, 0)); err != nil {
		t.Fatalf("another video is unaffected: %v", err)
	}
	// acceptance exactly on the last allowed attempt is fine
	l2 := ledger(t, accounting.Config{MaxAttemptsPerVideo: 2}, att(t, "v1", accounting.Rejected, 10, 0, 0), att(t, "v1", accounting.Accepted, 10, 0, 0))
	if s := l2.Summary(); s.AcceptedVideos != 1 || s.Attempts != 2 {
		t.Fatalf("accept on last allowed attempt: %+v", s)
	}
	// ceiling of one
	l3 := ledger(t, accounting.Config{MaxAttemptsPerVideo: 1}, att(t, "v1", accounting.Rejected, 1, 0, 0))
	if err := l3.Record(att(t, "v1", accounting.Rejected, 1, 0, 0)); !errors.Is(err, accounting.ErrRetryCeiling) {
		t.Fatalf("ceiling 1: %v", err)
	}
	// zero means no ceiling configured
	l4 := ledger(t, accounting.Config{})
	for i := 0; i < 25; i++ {
		if err := l4.Record(att(t, "v1", accounting.Rejected, 1, 0, 0)); err != nil {
			t.Fatalf("no ceiling configured, attempt %d: %v", i, err)
		}
	}
	// nothing after an accepted attempt
	if err := l2.Record(att(t, "v1", accounting.Rejected, 1, 0, 0)); !errors.Is(err, accounting.ErrVideoAlreadyAccepted) {
		t.Fatalf("attempt after acceptance: %v", err)
	}
	l5 := ledger(t, accounting.Config{}, att(t, "v1", accounting.Accepted, 1, 0, 0))
	if err := l5.Record(att(t, "v1", accounting.Accepted, 1, 0, 0)); !errors.Is(err, accounting.ErrVideoAlreadyAccepted) {
		t.Fatalf("second acceptance: %v", err)
	}
	if s := l5.Summary(); s.AcceptedVideos != 1 || s.Attempts != 1 {
		t.Fatalf("one accepted video: %+v", s)
	}
}

func TestAccounting_RoundingAndPrecision(t *testing.T) {
	cases := []struct {
		r    accounting.Ratio
		want int64
	}{
		{accounting.Ratio{Num: 1, Den: 2}, 1}, {accounting.Ratio{Num: 1, Den: 3}, 0}, {accounting.Ratio{Num: 2, Den: 3}, 1},
		{accounting.Ratio{Num: 5, Den: 2}, 3}, {accounting.Ratio{Num: 7, Den: 2}, 4}, {accounting.Ratio{Num: 0, Den: 5}, 0},
		{accounting.Ratio{Num: 10, Den: 5}, 2}, {accounting.Ratio{Num: 999_999, Den: 2}, 500_000}, {accounting.Ratio{Num: 1_000_001, Den: 2}, 500_001},
		{accounting.Ratio{Num: 499_999, Den: 1}, 499_999}, {accounting.Ratio{Num: 3, Den: 4}, 1}, {accounting.Ratio{Num: 1, Den: 4}, 0},
	}
	for _, c := range cases {
		got, ok := c.r.RoundHalfUp()
		if !ok || got != c.want {
			t.Errorf("%d/%d RoundHalfUp = (%d, %v), want %d", c.r.Num, c.r.Den, got, ok, c.want)
		}
	}
	if (accounting.Ratio{Num: 5, Den: 0}).Defined() || !(accounting.Ratio{Num: 0, Den: 1}).Defined() {
		t.Error("Defined must mean Den != 0")
	}
	if _, ok := (accounting.Ratio{Num: 5, Den: 0}).RoundHalfUp(); ok {
		t.Error("Den == 0 must report ok=false")
	}

	// 0.1 USD ten times is exactly 1 USD (a float64 sum would not be), and a very large total stays exact
	l := ledger(t, accounting.Config{})
	for i := 0; i < 10; i++ {
		if err := l.Record(att(t, "v1", accounting.Rejected, 100_000, 0, 0)); err != nil {
			t.Fatal(err)
		}
	}
	if s := l.Summary(); s.KnownSpendMicros != accounting.MicrosPerUSD {
		t.Fatalf("10 x 0.10 USD = %d micros, want %d", s.KnownSpendMicros, accounting.MicrosPerUSD)
	}
	big := ledger(t, accounting.Config{}, att(t, "v1", accounting.Accepted, 3_000_000_000_001, 3_000_000_000_001, 3_000_000_000_001))
	if s := big.Summary(); s.KnownSpendMicros != 9_000_000_000_003 {
		t.Fatalf("large total = %d", s.KnownSpendMicros)
	}
	if accounting.MicrosPerUSD != 1_000_000 {
		t.Fatal("MicrosPerUSD")
	}

	// the rounded cost per accepted video: 999,999 / 2 -> 500,000 and 1,000,001 / 2 -> 500,001
	s := acceptedLedger(t, 2, 999_999).Summary()
	if r, ok := s.CostPerAccepted.RoundHalfUp(); !ok || r != 500_000 || s.CostPerAccepted != (accounting.Ratio{Num: 999_999, Den: 2}) {
		t.Fatalf("999999/2: %+v rounded %d", s.CostPerAccepted, r)
	}
}

// ---- Task B: budget evaluation

func TestBudget_ThresholdsAndPreferredRangeAreSeparate(t *testing.T) {
	cases := []struct {
		cost     int64
		verdict  budget.Verdict
		rng      budget.PreferredRange
		overHard bool
	}{
		{100_000, budget.WithinTarget, budget.RangeBelow, false},
		{249_999, budget.WithinTarget, budget.RangeBelow, false},
		{250_000, budget.WithinTarget, budget.RangeInside, false},
		{300_000, budget.WithinTarget, budget.RangeInside, false},
		{350_000, budget.WithinTarget, budget.RangeInside, false},
		{350_001, budget.WithinTarget, budget.RangeAbove, false},
		{500_000, budget.WithinTarget, budget.RangeAbove, false},
		{500_001, budget.OverBudget, budget.RangeAbove, true},
		{900_000, budget.OverBudget, budget.RangeAbove, true},
	}
	for _, c := range cases {
		l := acceptedLedger(t, 1, c.cost)
		r := eval(t, l, budget.Policy{})
		if r.Verdict != c.verdict || r.PreferredRange != c.rng || r.OverHardCeiling != c.overHard {
			t.Errorf("cost %d: verdict %s range %s overHard %v; want %s %s %v", c.cost, r.Verdict, r.PreferredRange, r.OverHardCeiling, c.verdict, c.rng, c.overHard)
		}
		if r.Basis != budget.Measured || r.CeilingMicros != 500_000 || r.HardCeilingMicros != 500_000 || r.MinAcceptedVideos != 1 {
			t.Errorf("cost %d: basis/ceilings: %+v", c.cost, r)
		}
		if r.CostPerAccepted != (accounting.Ratio{Num: c.cost, Den: 1}) {
			t.Errorf("cost %d: CostPerAccepted %+v", c.cost, r.CostPerAccepted)
		}
		wantReasons := []string{}
		if c.verdict == budget.OverBudget {
			wantReasons = []string{budget.ReasonAboveCeiling}
		}
		if !reflect.DeepEqual(r.ReasonCodes, wantReasons) || r.ReasonCodes == nil {
			t.Errorf("cost %d: reason codes %#v, want %#v", c.cost, r.ReasonCodes, wantReasons)
		}
	}
	if budget.HardCeilingMicros != 500_000 || budget.PreferredLowMicros != 250_000 || budget.PreferredHighMicros != 350_000 {
		t.Fatal("business constants")
	}
}

func TestBudget_ExactComparisonNotRoundedAverage(t *testing.T) {
	// 2 accepted videos: ceiling total is 1,000,000
	if r := eval(t, acceptedLedger(t, 2, 999_999), budget.Policy{}); r.Verdict != budget.WithinTarget {
		t.Errorf("999,999 over 2 videos (499,999.5 each): %s", r.Verdict)
	}
	if r := eval(t, acceptedLedger(t, 2, 1_000_000), budget.Policy{}); r.Verdict != budget.WithinTarget {
		t.Errorf("exactly the ceiling over 2 videos: %s", r.Verdict)
	}
	r := eval(t, acceptedLedger(t, 2, 1_000_001), budget.Policy{})
	if r.Verdict != budget.OverBudget || !r.OverHardCeiling {
		t.Errorf("1,000,001 over 2 videos (500,000.5 each): %s overHard %v", r.Verdict, r.OverHardCeiling)
	}
	// preferred range edges use the same exact comparison: 2 videos, 699,999 total is 349,999.5 each (inside), 700,001 is above
	if r := eval(t, acceptedLedger(t, 2, 700_000), budget.Policy{}); r.PreferredRange != budget.RangeInside {
		t.Errorf("700,000 over 2: %s", r.PreferredRange)
	}
	if r := eval(t, acceptedLedger(t, 2, 700_001), budget.Policy{}); r.PreferredRange != budget.RangeAbove {
		t.Errorf("700,001 over 2: %s", r.PreferredRange)
	}
	if r := eval(t, acceptedLedger(t, 2, 499_999), budget.Policy{}); r.PreferredRange != budget.RangeBelow {
		t.Errorf("499,999 over 2 (249,999.5 each): %s", r.PreferredRange)
	}
	// a third of a micro over the ceiling is over: rounding the average first (500,000.33 -> 500,000) would hide it
	if r := eval(t, acceptedLedger(t, 3, 1_500_001), budget.Policy{}); r.Verdict != budget.OverBudget || !r.OverHardCeiling {
		t.Errorf("3 videos at 500,000.33 each: %s overHard %v", r.Verdict, r.OverHardCeiling)
	}
	if r := eval(t, acceptedLedger(t, 3, 1_050_001), budget.Policy{}); r.PreferredRange != budget.RangeAbove {
		t.Errorf("3 videos at 350,000.33 each: %s", r.PreferredRange)
	}
	if r := eval(t, acceptedLedger(t, 3, 749_999), budget.Policy{}); r.PreferredRange != budget.RangeBelow {
		t.Errorf("3 videos at 249,999.67 each: %s", r.PreferredRange)
	}
	if r := eval(t, acceptedLedger(t, 3, 1_500_000), budget.Policy{}); r.Verdict != budget.WithinTarget || r.CostPerAccepted != (accounting.Ratio{Num: 1_500_000, Den: 3}) {
		t.Errorf("3 videos at exactly 500,000: %+v", r)
	}
}

func TestBudget_RejectedSpendCountsAndSummaryIsPreserved(t *testing.T) {
	l := ledger(t, accounting.Config{},
		att(t, "v1", accounting.Rejected, 400_000, 0, 0),
		att(t, "v1", accounting.Accepted, 150_000, 25_000, 25_000), // the accepted attempt alone costs 200,000
	)
	r := eval(t, l, budget.Policy{})
	if r.Verdict != budget.OverBudget || r.CostPerAccepted != (accounting.Ratio{Num: 600_000, Den: 1}) {
		t.Fatalf("rejected spend must count: %+v", r)
	}
	if r.Summary != l.Summary() {
		t.Fatalf("the evaluated Summary must be preserved verbatim:\n got %+v\nwant %+v", r.Summary, l.Summary())
	}
	if r.Summary.Attempts != 2 || r.Summary.RejectedSpendMicros != 400_000 || r.Summary.Videos != 1 || r.Summary.AcceptedVideos != 1 {
		t.Fatalf("sample sizes: %+v", r.Summary)
	}
}

func TestBudget_ZeroAcceptedIsInsufficientEvidence(t *testing.T) {
	l := ledger(t, accounting.Config{}, att(t, "v1", accounting.Rejected, 900_000, 0, 0), att(t, "v2", accounting.Rejected, 900_000, 0, 0))
	r := eval(t, l, budget.Policy{})
	if r.Verdict != budget.InsufficientEvidence || !reflect.DeepEqual(r.ReasonCodes, []string{budget.ReasonNoAcceptedVideos}) {
		t.Fatalf("zero accepted: %s %v", r.Verdict, r.ReasonCodes)
	}
	if r.Summary.KnownSpendMicros != 1_800_000 || r.Summary.Attempts != 2 || r.PreferredRange != budget.RangeUnknown || r.OverHardCeiling {
		t.Fatalf("spend and sample sizes must still be reported, nothing may be invented: %+v", r)
	}
	if r.CostPerAccepted.Defined() && r.CostPerAccepted.Den != 0 {
		t.Fatalf("no cost per accepted exists: %+v", r.CostPerAccepted)
	}
	// an empty ledger too
	e := eval(t, ledger(t, accounting.Config{}), budget.Policy{})
	if e.Verdict != budget.InsufficientEvidence || !reflect.DeepEqual(e.ReasonCodes, []string{budget.ReasonNoAcceptedVideos}) {
		t.Fatalf("empty ledger: %+v", e)
	}
}

func TestBudget_UnknownCostIsNeverZero(t *testing.T) {
	unknownReview := func(video string, out accounting.Outcome, gen, proc int64) accounting.Attempt {
		return accounting.Attempt{VideoID: video, Outcome: out, Generation: known(t, gen), Processing: known(t, proc)}
	}
	// cheap known part, review cost missing: must not be WITHIN_TARGET
	r := eval(t, ledger(t, accounting.Config{}, unknownReview("v1", accounting.Accepted, 100_000, 5_000)), budget.Policy{})
	if r.Verdict != budget.InsufficientEvidence || !reflect.DeepEqual(r.ReasonCodes, []string{budget.ReasonCostIncomplete}) {
		t.Fatalf("incomplete cost: %s %v", r.Verdict, r.ReasonCodes)
	}
	if r.PreferredRange != budget.RangeUnknown || r.Summary.CostComplete || r.Summary.UnknownCostAttempts != 1 || r.Summary.KnownSpendMicros != 105_000 {
		t.Fatalf("incomplete cost details: %+v", r)
	}
	// the same data with a recorded zero review cost is complete evidence
	z := eval(t, ledger(t, accounting.Config{}, att(t, "v1", accounting.Accepted, 100_000, 0, 5_000)), budget.Policy{})
	if z.Verdict != budget.WithinTarget || z.PreferredRange != budget.RangeBelow {
		t.Fatalf("zero is not unknown: %+v", z)
	}
	// the known part alone already exceeds the ceiling: a lower bound proves OVER_BUDGET
	o := eval(t, ledger(t, accounting.Config{}, unknownReview("v1", accounting.Accepted, 600_000, 0)), budget.Policy{})
	if o.Verdict != budget.OverBudget || !o.OverHardCeiling || o.PreferredRange != budget.RangeAbove || o.Summary.CostComplete {
		t.Fatalf("lower bound above the ceiling: %+v", o)
	}
	// a lower bound above the preferred range but under the ceiling is still insufficient
	m := eval(t, ledger(t, accounting.Config{}, unknownReview("v1", accounting.Accepted, 400_000, 0)), budget.Policy{})
	if m.Verdict != budget.InsufficientEvidence || m.PreferredRange != budget.RangeAbove {
		t.Fatalf("lower bound 400,000: %+v", m)
	}
	// unknown cost on a REJECTED attempt counts too
	ur := ledger(t, accounting.Config{}, accounting.Attempt{VideoID: "v1", Outcome: accounting.Rejected, Generation: known(t, 10)}, att(t, "v1", accounting.Accepted, 10, 0, 0))
	if r := eval(t, ur, budget.Policy{}); r.Verdict != budget.InsufficientEvidence {
		t.Fatalf("unknown cost on a rejected attempt: %+v", r)
	}
}

func TestBudget_MinimumSampleAndOperatorCeilings(t *testing.T) {
	two := acceptedLedger(t, 2, 600_000) // 300,000 each
	r := eval(t, two, budget.Policy{MinAcceptedVideos: 3})
	if r.Verdict != budget.InsufficientEvidence || !reflect.DeepEqual(r.ReasonCodes, []string{budget.ReasonBelowMinSample}) || r.MinAcceptedVideos != 3 {
		t.Fatalf("below minimum sample: %+v", r)
	}
	three := acceptedLedger(t, 3, 900_000)
	if r := eval(t, three, budget.Policy{MinAcceptedVideos: 3}); r.Verdict != budget.WithinTarget {
		t.Fatalf("sample at minimum: %+v", r)
	}
	// the sample gate also applies to an over-budget measurement
	if r := eval(t, acceptedLedger(t, 2, 1_400_000), budget.Policy{MinAcceptedVideos: 3}); r.Verdict != budget.InsufficientEvidence {
		t.Fatalf("over budget with too small a sample: %+v", r)
	}

	// per-pipeline ceiling
	l := acceptedLedger(t, 1, 300_000)
	e := eval(t, l, budget.Policy{Pipeline: "economy", CeilingMicros: 250_000})
	if e.Verdict != budget.OverBudget || e.Pipeline != "economy" || e.CeilingMicros != 250_000 || e.HardCeilingMicros != 500_000 || e.OverHardCeiling {
		t.Fatalf("economy ceiling: %+v", e)
	}
	if r := eval(t, acceptedLedger(t, 1, 250_000), budget.Policy{Pipeline: "economy", CeilingMicros: 250_000}); r.Verdict != budget.WithinTarget || r.PreferredRange != budget.RangeInside {
		t.Fatalf("exactly at the operator ceiling: %+v", r)
	}
	if r := eval(t, l, budget.Policy{Pipeline: "premium", CeilingMicros: 500_000}); r.Verdict != budget.WithinTarget || r.CeilingMicros != 500_000 || r.Pipeline != "premium" {
		t.Fatalf("ceiling equal to the hard ceiling is allowed: %+v", r)
	}
	for _, p := range []budget.Policy{{CeilingMicros: 500_001}, {CeilingMicros: -1}, {MinAcceptedVideos: -1}, {Pipeline: "x", CeilingMicros: 9_000_000}} {
		if _, err := budget.Evaluate(l.Summary(), p); !errors.Is(err, budget.ErrInvalidPolicy) {
			t.Errorf("policy %+v: err = %v, want ErrInvalidPolicy", p, err)
		}
		if _, err := budget.EvaluateForecast(100_000, p); !errors.Is(err, budget.ErrInvalidPolicy) {
			t.Errorf("forecast policy %+v: err = %v, want ErrInvalidPolicy", p, err)
		}
	}
}

func TestBudget_ForecastIsNeverMeasured(t *testing.T) {
	f, err := budget.EvaluateForecast(300_000, budget.Policy{Pipeline: "standard"})
	if err != nil {
		t.Fatal(err)
	}
	if f.Basis != budget.Forecast || f.Verdict != budget.WithinTarget || f.PreferredRange != budget.RangeInside || f.Pipeline != "standard" {
		t.Fatalf("forecast: %+v", f)
	}
	if f.Summary != (accounting.Summary{}) {
		t.Fatalf("a forecast carries no measured data: %+v", f.Summary)
	}
	if f.CostPerAccepted != (accounting.Ratio{Num: 300_000, Den: 1}) || f.CeilingMicros != 500_000 || f.ReasonCodes == nil || len(f.ReasonCodes) != 0 {
		t.Fatalf("forecast details: %+v", f)
	}
	m := eval(t, acceptedLedger(t, 1, 300_000), budget.Policy{})
	if m.Basis != budget.Measured || m.Basis == f.Basis {
		t.Fatalf("measured vs forecast basis: %s %s", m.Basis, f.Basis)
	}
	cases := []struct {
		cost    int64
		verdict budget.Verdict
		rng     budget.PreferredRange
		hard    bool
	}{{100_000, budget.WithinTarget, budget.RangeBelow, false}, {500_000, budget.WithinTarget, budget.RangeAbove, false}, {500_001, budget.OverBudget, budget.RangeAbove, true}, {0, budget.WithinTarget, budget.RangeBelow, false}}
	for _, c := range cases {
		r, err := budget.EvaluateForecast(c.cost, budget.Policy{})
		if err != nil || r.Verdict != c.verdict || r.PreferredRange != c.rng || r.OverHardCeiling != c.hard || r.Basis != budget.Forecast {
			t.Errorf("forecast %d: %+v err %v", c.cost, r, err)
		}
	}
	if o, _ := budget.EvaluateForecast(300_000, budget.Policy{CeilingMicros: 200_000}); o.Verdict != budget.OverBudget || !reflect.DeepEqual(o.ReasonCodes, []string{budget.ReasonAboveCeiling}) {
		t.Errorf("forecast over the operator ceiling: %+v", o)
	}
	if _, err := budget.EvaluateForecast(-1, budget.Policy{}); !errors.Is(err, budget.ErrInvalidForecast) {
		t.Errorf("negative forecast: %v", err)
	}
}

func TestBudget_StructuredResultForReports(t *testing.T) {
	l := ledger(t, accounting.Config{}, att(t, "v1", accounting.Rejected, 100_000, 0, 0), att(t, "v1", accounting.Accepted, 200_000, 0, 0))
	r := eval(t, l, budget.Policy{Pipeline: "standard", CeilingMicros: 400_000})
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]any{"verdict": "WITHIN_TARGET", "basis": "MEASURED", "pipeline": "standard", "ceiling_micros": 400000.0, "hard_ceiling_micros": 500000.0, "min_accepted_videos": 1.0, "over_hard_ceiling": false, "preferred_range": "INSIDE"} {
		if !reflect.DeepEqual(m[k], want) {
			t.Errorf("json %q = %#v, want %#v (%s)", k, m[k], want, raw)
		}
	}
	if rc, ok := m["reason_codes"].([]any); !ok || len(rc) != 0 {
		t.Errorf("reason_codes must be an empty array, got %#v", m["reason_codes"])
	}
	cpa, _ := m["cost_per_accepted"].(map[string]any)
	if cpa["num"] != 300000.0 || cpa["den"] != 1.0 {
		t.Errorf("cost_per_accepted = %#v", m["cost_per_accepted"])
	}
	sum, _ := m["summary"].(map[string]any)
	for k, want := range map[string]any{"attempts": 2.0, "videos": 1.0, "accepted_videos": 1.0, "rejected_attempts": 1.0, "known_spend_micros": 300000.0, "rejected_spend_micros": 100000.0, "cost_complete": true, "unknown_cost_attempts": 0.0} {
		if sum[k] != want {
			t.Errorf("json summary.%s = %#v, want %#v", k, sum[k], want)
		}
	}
	var back budget.Result
	if err := json.Unmarshal(raw, &back); err != nil || !reflect.DeepEqual(back, r) {
		t.Errorf("round trip: %v\n got %+v\nwant %+v", err, back, r)
	}
}

// ---- cross-task requirements

// Task B must consume Task A's code: package budget imports package accounting and does not carry its own copy of accounting's types.
func TestBudget_ConsumesAccountingPackage(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, "budget", func(fi os.FileInfo) bool { return !strings.HasSuffix(fi.Name(), "_test.go") }, 0)
	if err != nil {
		t.Fatal(err)
	}
	imports := false
	for _, pkg := range pkgs {
		for _, f := range pkg.Files {
			for _, im := range f.Imports {
				if im.Path.Value == `"example.com/videoeconomics/accounting"` {
					imports = true
				}
			}
			for _, d := range f.Decls {
				gd, ok := d.(*ast.GenDecl)
				if !ok {
					continue
				}
				for _, sp := range gd.Specs {
					if ts, ok := sp.(*ast.TypeSpec); ok {
						switch ts.Name.Name {
						case "Ledger", "Amount", "Ratio", "Summary", "Attempt", "Outcome":
							t.Errorf("package budget declares its own %s instead of using accounting.%s", ts.Name.Name, ts.Name.Name)
						}
					}
				}
			}
		}
	}
	if !imports {
		t.Error("package budget does not import example.com/videoeconomics/accounting")
	}
}

// Money is never floating point: no float type is used anywhere in the production code of either package.
func TestNoFloatingPointInProductionCode(t *testing.T) {
	for _, dir := range []string{"accounting", "budget"} {
		fset := token.NewFileSet()
		pkgs, err := parser.ParseDir(fset, dir, func(fi os.FileInfo) bool { return !strings.HasSuffix(fi.Name(), "_test.go") }, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, pkg := range pkgs {
			for name, f := range pkg.Files {
				ast.Inspect(f, func(n ast.Node) bool {
					switch x := n.(type) {
					case *ast.Ident:
						if x.Name == "float32" || x.Name == "float64" {
							t.Errorf("%s uses %s", filepath.Base(name), x.Name)
						}
					case *ast.BasicLit:
						if x.Kind == token.FLOAT {
							t.Errorf("%s has a floating-point literal %s", filepath.Base(name), x.Value)
						}
					}
					return true
				})
			}
		}
	}
}
