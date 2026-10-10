// Package accounting records the generation attempts made for affiliate videos and derives exact, integer-based cost metrics from them.
//
// All money is an integer number of micro-USD (1 USD = 1_000_000 micros). Floating-point numbers are never used for money.
package accounting

import "errors"

// MicrosPerUSD is the number of micro-USD in one US dollar.
const MicrosPerUSD int64 = 1_000_000

var (
	// ErrNegativeAmount is returned by Known for a negative amount.
	ErrNegativeAmount = errors.New("accounting: negative amount")
	// ErrInvalidAttempt is returned by Ledger.Record for an attempt with an empty VideoID or an Outcome that is neither Accepted nor Rejected.
	ErrInvalidAttempt = errors.New("accounting: invalid attempt")
	// ErrInvalidConfig is returned by NewLedger for a negative Config.MaxAttemptsPerVideo.
	ErrInvalidConfig = errors.New("accounting: invalid config")
	// ErrRetryCeiling is returned by Ledger.Record when the video already has Config.MaxAttemptsPerVideo recorded attempts.
	ErrRetryCeiling = errors.New("accounting: retry ceiling reached")
	// ErrVideoAlreadyAccepted is returned by Ledger.Record for an attempt on a video that already has an Accepted attempt.
	ErrVideoAlreadyAccepted = errors.New("accounting: video already accepted")
)

// Amount is a monetary amount in micro-USD that is either known or unknown. The zero Amount is UNKNOWN: a missing cost is never zero dollars.
type Amount struct {
	micros int64
	known  bool
}

// Known returns a known amount of micros micro-USD. Zero is a valid known amount. A negative amount fails with ErrNegativeAmount.
func Known(micros int64) (Amount, error) {
	if micros < 0 {
		return Amount{}, ErrNegativeAmount
	}
	return Amount{micros: micros, known: true}, nil
}

// Unknown returns an unknown amount: the cost was not recorded. It is not zero.
func Unknown() Amount {
	return Amount{}
}

// Micros returns the amount in micro-USD and whether it is known. For an unknown amount it returns (0, false).
func (a Amount) Micros() (micros int64, known bool) {
	if !a.known {
		return 0, false
	}
	return a.micros, true
}

// Ratio is an exact fraction Num/Den, not reduced. Den == 0 means the ratio is undefined (for example a cost per accepted video when no video was accepted).
type Ratio struct {
	Num int64 `json:"num"`
	Den int64 `json:"den"`
}

// Defined reports whether the ratio is defined, that is Den != 0.
func (r Ratio) Defined() bool {
	return r.Den != 0
}

// RoundHalfUp returns Num/Den rounded to the nearest integer with halves rounded up, using integer arithmetic only. ok is false when the ratio is undefined.
// Num is never negative and Den is never negative in this package.
func (r Ratio) RoundHalfUp() (rounded int64, ok bool) {
	if r.Den == 0 {
		return 0, false
	}
	return (2*r.Num + r.Den) / (2 * r.Den), true
}

// Outcome is the review decision for one generation attempt.
type Outcome string

const (
	// Accepted means the generated video was accepted. A video has at most one accepted attempt, and no attempt after it.
	Accepted Outcome = "ACCEPTED"
	// Rejected means the generated video was rejected; its cost is still spent.
	Rejected Outcome = "REJECTED"
)

// Attempt is one generation attempt for one video with the cost components that were recorded for it. A component that was not recorded is the zero Amount (unknown).
type Attempt struct {
	VideoID    string
	Outcome    Outcome
	Generation Amount
	Review     Amount
	Processing Amount
}

// Config holds the explicit limits of a Ledger.
type Config struct {
	// MaxAttemptsPerVideo is the retry ceiling: the most attempts that may be recorded for one video. Zero means no ceiling is configured.
	MaxAttemptsPerVideo int
}

// Ledger records attempts and summarizes them. It is not safe for concurrent use. Its fields are up to the implementation.
type Ledger struct {
	cfg      Config
	attempts []Attempt
	perVideo map[string]int
	accepted map[string]bool
}

// NewLedger returns an empty Ledger. A negative MaxAttemptsPerVideo fails with ErrInvalidConfig.
func NewLedger(cfg Config) (*Ledger, error) {
	if cfg.MaxAttemptsPerVideo < 0 {
		return nil, ErrInvalidConfig
	}
	return &Ledger{cfg: cfg, perVideo: map[string]int{}, accepted: map[string]bool{}}, nil
}

// Summary describes everything recorded so far. Money is micro-USD; the unknown components of an attempt contribute nothing to the sums and are counted in UnknownCostAttempts.
type Summary struct {
	// Attempts is the number of recorded attempts.
	Attempts int `json:"attempts"`
	// Videos is the number of distinct VideoIDs with at least one attempt.
	Videos int `json:"videos"`
	// AcceptedVideos is the number of videos that have an Accepted attempt.
	AcceptedVideos int `json:"accepted_videos"`
	// RejectedAttempts is the number of attempts whose Outcome is Rejected.
	RejectedAttempts int `json:"rejected_attempts"`
	// GenerationMicros, ReviewMicros and ProcessingMicros are the sums of the known Generation, Review and Processing amounts of all attempts.
	GenerationMicros int64 `json:"generation_micros"`
	ReviewMicros     int64 `json:"review_micros"`
	ProcessingMicros int64 `json:"processing_micros"`
	// KnownSpendMicros is GenerationMicros + ReviewMicros + ProcessingMicros. When CostComplete is false it is a lower bound of the real spend.
	KnownSpendMicros int64 `json:"known_spend_micros"`
	// RejectedSpendMicros is the known spend (all three components) of the attempts whose Outcome is Rejected.
	RejectedSpendMicros int64 `json:"rejected_spend_micros"`
	// UnknownCostAttempts is the number of attempts with at least one unknown cost component.
	UnknownCostAttempts int `json:"unknown_cost_attempts"`
	// CostComplete is true when UnknownCostAttempts is zero.
	CostComplete bool `json:"cost_complete"`
	// CostPerAccepted is KnownSpendMicros / AcceptedVideos. It is undefined (Den 0) when no video was accepted.
	CostPerAccepted Ratio `json:"cost_per_accepted"`
	// AcceptanceRate is AcceptedVideos / Videos. It is undefined when there are no videos.
	AcceptanceRate Ratio `json:"acceptance_rate"`
	// AttemptsPerAccepted is Attempts / AcceptedVideos. It is undefined when no video was accepted.
	AttemptsPerAccepted Ratio `json:"attempts_per_accepted"`
}
