package accounting

// Record adds an attempt, or fails and records nothing. An empty VideoID or an Outcome that is not Accepted or Rejected fails with ErrInvalidAttempt.
// A video that already has an Accepted attempt fails with ErrVideoAlreadyAccepted. A video that already has Config.MaxAttemptsPerVideo attempts
// (when that ceiling is not zero) fails with ErrRetryCeiling.
func (l *Ledger) Record(a Attempt) error {
	if a.VideoID == "" || (a.Outcome != Accepted && a.Outcome != Rejected) {
		return ErrInvalidAttempt
	}
	if l.accepted[a.VideoID] {
		return ErrVideoAlreadyAccepted
	}
	if l.cfg.MaxAttemptsPerVideo != 0 && l.perVideo[a.VideoID] >= l.cfg.MaxAttemptsPerVideo {
		return ErrRetryCeiling
	}
	l.attempts = append(l.attempts, a)
	l.perVideo[a.VideoID]++
	if a.Outcome == Accepted {
		l.accepted[a.VideoID] = true
	}
	return nil
}

// Summary returns the summary of the recorded attempts. An empty Ledger gives all zero numbers, CostComplete true and undefined ratios.
func (l *Ledger) Summary() Summary {
	var s Summary
	s.Attempts = len(l.attempts)
	s.Videos = len(l.perVideo)
	s.AcceptedVideos = len(l.accepted)
	for _, a := range l.attempts {
		unknown := false
		var spend int64
		for _, c := range []struct {
			amt Amount
			sum *int64
		}{{a.Generation, &s.GenerationMicros}, {a.Review, &s.ReviewMicros}, {a.Processing, &s.ProcessingMicros}} {
			if m, ok := c.amt.Micros(); ok {
				*c.sum += m
				spend += m
			} else {
				unknown = true
			}
		}
		s.KnownSpendMicros += spend
		if a.Outcome == Rejected {
			s.RejectedAttempts++
			s.RejectedSpendMicros += spend
		}
		if unknown {
			s.UnknownCostAttempts++
		}
	}
	s.CostComplete = s.UnknownCostAttempts == 0
	s.CostPerAccepted = Ratio{Num: s.KnownSpendMicros, Den: int64(s.AcceptedVideos)}
	s.AcceptanceRate = Ratio{Num: int64(s.AcceptedVideos), Den: int64(s.Videos)}
	s.AttemptsPerAccepted = Ratio{Num: int64(s.Attempts), Den: int64(s.AcceptedVideos)}
	return s
}
