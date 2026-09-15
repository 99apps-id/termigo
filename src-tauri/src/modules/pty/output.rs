use std::collections::VecDeque;

/// How many chunks the flusher may have outstanding before it holds back. Two
/// lets one chunk be rendering while the next is already queued on the channel,
/// which keeps the pipe full without letting a stalled consumer queue an
/// unbounded run of them.
pub(crate) const MAX_IN_FLIGHT_CHUNKS: usize = 2;

/// Ceiling on the bytes a full window may carry. Bounds the memory the backend
/// can be holding on behalf of a consumer that has stopped draining.
pub(crate) const MAX_BUFFERED_BYTES: usize = 2 * 1024 * 1024;

/// Largest single chunk handed to the channel. Kept at a full window's share so
/// `MAX_IN_FLIGHT_CHUNKS` maximum-size chunks can never exceed
/// `MAX_BUFFERED_BYTES`.
pub(crate) const MAX_CHUNK_BYTES: usize = MAX_BUFFERED_BYTES / MAX_IN_FLIGHT_CHUNKS;

/// Sender-side back-pressure accounting for one session's output stream.
///
/// The flusher records every chunk it hands to the channel; the frontend
/// acknowledges the cumulative number of bytes it has consumed, which releases
/// every recorded boundary at or below that mark. Acks are cumulative, so they
/// may repeat, arrive out of order, or overshoot a boundary; acknowledgement
/// therefore only ever moves forward and never fails.
#[derive(Default)]
pub(crate) struct OutputCredit {
    sent: u64,
    acknowledged: u64,
    boundaries: VecDeque<u64>,
}

impl OutputCredit {
    /// Bytes handed to the channel and not yet released by an ack.
    ///
    /// Test-only, which is why it is under `cfg(test)` rather than merely
    /// unused. The production byte bound is held STRUCTURALLY, not by reading
    /// this: `session.rs` caps every chunk at `MAX_CHUNK_BYTES` and
    /// `has_room()` allows at most `MAX_IN_FLIGHT_CHUNKS` of them, so the
    /// flusher never needs to measure the total. What does need to measure it is
    /// the test that proves those two constants actually combine to keep the
    /// window inside `MAX_BUFFERED_BYTES` - a property nothing on the hot path
    /// can observe. Left in the production build it was dead code, and
    /// `cargo clippy --all-targets -- -D warnings` failed on it.
    ///
    /// If a caller ever needs this outside tests, lift the attribute rather than
    /// adding `#[allow(dead_code)]`: the compiler telling you it became live is
    /// the point.
    #[cfg(test)]
    pub fn in_flight_bytes(&self) -> usize {
        self.sent.saturating_sub(self.acknowledged) as usize
    }

    /// Chunks handed to the channel and not yet released by an ack.
    pub fn in_flight_chunks(&self) -> usize {
        self.boundaries.len()
    }

    /// Whether another chunk may be handed to the channel.
    pub fn has_room(&self) -> bool {
        self.in_flight_chunks() < MAX_IN_FLIGHT_CHUNKS
    }

    /// Record a chunk handed to the channel. Callers gate on `has_room` first
    /// and cap the chunk at `MAX_CHUNK_BYTES`, which keeps `in_flight_bytes`
    /// within `MAX_BUFFERED_BYTES`.
    pub fn record_sent(&mut self, bytes: usize) {
        debug_assert!(self.has_room());
        self.sent += bytes as u64;
        self.boundaries.push_back(self.sent);
    }

    /// Release every recorded boundary at or below `bytes`.
    ///
    /// Cumulative and idempotent: an ack naming bytes already released frees
    /// nothing and is not an error. Returns whether anything was released.
    pub fn acknowledge(&mut self, bytes: u64) -> bool {
        let mut released = false;
        while let Some(&front) = self.boundaries.front() {
            if front > bytes {
                break;
            }
            self.boundaries.pop_front();
            self.acknowledged = front;
            released = true;
        }
        released
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acknowledgement_releases_boundaries_in_order_and_is_idempotent() {
        let mut credit = OutputCredit::default();
        credit.record_sent(64 * 1024);
        credit.record_sent(32 * 1024);
        assert!(!credit.has_room());

        assert!(credit.acknowledge(64 * 1024));
        assert_eq!(credit.in_flight_chunks(), 1);
        assert_eq!(credit.in_flight_bytes(), 32 * 1024);

        credit.record_sent(10);
        // A repeat of an older mark releases nothing.
        assert!(!credit.acknowledge(64 * 1024));
        assert_eq!(credit.in_flight_chunks(), 2);

        // A cumulative mark that overshoots the final boundary still releases
        // every boundary below it.
        assert!(credit.acknowledge(96 * 1024 + 4096));
        assert_eq!(credit.in_flight_chunks(), 0);
        assert_eq!(credit.in_flight_bytes(), 0);
    }

    #[test]
    fn acknowledgement_below_the_first_boundary_releases_nothing() {
        let mut credit = OutputCredit::default();
        credit.record_sent(100);
        credit.record_sent(200);
        for bytes in [0, 1, 99] {
            assert!(!credit.acknowledge(bytes));
            assert_eq!(credit.in_flight_chunks(), 2);
            assert_eq!(credit.in_flight_bytes(), 300);
        }
        // 150 clears the first boundary only: the consumer has not consumed all
        // of the second chunk yet.
        assert!(credit.acknowledge(150));
        assert_eq!(credit.in_flight_chunks(), 1);
        assert_eq!(credit.in_flight_bytes(), 200);
        assert!(credit.acknowledge(300));
        assert_eq!(credit.in_flight_chunks(), 0);
        assert_eq!(credit.in_flight_bytes(), 0);
    }

    #[test]
    fn window_reopens_only_after_an_ack() {
        let mut credit = OutputCredit::default();
        assert!(credit.has_room());
        credit.record_sent(10);
        assert!(credit.has_room());
        credit.record_sent(10);
        assert!(!credit.has_room());
        assert!(!credit.acknowledge(5));
        assert!(!credit.has_room());
        assert!(credit.acknowledge(10));
        assert!(credit.has_room());
    }

    #[test]
    fn credit_stays_bounded_over_long_streams_with_lost_replies() {
        let mut credit = OutputCredit::default();
        let mut consumed = 0u64;
        for _ in 0..100_000 {
            credit.record_sent(MAX_CHUNK_BYTES);
            credit.record_sent(MAX_CHUNK_BYTES);
            assert_eq!(credit.in_flight_bytes(), MAX_BUFFERED_BYTES);
            assert!(!credit.has_room());

            consumed += MAX_BUFFERED_BYTES as u64;
            assert!(credit.acknowledge(consumed));
            // A duplicated ack must not free anything twice.
            assert!(!credit.acknowledge(consumed));
            assert_eq!(credit.in_flight_chunks(), 0);
            assert_eq!(credit.in_flight_bytes(), 0);
            assert!(credit.has_room());
        }
        assert!(credit.boundaries.capacity() <= 8);
    }
}
