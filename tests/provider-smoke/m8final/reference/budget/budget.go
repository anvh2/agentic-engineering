package budget

import "example.com/videoeconomics/accounting"

// Evaluate judges the measured history in s against the policy. See the task description for the exact rules.
func Evaluate(s accounting.Summary, p Policy) (Result, error) {
	res, err := newResult(Measured, p)
	if err != nil {
		return Result{}, err
	}
	acc, known := int64(s.AcceptedVideos), s.KnownSpendMicros
	res.Summary = s
	res.CostPerAccepted = accounting.Ratio{Num: known, Den: acc}
	res.PreferredRange = RangeUnknown
	if acc > 0 {
		res.OverHardCeiling = known > HardCeilingMicros*acc
		switch {
		case known > PreferredHighMicros*acc:
			res.PreferredRange = RangeAbove
		case !s.CostComplete:
			res.PreferredRange = RangeUnknown
		case known < PreferredLowMicros*acc:
			res.PreferredRange = RangeBelow
		default:
			res.PreferredRange = RangeInside
		}
	}
	switch {
	case acc == 0:
		res.Verdict, res.ReasonCodes = InsufficientEvidence, []string{ReasonNoAcceptedVideos}
	case int(acc) < res.MinAcceptedVideos:
		res.Verdict, res.ReasonCodes = InsufficientEvidence, []string{ReasonBelowMinSample}
	case known > res.CeilingMicros*acc:
		res.Verdict, res.ReasonCodes = OverBudget, []string{ReasonAboveCeiling}
	case !s.CostComplete:
		res.Verdict, res.ReasonCodes = InsufficientEvidence, []string{ReasonCostIncomplete}
	default:
		res.Verdict = WithinTarget
	}
	return res, nil
}

// EvaluateForecast judges a forecast cost per accepted video (micro-USD) against the policy. The result has Basis Forecast and a zero Summary.
// It never presents the forecast as measured history.
func EvaluateForecast(costPerAcceptedMicros int64, p Policy) (Result, error) {
	if costPerAcceptedMicros < 0 {
		return Result{}, ErrInvalidForecast
	}
	res, err := newResult(Forecast, p)
	if err != nil {
		return Result{}, err
	}
	res.CostPerAccepted = accounting.Ratio{Num: costPerAcceptedMicros, Den: 1}
	res.OverHardCeiling = costPerAcceptedMicros > HardCeilingMicros
	switch {
	case costPerAcceptedMicros < PreferredLowMicros:
		res.PreferredRange = RangeBelow
	case costPerAcceptedMicros > PreferredHighMicros:
		res.PreferredRange = RangeAbove
	default:
		res.PreferredRange = RangeInside
	}
	if costPerAcceptedMicros > res.CeilingMicros {
		res.Verdict, res.ReasonCodes = OverBudget, []string{ReasonAboveCeiling}
	} else {
		res.Verdict = WithinTarget
	}
	return res, nil
}
