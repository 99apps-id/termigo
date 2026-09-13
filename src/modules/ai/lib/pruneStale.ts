/**
 * Age-based eviction for the per-session maps in the agent runtime.
 *
 * Several runtime maps are keyed by session and only ever READ for the session
 * that is currently running, so a row for any other session is dead weight. Most
 * of them are deleted at known points (a fresh send, a resume, a session reset),
 * but the deletion of a SESSION lives in the chat store, and the runtime already
 * imports that store - so the runtime cannot hook session removal without a
 * cycle. Two maps had no deletion point at all and grew with every session the
 * process ever touched.
 *
 * An age bound makes such a map limit itself regardless of which path the
 * process took, which is what this does.
 */

/**
 * Drop entries whose age exceeds `ttlMs`. Returns how many were dropped, so a
 * caller can assert the bound holds without reaching into the map.
 *
 * `ageOf` is supplied rather than assumed: one map stores a bare timestamp, the
 * other a record that carries one.
 */
export function pruneStale<K, V>(
  map: Map<K, V>,
  ageOf: (value: V) => number,
  now: number,
  ttlMs: number,
): number {
  // One entry is the common case (a single active session), and it can never be
  // stale while it is the one being read. Skipping the walk keeps the hot path
  // free.
  if (map.size <= 1) return 0;

  let dropped = 0;
  for (const [key, value] of map) {
    const age = now - ageOf(value);
    // `>` and not `>=`: an entry exactly at the boundary is still within its
    // window. A negative age means the clock moved backwards (a sleep, an NTP
    // step), and evicting on that would throw away live state.
    if (age > ttlMs) {
      map.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}
