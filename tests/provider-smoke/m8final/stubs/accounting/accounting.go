package accounting

// Record adds an attempt, or fails and records nothing. An empty VideoID or an Outcome that is not Accepted or Rejected fails with ErrInvalidAttempt.
// A video that already has an Accepted attempt fails with ErrVideoAlreadyAccepted. A video that already has Config.MaxAttemptsPerVideo attempts
// (when that ceiling is not zero) fails with ErrRetryCeiling.
func (l *Ledger) Record(a Attempt) error {
	panic("TODO")
}

// Summary returns the summary of the recorded attempts. An empty Ledger gives all zero numbers, CostComplete true and undefined ratios.
func (l *Ledger) Summary() Summary {
	panic("TODO")
}
