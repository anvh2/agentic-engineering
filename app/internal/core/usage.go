package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
)

// usageCounters are one provider report's numbers. Nil means not reported.
type usageCounters struct {
	UncachedInput *int64   `json:"uncached_input"`
	CacheRead     *int64   `json:"cache_read"`
	CacheWrite    *int64   `json:"cache_write"`
	Output        *int64   `json:"output"`
	Reasoning     *int64   `json:"reasoning"`
	Cost          *float64 `json:"cost_usd"`
}

func countersOf(u agent.Usage) usageCounters {
	return usageCounters{UncachedInput: u.UncachedInput, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite,
		Output: u.Output, Reasoning: u.Reasoning, Cost: u.CostUSDEstimate}
}

func (c usageCounters) counts() []*int64 {
	return []*int64{c.UncachedInput, c.CacheRead, c.CacheWrite, c.Output, c.Reasoning}
}

// since returns the share of c added after previous, both totals of one native
// session. A smaller total means the harness restarted its counters, so c
// already describes only the new work. A counter missing on either side stays
// unknown.
func (c usageCounters) since(previous usageCounters) usageCounters {
	before := previous.counts()
	for i, now := range c.counts() {
		if now != nil && before[i] != nil && *now < *before[i] {
			return c
		}
	}
	sub := func(now, then *int64) *int64 {
		if now == nil || then == nil {
			return nil
		}
		n := *now - *then
		return &n
	}
	out := usageCounters{
		UncachedInput: sub(c.UncachedInput, previous.UncachedInput),
		CacheRead:     sub(c.CacheRead, previous.CacheRead),
		CacheWrite:    sub(c.CacheWrite, previous.CacheWrite),
		Output:        sub(c.Output, previous.Output),
		Reasoning:     sub(c.Reasoning, previous.Reasoning),
	}
	if c.Cost != nil && previous.Cost != nil {
		cost := max(*c.Cost-*previous.Cost, 0)
		out.Cost = &cost
	}
	return out
}

func (c usageCounters) idle() bool {
	for _, n := range c.counts() {
		if n != nil && *n != 0 {
			return false
		}
	}
	return c.Cost == nil || *c.Cost == 0
}

// recordUsage stores one turn's usage. Session totals are converted to the
// turn's share against the session's previous report for the same model. Work
// of an earlier turn that ended without a report is therefore counted in the
// next report.
func (s *Service) recordUsage(ctx context.Context, tx *sql.Tx, turnID string, u agent.Usage) error {
	share := countersOf(u)
	cumulative := ""
	if u.SessionCumulative {
		encoded, err := json.Marshal(share)
		if err != nil {
			return err
		}
		cumulative = string(encoded)
		var previous string
		err = tx.QueryRowContext(ctx, `SELECT r.cumulative FROM usage_records r JOIN turns t ON t.id = r.turn_id
			WHERE t.session_id = (SELECT session_id FROM turns WHERE id = ?) AND t.id <> ?
			AND r.provider = ? AND r.model = ? AND r.cumulative <> '' ORDER BY t.seq DESC LIMIT 1`,
			turnID, turnID, string(u.Provider), u.Model).Scan(&previous)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil {
			var before usageCounters
			if err := json.Unmarshal([]byte(previous), &before); err != nil {
				return err
			}
			share = share.since(before)
		}
	}
	kind := "unknown"
	if share.Cost != nil {
		kind = "provider_api_equivalent_estimate"
	}
	raw := string(u.Raw)
	if raw == "" {
		raw = "null"
	}
	// An unused model keeps its row so the next report still has a baseline.
	_, err := tx.ExecContext(ctx, `INSERT INTO usage_records(turn_id, provider, model, uncached_input, cache_read, cache_write, output, reasoning, cost_usd_estimate, cost_kind, normalization_version, raw, cumulative, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(turn_id, provider, model) DO NOTHING`,
		turnID, string(u.Provider), u.Model, share.UncachedInput, share.CacheRead, share.CacheWrite, share.Output,
		share.Reasoning, share.Cost, kind, u.NormalizationVersion, raw, cumulative, s.ts())
	return err
}
