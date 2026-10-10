package budget

import "example.com/videoeconomics/accounting"

// Evaluate judges the measured history in s against the policy. See the task description for the exact rules.
func Evaluate(s accounting.Summary, p Policy) (Result, error) {
	panic("TODO")
}

// EvaluateForecast judges a forecast cost per accepted video (micro-USD) against the policy. The result has Basis Forecast and a zero Summary.
// It never presents the forecast as measured history.
func EvaluateForecast(costPerAcceptedMicros int64, p Policy) (Result, error) {
	panic("TODO")
}
