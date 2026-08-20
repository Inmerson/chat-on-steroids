/**
 * The order a recorded turn is *read* in, which is not the order it was written in.
 *
 * A tool call is only handed to the recorder once its tool has finished and its attribution
 * has resolved, so it is appended late — but it is stamped with `startedAt`, because that is
 * when it happened. Everything the page observed in the meantime already has a lower `seq`.
 * Reading the log by `seq` therefore shows a call after the commentary it ran underneath, and
 * a slow call after the `turn_end` of the turn that made it: `2026-08-17-d1354db2` seq 390,
 * `time` 1786982781914, sits after a `turn_start` stamped 1786982783350 — a second and a half
 * in the future of the row above it.
 *
 * The fix is not to sort the log by time. `seq` is the append order and the cursor domain,
 * and it has to stay immutable and gap-free or incremental delivery breaks. And a global
 * sort by time would be actively wrong: a reloaded page re-reports the transcript it can see,
 * and those events carry the time they were *observed*, not the time they were said, so
 * sorting the whole log by time drags days-old history into the middle of the live turn.
 *
 * So ordering is turn-local. A turn this log opened is a durable, bounded group — everything
 * in it carries the same generation id, which the extension mints per turn — and inside that
 * group the recorded times are all live observations of one run, directly comparable. Outside
 * it nothing moves: user messages, turn boundaries, and any event whose turn this window does
 * not contain keep the position `seq` gave them.
 *
 * Both consumers use this. The desktop transcript and the stream the extension injects back
 * into ChatGPT are the same record, and they must not be able to disagree about its order.
 */

/** The minimum an entry needs to be placed. Both consumers' shapes satisfy it structurally. */
export interface Chronological {
  seq: number;
  /** First position of a mutable canonical item; seq may be its newer revision cursor. */
  origin?: number;
  /** When the item logically happened: `startedAt` for a call, first appearance for prose. */
  time: number;
  kind: string;
  turnId?: string | null;
}

/**
 * Reorders one window of recorded events for reading.
 *
 * Stable, total and deterministic: equal times fall back to `seq`, so nothing depends on the
 * order the window happened to arrive in and re-running it on a rebuilt window gives the same
 * answer. Never mutates the input.
 */
export function chronological<T extends Chronological>(entries: readonly T[]): T[] {
  const position = (entry: T): number =>
    typeof entry.origin === 'number' && Number.isFinite(entry.origin) ? entry.origin : entry.seq;
  const bySeq = [...entries].sort((a, b) => position(a) - position(b) || a.seq - b.seq);
  // Only turns this window actually opened. A tail delivered from a cursor can hold events of
  // a turn whose `turn_start` is far behind it, and a group with no anchor has no bounded
  // extent — its members could be reordered past events that are not part of it at all. Those
  // keep their seq position, which is the honest answer for a window that cannot see the turn.
  const anchors = new Map<string, number>();
  // Where each opened turn stops, so an event that names no turn can be told whether it
  // happened inside one. A turn still running has no end and holds everything after it.
  const ends = new Map<number, number>();
  for (const entry of bySeq) {
    if (entry.kind === 'turn_start' && entry.turnId && !anchors.has(entry.turnId)) {
      anchors.set(entry.turnId, position(entry));
    }
    if (entry.kind === 'turn_end' && entry.turnId) {
      const anchor = anchors.get(entry.turnId);
      if (anchor !== undefined) ends.set(anchor, Math.max(ends.get(anchor) ?? 0, entry.time));
    }
  }

  /**
   * The turn an event that names none belongs to.
   *
   * The app writes some events itself — a message handed from one agent to another is the
   * one that matters — and those carry no generation id, because the app is not the page and
   * does not have one. Left in their own group they were anchored at their own `seq`, which
   * put a message delivered *during* a turn underneath the whole of it: live, prime's
   * message to worker-1 was drawn below a refusal that happened 32 seconds later.
   *
   * They are placed by time into the turn that was open when they happened. That is sound
   * for exactly these events and for no others: the time on them is this machine's own
   * clock at the moment the app did the thing, so it is directly comparable with the live
   * observations in that turn — unlike a page event, whose time is when the extension saw
   * it and may be a re-report of something said days ago. An event after its turn's end
   * keeps its own position, since nothing in that group is a neighbour of it any more.
   */
  const openTurnAt = (entry: T): number | undefined => {
    let anchor: number | undefined;
    for (const candidate of bySeq) {
      if (position(candidate) >= position(entry)) break;
      if (candidate.kind === 'turn_start' && candidate.turnId) anchor = anchors.get(candidate.turnId);
    }
    if (anchor === undefined) return undefined;
    const end = ends.get(anchor);
    return end === undefined || entry.time <= end ? anchor : undefined;
  };

  // Position within a turn. The boundaries are the boundaries whatever their timestamps say:
  // a turn cannot begin after its own first observation or end before its last, and the times
  // on those two events are the moment the page noticed, not the moment the turn moved.
  const rank = (entry: T): number => (entry.kind === 'turn_start' ? -1 : entry.kind === 'turn_end' ? 1 : 0);

  // An entry with no usable time is ordered by its stable position (`origin` for a mutable
  // canonical item, otherwise `seq`) rather than being flung to one end of its turn: a
  // missing timestamp is not evidence about when the thing happened.
  const byTime = (a: T, b: T): number => {
    const apart = a.time - b.time;
    return Number.isFinite(apart) && apart !== 0
      ? apart
      : position(a) - position(b) || a.seq - b.seq;
  };

  const groups = new Map<number, T[]>();
  for (const entry of bySeq) {
    const anchor = (entry.turnId ? anchors.get(entry.turnId) : openTurnAt(entry)) ?? position(entry);
    const held = groups.get(anchor);
    if (held) held.push(entry);
    else groups.set(anchor, [entry]);
  }

  const out: T[] = [];
  for (const anchor of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(anchor)!;
    group.sort((a, b) => rank(a) - rank(b) || byTime(a, b));
    out.push(...group);
  }
  return out;
}
