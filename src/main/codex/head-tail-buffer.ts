/**
 * Codex's capped output buffer, ported from `codex-rs/core/src/unified_exec/head_tail_buffer.rs`.
 *
 * Half the budget is kept as a stable head and half as a rolling tail; whatever falls out of
 * the middle is counted rather than forgotten, so the reply can say how much went missing.
 */

import { formatOutputOmissionMarker, UNIFIED_EXEC_OUTPUT_MAX_BYTES } from './unified-exec-constants.js';

export class HeadTailBuffer {
  private readonly maxBytes: number;
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private head: Buffer[] = [];
  private headLength = 0;
  private tail: Buffer[] = [];
  private tailLength = 0;
  private omitted = 0;
  /** Once bytes are omitted, the stable head must never refill after UTF-8 boundary trimming. */
  private headSealed = false;

  constructor(maxBytes: number = UNIFIED_EXEC_OUTPUT_MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.headBudget = Math.floor(maxBytes / 2);
    this.tailBudget = Math.max(0, maxBytes - this.headBudget);
  }

  /** Bytes still held (head + tail). */
  retainedBytes(): number {
    return this.headLength + this.tailLength;
  }

  /** Bytes dropped from the middle by the cap. */
  omittedBytes(): number {
    return this.omitted;
  }

  /** Everything the buffer ever saw, retained or not. */
  totalBytes(): number {
    return this.retainedBytes() + this.omitted;
  }

  pushChunk(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.maxBytes === 0) {
      this.omitted += chunk.length;
      return;
    }
    const remainingHead = this.headSealed ? 0 : Math.max(0, this.headBudget - this.headLength);
    const headLength = Math.min(remainingHead, chunk.length);
    if (headLength > 0) {
      this.head.push(chunk.subarray(0, headLength));
      this.headLength += headLength;
    }
    this.pushToTail(chunk.subarray(headLength));
  }

  toBytes(): Buffer {
    return Buffer.concat([...this.head, ...this.tail], this.retainedBytes());
  }

  toBytesWithOmissionMarker(): Buffer {
    if (this.omitted === 0) return this.toBytes();
    const marker = Buffer.from(formatOutputOmissionMarker(this.omitted), 'utf8');
    const newline = Buffer.from('\n', 'utf8');
    return Buffer.concat([...this.head, newline, marker, newline, ...this.tail]);
  }

  /** Append a later buffer with the same budget, carrying its omission count across. */
  pushBuffer(other: HeadTailBuffer): void {
    this.pushChunk(Buffer.concat(other.head, other.headLength));
    // `other`'s omitted bytes sit between its stable head and rolling tail. Carry that gap
    // before appending the tail so UTF-8 boundary trimming cannot leave spare head capacity
    // that pulls a later tail byte across the omission marker.
    if (other.omitted > 0) {
      this.omitted += other.omitted;
      this.normalizeUtf8OmissionBoundaries();
    }
    this.pushChunk(Buffer.concat(other.tail, other.tailLength));
  }

  private pushToTail(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.tailBudget === 0) {
      this.omitted += chunk.length;
      return;
    }
    if (chunk.length >= this.tailBudget) {
      // One chunk larger than the whole tail budget: keep its last `tailBudget` bytes and
      // count everything else — including whatever the tail already held — as omitted.
      const kept = chunk.subarray(chunk.length - this.tailBudget);
      this.omitted += this.tailLength + (chunk.length - kept.length);
      this.tail = [kept];
      this.tailLength = kept.length;
      this.normalizeUtf8OmissionBoundaries();
      return;
    }
    this.tail.push(chunk);
    this.tailLength += chunk.length;
    this.trimTailToBudget();
    this.normalizeUtf8OmissionBoundaries();
  }

  private trimTailToBudget(): void {
    let excess = this.tailLength - this.tailBudget;
    if (excess <= 0) return;
    this.omitted += excess;
    this.tailLength -= excess;
    while (excess > 0) {
      const first = this.tail[0];
      if (!first) break;
      if (first.length <= excess) {
        excess -= first.length;
        this.tail.shift();
        continue;
      }
      this.tail[0] = first.subarray(excess);
      excess = 0;
    }
  }

  /**
   * An omission marker separates head and tail, so both sides must independently end/start on a
   * UTF-8 code-point boundary. Any boundary bytes discarded here become part of the omission count,
   * preserving `retained + omitted === total input` rather than hiding corrective trimming.
   */
  private normalizeUtf8OmissionBoundaries(): void {
    if (this.omitted === 0) return;
    this.headSealed = true;

    const head = Buffer.concat(this.head, this.headLength);
    const headTrim = incompleteUtf8SuffixLength(head);
    if (headTrim > 0) {
      const kept = head.subarray(0, head.length - headTrim);
      this.head = kept.length === 0 ? [] : [kept];
      this.headLength = kept.length;
      this.omitted += headTrim;
    }

    const tail = Buffer.concat(this.tail, this.tailLength);
    const tailTrim = leadingUtf8ContinuationBytes(tail);
    if (tailTrim > 0) {
      const kept = tail.subarray(tailTrim);
      this.tail = kept.length === 0 ? [] : [kept];
      this.tailLength = kept.length;
      this.omitted += tailTrim;
    }
  }
}

function leadingUtf8ContinuationBytes(bytes: Buffer): number {
  let index = 0;
  while (index < bytes.length && index < 3 && (bytes[index]! & 0xc0) === 0x80) index++;
  return index;
}

function incompleteUtf8SuffixLength(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lead = bytes.length - 1;
  let continuations = 0;
  while (lead >= 0 && continuations < 3 && (bytes[lead]! & 0xc0) === 0x80) {
    continuations++;
    lead--;
  }
  if (lead < 0) return continuations;

  const first = bytes[lead]!;
  const expected =
    (first & 0x80) === 0 ? 1 :
      (first & 0xe0) === 0xc0 ? 2 :
        (first & 0xf0) === 0xe0 ? 3 :
          (first & 0xf8) === 0xf0 ? 4 : 1;
  const available = bytes.length - lead;
  return expected > available ? available : 0;
}
