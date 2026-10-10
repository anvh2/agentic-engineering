// Package budget evaluates the measured (or forecast) cost per accepted affiliate video against the business cost ceiling.
// It builds on the Summary produced by package accounting.
package budget

import (
	"errors"

	"example.com/videoeconomics/accounting"
)

// Business constants, in micro-USD: the hard ceiling for the cost per accepted video, and the preferred operating range (both ends inclusive).
const (
	HardCeilingMicros   int64 = 500_000
	PreferredLowMicros  int64 = 250_000
	PreferredHighMicros int64 = 350_000
)

// Verdict is the outcome of an evaluation.
type Verdict string

const (
	WithinTarget         Verdict = "WITHIN_TARGET"
	OverBudget           Verdict = "OVER_BUDGET"
	InsufficientEvidence Verdict = "INSUFFICIENT_EVIDENCE"
)

// Basis says whether a result comes from measured history or from a forecast.
type Basis string

const (
	Measured Basis = "MEASURED"
	Forecast Basis = "FORECAST"
)

// PreferredRange says where the cost per accepted video lies relative to the preferred range [PreferredLowMicros, PreferredHighMicros].
type PreferredRange string

const (
	RangeInside  PreferredRange = "INSIDE"
	RangeBelow   PreferredRange = "BELOW"
	RangeAbove   PreferredRange = "ABOVE"
	RangeUnknown PreferredRange = "UNKNOWN"
)

// Reason codes explain a verdict other than WithinTarget.
const (
	ReasonNoAcceptedVideos = "NO_ACCEPTED_VIDEOS"
	ReasonBelowMinSample   = "BELOW_MIN_SAMPLE"
	ReasonCostIncomplete   = "COST_INCOMPLETE"
	ReasonAboveCeiling     = "ABOVE_CEILING"
)

var (
	// ErrInvalidPolicy is returned for a negative CeilingMicros, a CeilingMicros above HardCeilingMicros, or a negative MinAcceptedVideos.
	ErrInvalidPolicy = errors.New("budget: invalid policy")
	// ErrInvalidForecast is returned by EvaluateForecast for a negative forecast.
	ErrInvalidForecast = errors.New("budget: invalid forecast")
)

// Policy is the operator-supplied configuration of one evaluation.
type Policy struct {
	// Pipeline is a free label such as "economy", "standard" or "premium"; it is copied to the Result and has no other effect.
	Pipeline string `json:"pipeline"`
	// CeilingMicros is the operator's cost-per-accepted-video ceiling for this pipeline. Zero means none was supplied: HardCeilingMicros applies.
	// A supplied ceiling can only tighten the hard ceiling: above HardCeilingMicros it is invalid.
	CeilingMicros int64 `json:"ceiling_micros"`
	// MinAcceptedVideos is the smallest number of accepted videos that makes a measurement sufficient evidence. Zero means 1.
	MinAcceptedVideos int `json:"min_accepted_videos"`
}

// Result is the structured outcome of an evaluation, meant to be serialized into a decision report.
type Result struct {
	Verdict Verdict `json:"verdict"`
	Basis   Basis   `json:"basis"`
	// Pipeline is Policy.Pipeline.
	Pipeline string `json:"pipeline"`
	// CeilingMicros is the effective ceiling the verdict was judged against; HardCeilingMicros is always the business constant.
	CeilingMicros     int64 `json:"ceiling_micros"`
	HardCeilingMicros int64 `json:"hard_ceiling_micros"`
	// MinAcceptedVideos is the effective minimum sample (Policy.MinAcceptedVideos, or 1 when it was zero).
	MinAcceptedVideos int `json:"min_accepted_videos"`
	// OverHardCeiling is true when the cost per accepted video is provably above HardCeilingMicros (a lower bound counts as proof).
	OverHardCeiling bool `json:"over_hard_ceiling"`
	// PreferredRange is reported separately from the verdict.
	PreferredRange PreferredRange `json:"preferred_range"`
	// CostPerAccepted is the exact cost per accepted video that was evaluated (known spend / accepted videos). For a forecast it is {forecast, 1}.
	CostPerAccepted accounting.Ratio `json:"cost_per_accepted"`
	// Summary is the accounting summary that was evaluated, unchanged. For a forecast it is the zero Summary.
	Summary accounting.Summary `json:"summary"`
	// ReasonCodes holds the Reason* code behind a verdict other than WithinTarget. It is never nil; it is empty for WithinTarget.
	ReasonCodes []string `json:"reason_codes"`
}

// newResult validates the policy (ErrInvalidPolicy) and returns a Result with Basis, Pipeline, the effective CeilingMicros and MinAcceptedVideos,
// HardCeilingMicros and an empty (non-nil) ReasonCodes filled in. Every other field is left for the caller.
func newResult(basis Basis, p Policy) (Result, error) {
	if p.CeilingMicros < 0 || p.CeilingMicros > HardCeilingMicros || p.MinAcceptedVideos < 0 {
		return Result{}, ErrInvalidPolicy
	}
	r := Result{Basis: basis, Pipeline: p.Pipeline, CeilingMicros: p.CeilingMicros, HardCeilingMicros: HardCeilingMicros, MinAcceptedVideos: p.MinAcceptedVideos, ReasonCodes: []string{}}
	if r.CeilingMicros == 0 {
		r.CeilingMicros = HardCeilingMicros
	}
	if r.MinAcceptedVideos == 0 {
		r.MinAcceptedVideos = 1
	}
	return r, nil
}
