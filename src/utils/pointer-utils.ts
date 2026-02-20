/**
 * Detect spoofed getCoalescedEvents() results.
 * A common bot technique patches getCoalescedEvents() to return N copies of `this`,
 * passing our length check but with all events sharing identity/coords/timestamps.
 */
export function isCoalescedSpoofed(events: PointerEvent[]): boolean {
  if (events.length < 2) return false;

  // Same object reference — N copies of `this`
  if (events[0] === events[1]) return true;

  // All identical coordinates
  const allSameCoords = events.every(
    (e) => e.clientX === events[0].clientX && e.clientY === events[0].clientY
  );
  if (allSameCoords) return true;

  // All identical timestamps with 3+ events (2 events can legitimately share a timestamp)
  const allSameTime = events.every((e) => e.timeStamp === events[0].timeStamp);
  return allSameTime && events.length >= 3;
}
