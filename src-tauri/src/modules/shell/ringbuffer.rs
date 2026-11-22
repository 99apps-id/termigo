use std::collections::VecDeque;

/// Byte-oriented bounded ring buffer with monotonic offsets.
///
/// Callers tail the buffer using `since_offset`: each `push` advances
/// `next_offset` by the number of bytes appended, even when older bytes are
/// dropped to fit the cap. `read_from(since)` returns the slice of bytes from
/// the requested offset (clamped to whatever is still resident) plus the new
/// offset for the next call.
pub struct BoundedRingBuffer {
    buf: VecDeque<u8>,
    cap: usize,
    next_offset: u64,
    /// Offset the last `read_from` actually served, so a reaper can tell a
    /// fully consumed buffer (drained) from one whose bytes nobody has read.
    last_served: u64,
    /// Bytes that were dropped to keep the buffer ≤ cap. Helps the caller
    /// detect overflow ("you missed N bytes").
    dropped: u64,
}

impl BoundedRingBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
            next_offset: 0,
            last_served: 0,
            dropped: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.next_offset = self.next_offset.saturating_add(data.len() as u64);
        if data.len() >= self.cap {
            // Incoming chunk alone exceeds cap: keep only its tail.
            let keep_from = data.len() - self.cap;
            self.dropped = self
                .dropped
                .saturating_add((self.buf.len() + keep_from) as u64);
            self.buf.clear();
            self.buf.extend(&data[keep_from..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            for _ in 0..overflow {
                self.buf.pop_front();
            }
            self.dropped = self.dropped.saturating_add(overflow as u64);
        }
        self.buf.extend(data);
    }

    /// True once `read_from` has served every byte through `next_offset`:
    /// first read-from-zero on a fresh buffer does not count, since serving
    /// nothing yet is the same as having nothing read.
    pub fn is_consumed(&self) -> bool {
        self.last_served >= self.next_offset && self.next_offset > 0
    }

    pub fn read_from(&mut self, since: u64) -> (Vec<u8>, u64, u64) {
        let oldest = self.next_offset.saturating_sub(self.buf.len() as u64);
        let start = since.max(oldest);
        let skip = (start - oldest) as usize;
        let (front, back) = self.buf.as_slices();
        let mut out = Vec::with_capacity(self.buf.len().saturating_sub(skip));
        if skip < front.len() {
            out.extend_from_slice(&front[skip..]);
            out.extend_from_slice(back);
        } else {
            let back_skip = skip - front.len();
            if back_skip < back.len() {
                out.extend_from_slice(&back[back_skip..]);
            }
        }
        self.last_served = self.next_offset;
        (out, self.next_offset, self.dropped)
    }
}

#[cfg(test)]
mod tests {
    use super::BoundedRingBuffer;

    #[test]
    fn read_from_returns_all_when_within_cap() {
        let mut buf = BoundedRingBuffer::new(16);
        buf.push(b"hello world");
        let (bytes, off, dropped) = buf.read_from(0);
        assert_eq!(bytes, b"hello world");
        assert_eq!(off, 11);
        assert_eq!(dropped, 0);
    }

    #[test]
    fn read_from_skips_consumed_prefix() {
        let mut buf = BoundedRingBuffer::new(16);
        buf.push(b"hello world");
        let (bytes, off, _) = buf.read_from(6);
        assert_eq!(bytes, b"world");
        assert_eq!(off, 11);
    }

    #[test]
    fn read_from_handles_wraparound() {
        let mut buf = BoundedRingBuffer::new(8);
        buf.push(b"abcdefgh");
        buf.push(b"ijkl");
        let (bytes, off, dropped) = buf.read_from(0);
        assert_eq!(bytes, b"efghijkl");
        assert_eq!(off, 12);
        assert_eq!(dropped, 4);
    }

    #[test]
    fn read_from_clamps_to_oldest() {
        let mut buf = BoundedRingBuffer::new(8);
        buf.push(b"abcdefgh");
        buf.push(b"ijkl");
        let (bytes, _, _) = buf.read_from(0);
        let (bytes2, _, _) = buf.read_from(99);
        assert_eq!(bytes, b"efghijkl");
        assert!(bytes2.is_empty());
    }

    #[test]
    fn push_larger_than_cap_keeps_tail() {
        let mut buf = BoundedRingBuffer::new(4);
        buf.push(b"abcdefgh");
        let (bytes, off, dropped) = buf.read_from(0);
        assert_eq!(bytes, b"efgh");
        assert_eq!(off, 8);
        assert_eq!(dropped, 4);
    }
}
