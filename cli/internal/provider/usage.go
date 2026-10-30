package provider

// cumulativeUsage turns a stream's repeated cumulative token counters into the
// per-chunk increase.
//
// Both Gemini and several OpenAI-compatible servers repeat the request-wide
// usage on every streamed chunk, and the counters climb as the answer streams.
// The agent sums every usage event it is handed, so forwarding each chunk as-is
// charged the same tokens once per chunk: the token count and the estimated
// spend ran several times too high and a cost budget tripped early. Emitting the
// increase keeps that downstream sum correct and still shows spend as it
// accrues, which is what the running total is for.
type cumulativeUsage struct {
	seen Usage
}

// step returns how much the counters grew since the last report. It reports
// false when nothing moved, so a repeated final chunk is not counted twice.
func (c *cumulativeUsage) step(current Usage) (Usage, bool) {
	increase := Usage{
		PromptTokens:     growth(c.seen.PromptTokens, current.PromptTokens),
		CompletionTokens: growth(c.seen.CompletionTokens, current.CompletionTokens),
		TotalTokens:      growth(c.seen.TotalTokens, current.TotalTokens),
		CacheReadTokens:  growth(c.seen.CacheReadTokens, current.CacheReadTokens),
		CacheWriteTokens: growth(c.seen.CacheWriteTokens, current.CacheWriteTokens),
		ReasoningTokens:  growth(c.seen.ReasoningTokens, current.ReasoningTokens),
	}
	// The high-water mark, not the latest value: a chunk that reported less
	// would otherwise re-count ground already charged when the counters climb
	// again.
	c.seen = Usage{
		PromptTokens:     max(c.seen.PromptTokens, current.PromptTokens),
		CompletionTokens: max(c.seen.CompletionTokens, current.CompletionTokens),
		TotalTokens:      max(c.seen.TotalTokens, current.TotalTokens),
		CacheReadTokens:  max(c.seen.CacheReadTokens, current.CacheReadTokens),
		CacheWriteTokens: max(c.seen.CacheWriteTokens, current.CacheWriteTokens),
		ReasoningTokens:  max(c.seen.ReasoningTokens, current.ReasoningTokens),
	}
	if increase == (Usage{}) {
		return Usage{}, false
	}
	return increase, true
}

// growth reports how far a cumulative counter has moved, never below zero: a
// counter that goes backwards is not a charge.
func growth(previous, current int) int {
	if current <= previous {
		return 0
	}
	return current - previous
}
