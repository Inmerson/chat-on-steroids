/**
 * The content script, running against a real DOM.
 *
 * These are the regressions behind the complaint that started all of this: a live ChatGPT
 * page showing a wall of faint "Called tool" rows, and no Compact & resume control
 * anywhere near the composer. Both failures were invisible to the existing tests because
 * those exercise the DOM adapter against structural fakes and never run content.js at all.
 *
 * So this file runs the shipped extension/chatgpt-dom.js and extension/content.js in a
 * jsdom window, against markup shaped like the live page, with a fake service worker
 * standing in for Chrome. Nothing is reimplemented.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { chronological } from '../src/shared/chronology.js';

let domSource = '';
let contentSource = '';

beforeAll(async () => {
  [domSource, contentSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'extension', 'chatgpt-dom.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'extension', 'content.js'), 'utf8')
  ]);
});

// ------------------------------------------------------------------ harness

interface ActivityEntry {
  seq: number;
  time: number;
  tool: string;
  callId: string;
  turnId: string | null;
  attribution: string;
  outcome: string;
  durationMs: number;
  summary: { kind: string; tone: string; title: string; detail?: string; metric?: string };
  /** Which agent ran it. Absent, and shown as nothing, in a chat with no agents. */
  agent?: string | null;
  /** ChatGPT's own id for the connector request, which outlives the page load. */
  requestId?: string | null;
}

interface Descriptor {
  index: number;
  tool: string | null;
  path: string | null;
  app: string | null;
  resource: string | null;
  messageId: string | null;
  turnId: string | null;
  conversationId: string | null;
  createTime: number | null;
  hidden: number;
  localCount: number | null;
  answered: boolean;
}

interface Hook {
  /** Legacy test archive only. Production 1.8 removed row-count ownership evidence. */
  connectorBlockCount(section: Element | null): number;
  planLabels(
    blocks: Array<{ callId: string | null; original: string; hidden?: number; tool?: string | null }>,
    calls: ActivityEntry[]
  ): Array<[number, ActivityEntry | null, ActivityEntry[]]>;
  refreshFiber(settled?: Record<string, unknown> | null): Promise<void>;
  fiberFor(block: Element): Descriptor | null;
  readDescriptor(raw: unknown): Descriptor | null;
  controlState(input: Record<string, unknown>): { mode: string; label: string; hint: string; action: string };
  stageView(
    input: Record<string, unknown>
  ): { stage: string; detail: string; body: string; kind: string } | null;
  emit(observation: Record<string, unknown>): void;
  flush(): Promise<void>;
  observe(): void;
  syncTheme(): void;
  meterView(): { filled: number; level: string; status: string; tip: string } | null;
  paint(): void;
  renderStreams(): void;
  foldBootstrap(): void;
  injectControl(): void;
  injectStage(): void;
  pullActivity(): Promise<void>;
  runCommand(): Promise<void>;
  startCompact(): Promise<void>;
  chronological<T extends { seq: number; time: number; kind: string; turnId?: string | null }>(entries: T[]): T[];
  streamTurnGroups(
    entries: Array<{ seq: number; time: number; kind: string; turnId?: string | null }>
  ): Array<{ id: string; entries: Array<{ seq: number; kind: string; turnId?: string | null }> }>;
  visibleStream(entries: Array<Record<string, any>>, groupId?: string | null): Array<Record<string, any>>;
  /** How long the stop button must stay gone before content.js calls a turn finished. */
  TURN_SETTLE_MS: number;
  /** Test seam for the no-visible-progress fallback. */
  STALL_MS: number;
  /** Test-only gate; production defaults ON while the harness starts presentation OFF. */
  setRenderStream(on: boolean): void;
  renderStreamEnabled(): boolean;
  setShowTimes(on: boolean): void;
}

interface Harness {
  dom: JSDOM;
  window: JSDOM['window'];
  document: Document;
  hook: Hook;
  /** Every message the content script sent to the "service worker". */
  sent: Array<Record<string, any>>;
  /** Answers, keyed by message type. */
  reply: Map<string, (message: Record<string, any>) => unknown>;
  /** Moves the clock the script reads. Nothing else advances it between ticks. */
  advance(ms: number): void;
  close(): void;
}

const PAGE = `<!doctype html><html><body>
  <main id="thread"></main>
  <form id="composer-form">
    <div id="prompt-textarea" contenteditable="true"></div>
    <div data-testid="composer-trailing-actions">
      <button type="button" data-testid="composer-speech-button" aria-label="Dictate"></button>
      <button type="button" data-testid="send-button" aria-label="Send prompt"></button>
    </div>
  </form>
</body></html>`;

/**
 * Builds a page with the content script running on it.
 *
 * Worker answers are registered *before* the script starts, because content.js talks to
 * the worker the moment it loads — redeeming the command its URL names is the first thing
 * it does — and a harness that only answered afterwards would be testing a retry.
 */
async function harness(
  url = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  replies: Record<string, (message: Record<string, any>) => unknown> = {},
  before: (document: Document, dom: JSDOM) => void = () => undefined
): Promise<Harness> {
  const dom = new JSDOM(PAGE, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
  await new Promise<void>((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', () => resolve());
  });

  const sent: Array<Record<string, any>> = [];
  const reply = new Map<string, (message: Record<string, any>) => unknown>();
  reply.set('status', () => ({ connected: true, paired: true, port: 8765, pending: 0 }));
  reply.set('events', () => ({ ok: true, pending: 0, durable: true }));
  reply.set('bind', () => ({ ok: true, bound: 0 }));
  reply.set('poll', () => ({ ok: true }));
  reply.set('closed', () => ({ ok: true }));
  for (const [type, answer] of Object.entries(replies)) reply.set(type, answer);
  before(window.document, dom);

  window.chrome = {
    runtime: {
      async sendMessage(message: Record<string, any>) {
        sent.push(message);
        const answer = reply.get(message.type);
        return answer ? answer(message) : { ok: false, error: 'unknown_message' };
      }
    }
  };

  // The periodic loops are the live page's business, not the test's: every behaviour here
  // is driven through the hook so a case cannot pass by accident on a stray tick.
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  // Keeps ordering while making the script's own waits instant. content.js waits half a
  // second at a time for ChatGPT to settle, up to eighty times.
  //
  // The clock moves with them. Several of those waits are budgets — "stop within fifteen
  // seconds" — and a budget measured against a real clock that instant timers never advance
  // is a busy loop for the whole budget. Advancing a fake clock by exactly the sleep that
  // was asked for makes a give-up path arrive after the right number of attempts, instantly.
  let clock = 1_700_000_000_000;
  window.setTimeout = ((fn: () => void, ms?: number) => {
    clock += Number(ms) || 0;
    void Promise.resolve().then(fn);
    return 0;
  }) as unknown as typeof window.setTimeout;
  window.Date.now = () => clock;
  // Time the script measures but never sleeps through. The settle window a turn has to
  // survive before it counts as finished is one of these: content.js only ever *reads* the
  // clock for it, so nothing in the script advances it and a test has to say so itself.
  const advance = (ms: number): void => {
    clock += ms;
  };
  // jsdom has no editing host; ChatGPT's composer is one, and insertPrompt() drives it
  // through execCommand because that is the path React listens on.
  // It is a rich-text editor rather than a textarea, and that difference is load-bearing:
  // inserted text becomes one paragraph per line, so reading it back through `textContent`
  // returns the words with every newline gone. A fake that kept the newlines was why the
  // suite stayed green while every worker whose task was short enough for the bootstrap's
  // blank line to land inside the first 80 characters failed to start in the real browser.
  window.document.execCommand = (command: string, _ui: boolean, value: string) => {
    if (command !== 'insertText') return false;
    const box = window.document.querySelector('#prompt-textarea');
    if (!box) return false;
    for (const line of String(value).split('\n')) {
      const paragraph = window.document.createElement('p');
      paragraph.textContent = line;
      box.append(paragraph);
    }
    return true;
  };

  let hook: Hook | null = null;
  window.CLF_TEST_HOOK = (api: Hook) => {
    hook = api;
  };

  window.eval(domSource);
  window.eval(contentSource);
  if (!hook) throw new Error('content.js did not expose its test hook');

  // The script's own start-up. A marked app-opened page delivers its command first; an
  // ordinary page does the normal status/restore handshake before its first observation.
  await settle();
  return {
    dom,
    window: window as unknown as JSDOM['window'],
    document: window.document,
    hook,
    sent,
    reply,
    advance,
    close: () => dom.window.close()
  };
}

/**
 * The `/compact` requests that asked the app to *start* a compaction.
 *
 * The same message type carries three different things now: opening the transaction, handing
 * back the brief the watched generation produced, and withdrawing an abandoned one. Only the
 * first is a compaction being started, so counting the raw messages counts a page that did
 * its job twice.
 */
const startedCompactions = (harness: Harness): any[] =>
  harness.sent.filter((message) => message.type === 'compact' && !message.cancel && !message.summary);

/** Lets the content script's promise chains run to a stop. */
const settle = async (rounds = 40): Promise<void> => {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
};

let live: Harness | null = null;

afterEach(() => {
  live?.close();
  live = null;
});

// ------------------------------------------------------------------ markup

function assistantTurn(document: Document, id: string, labels: string[]): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-testid', 'conversation-turn-2');
  section.setAttribute('data-turn', 'assistant');
  section.setAttribute('data-turn-id', id);
  for (const label of labels) section.append(toolBlock(document, label));
  document.querySelector('#thread')!.append(section);
  return section;
}

/** One user message, in the shape the page renders it. */
function userTurn(document: Document, id: string, text: string): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-testid', 'conversation-turn-1');
  section.setAttribute('data-turn', 'user');
  section.setAttribute('data-turn-id', id);
  const message = document.createElement('div');
  message.setAttribute('data-message-id', `m-${id}`);
  message.setAttribute('data-message-author-role', 'user');
  const body = document.createElement('div');
  body.className = 'whitespace-pre-wrap';
  body.textContent = text;
  message.append(body);
  section.append(message);
  document.querySelector('#thread')!.append(section);
  return section;
}

/**
 * One tool row.
 *
 * A label ending in `!` means a connector row: it gets the control ChatGPT only puts in
 * those, copied from the live page. Everything else is a built-in row — "Searched the
 * web" and friends — which looks identical apart from that control and its name.
 */
function toolBlock(document: Document, label: string): HTMLElement {
  const connector = label.endsWith('!');
  const block = document.createElement('div');
  block.className = 'pointer-events-none contents';
  const button = document.createElement('button');
  button.type = 'button';
  if (connector) button.setAttribute('aria-label', 'Open tool call list');
  const span = document.createElement('span');
  span.className = 'text-start';
  span.textContent = connector ? label.slice(0, -1) : label;
  button.append(span);
  block.append(button);
  return block;
}

/** The tool rows of a turn, as content.js sees them. */
function blocksOf(section: HTMLElement): Element[] {
  return [...section.querySelectorAll('.pointer-events-none.contents')];
}

/** Puts the page into the generating state content.js requires before it reports blocks. */
function startGenerating(document: Document): void {
  const stop = document.createElement('button');
  stop.setAttribute('data-testid', 'stop-button');
  document.querySelector('[data-testid="composer-trailing-actions"]')!.append(stop);
}

/** Ends it again: ChatGPT swaps stop back for send the moment the turn is over. */
function stopGenerating(document: Document): void {
  document.querySelector('[data-testid="stop-button"]')?.remove();
}

/**
 * Takes the page from generating to genuinely settled, the way the observer sees it.
 *
 * The stop button going away is not on its own the end of a turn — ChatGPT unmounts it
 * across tool phases and rerenders — so content.js waits for the button to stay gone for
 * TURN_SETTLE_MS before it will call a turn finished. A test that means "and then the turn
 * really ended" has to sit through that window, which is what this does: one observation to
 * open the window, the clock moved past it, and one more to close the turn.
 */
async function settleTurn(harnessed: Harness): Promise<void> {
  stopGenerating(harnessed.document);
  harnessed.hook.observe();
  await settle();
  harnessed.advance(harnessed.hook.TURN_SETTLE_MS);
  harnessed.hook.observe();
  await settle();
}

/** What is sitting in the composer right now. */
const composerText = (document: Document): string =>
  (document.querySelector('#prompt-textarea')?.textContent || '').trim();

/** Counts the sends the content script asked ChatGPT for. */
function watchSend(document: Document): () => number {
  let sends = 0;
  document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
    sends++;
  });
  return () => sends;
}

/** Every tool_block observation the content script has sent, in order. */
function sightings(sent: Array<Record<string, any>>): Array<{ turnId?: string; count: number }> {
  return sent
    .filter((message) => message.type === 'events')
    .flatMap((message) => (message.entries ?? []) as Array<Record<string, any>>)
    .map((entry) => entry.event as Record<string, any>)
    .filter((event) => event?.kind === 'tool_block')
    .map((event) => ({ turnId: event.turnId, count: event.count }));
}

let nextSeq = 1;

function call(overrides: Partial<ActivityEntry> & { turnId: string }): ActivityEntry {
  const seq = overrides.seq ?? nextSeq++;
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    tool: 'read_file',
    callId: `call-${seq}`,
    attribution: 'turn',
    outcome: 'ok',
    durationMs: 12,
    summary: { kind: 'read', tone: 'neutral', title: 'Read src/main/bridge.ts' },
    ...overrides
  };
}

/** Answers one scan with `rows` (and optional turn-level calls), as fiber.js would. */
async function replyFiber(
  rows: unknown[],
  turns: unknown[] = [],
  settled: Record<string, unknown> | null = null
): Promise<void> {
  const window = live!.window as any;
  // The harness makes every timeout instant so the script's own waits do not slow the
  // suite down. Here that would fire the scan's give-up timer before jsdom could
  // deliver the request, so this one case runs on real timers.
  const instant = window.setTimeout;
  window.setTimeout = (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms);
  const onAsk = (event: any) => {
    if (!event.data || event.data.source !== 'clf-fiber-ask') return;
    const indexedTurns = turns.map((turn: any, index) =>
      turn && typeof turn === 'object' && Number.isInteger(turn.index) ? turn : { ...(turn as Record<string, unknown>), index }
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { source: 'clf-fiber-reply', nonce: event.data.nonce, v: 8, rows, turns: indexedTurns },
        source: window
      })
    );
  };
  window.addEventListener('message', onAsk);
  try {
    await live!.hook.refreshFiber(settled);
  } finally {
    window.removeEventListener('message', onAsk);
    window.setTimeout = instant;
  }
}

/**
 * The visible text of each tool block in a turn, in DOM order, minus the parts that are
 * not the label.
 *
 * The clock reading is stripped because it is a real local time formatted in the runner's
 * locale, so asserting on it would be asserting on the machine. The folded-call list is
 * stripped because it belongs to the rows *inside* this one; the tests that care about it
 * read it directly.
 */
function labels(section: HTMLElement): string[] {
  return [...section.querySelectorAll('.pointer-events-none.contents')].map((block) => {
    const copy = block.cloneNode(true) as HTMLElement;
    for (const node of copy.querySelectorAll('.clf-when, .clf-fold-list')) node.remove();
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  });
}

// ------------------------------------------------------------------- tests

describe('matching recorded calls to ChatGPT tool blocks', () => {
  it('relabels the blocks it is sure about instead of giving up on the whole turn', async () => {
    const plan = (blocks: Array<[string | null, string]>, calls: ActivityEntry[]) =>
      live!.hook.planLabels(
        blocks.map(([callId, original]) => ({ callId, original })),
        calls
      );
    live = await harness();

    // Two of ours and one ChatGPT named itself. The old rule required the counts to match
    // exactly, so this turn kept three identical "Called tool" rows forever.
    const calls = [call({ turnId: 't1' }), call({ turnId: 't1' })];
    const result = plan(
      [
        [null, 'Called tool'],
        [null, 'Searched the web'],
        [null, 'Called tool']
      ],
      calls
    );
    expect(result).toEqual([
      [0, calls[0], []],
      [2, calls[1], []]
    ]);
  });

  it('pairs blocks and calls one for one when the counts agree', async () => {
    live = await harness();
    const calls = [call({ turnId: 't1' }), call({ turnId: 't1' })];
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool' },
          { callId: null, original: 'Called tool' }
        ],
        calls
      )
    ).toEqual([
      [0, calls[0], []],
      [1, calls[1], []]
    ]);
  });

  it('leaves a genuinely ambiguous turn alone', async () => {
    live = await harness();
    // Two unlabelled blocks ChatGPT named differently, one recorded call: there is no
    // evidence which of them it was, and a wrong label is worse than none.
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Searched the web' },
          { callId: null, original: 'Ran a canvas action' }
        ],
        [call({ turnId: 't1' })]
      )
    ).toEqual([]);
  });

  it('never moves a label from the block it is already on', async () => {
    live = await harness();
    const first = call({ turnId: 't1', callId: 'call-a' });
    const second = call({ turnId: 't1', callId: 'call-b' });
    const result = live.hook.planLabels(
      [
        { callId: 'call-a', original: 'Called tool' },
        { callId: null, original: 'Called tool' }
      ],
      [first, second]
    );
    expect(result).toEqual([
      [0, first, []],
      [1, second, []]
    ]);
  });

  it('keeps a block whose call has scrolled out of the feed rather than reassigning it', async () => {
    live = await harness();
    const fresh = call({ turnId: 't1', callId: 'call-new' });
    expect(
      live.hook.planLabels(
        [
          { callId: 'call-forgotten', original: 'Called tool' },
          { callId: null, original: 'Called tool' }
        ],
        [fresh]
      )
    ).toEqual([[1, fresh, []]]);
  });
});

/**
 * ChatGPT folds a run of calls to the same tool into a single row — observed live as
 * "4 earlier tool calls hidden" over a `collapsedSameToolCallCount: 4`, so five calls
 * behind one row. Every rule above used to count a row as one call, which meant that on
 * any turn where something was collapsed the even-count fast path fired against
 * mismatched sets and put confidently wrong labels on real calls.
 */
describe('a tool row that stands for several calls', () => {
  const five = (): ActivityEntry[] =>
    [0, 1, 2, 3, 4].map((n) =>
      call({ turnId: 't1', callId: `call-${n}`, seq: n, summary: { kind: 'agent', tone: 'neutral', title: `Step ${n}` } })
    );

  it('gives the row the last call of its group, not the first', async () => {
    live = await harness();
    const calls = five();
    expect(live.hook.planLabels([{ callId: null, original: 'Called tool', hidden: 4 }], calls)).toEqual([
      [0, calls[4], calls.slice(0, 4)]
    ]);
  });

  it('counts a folded row as the calls it hides when sizing the turn', async () => {
    live = await harness();
    const calls = five();
    // One row hiding two, then two ordinary rows: 3 + 1 + 1 = 5 calls across 3 rows.
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool', hidden: 2 },
          { callId: null, original: 'Called tool' },
          { callId: null, original: 'Called tool' }
        ],
        calls
      )
    ).toEqual([
      [0, calls[2], calls.slice(0, 2)],
      [1, calls[3], []],
      [2, calls[4], []]
    ]);
  });

  it('does not mislabel when the old one-row-one-call rule would have matched', async () => {
    live = await harness();
    const calls = five();
    // Five rows, five calls — but the first row hides four, so this turn really shows
    // eight calls and only five are known. The old rule paired them off regardless.
    const plan = live.hook.planLabels(
      [
        { callId: null, original: 'Called tool', hidden: 4 },
        { callId: null, original: 'Called tool' },
        { callId: null, original: 'Called tool' },
        { callId: null, original: 'Called tool' },
        { callId: null, original: 'Called tool' }
      ],
      calls
    );
    // The fast path must not fire (5 rows span 9 calls, not 5), and the fallback must not
    // spend the fold count either: nothing here says the four calls this row folded away
    // are the four sitting in front of it in the recorder's list rather than four the
    // recorder never saw. It used to assume they were, and hand the row call five.
    expect(plan).toEqual([]);
  });

  /**
   * Failing closed on the fold count is not the same as giving up on the turn, and it is
   * emphatically not the same as making the row generic: the row still carries the name
   * the page's own descriptor gave it, which is evidence about that row alone. What stops
   * is the *arithmetic* — every row after a fold is at an unknown offset.
   */
  it('labels what it can before a folded row and stops there', async () => {
    live = await harness();
    // Three rows standing for five calls, four of them recorded. The fold count fits
    // arithmetically — 1 + 3 lands exactly on the four — which is precisely the trap: it
    // fits any four calls, and it used to hand the second row the last of them.
    const calls = five().slice(0, 4);
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool' },
          { callId: null, original: 'Called tool', hidden: 2 },
          { callId: null, original: 'Called tool' }
        ],
        calls
      )
    ).toEqual([[0, calls[0], []]]);
  });

  it('keeps a bound folded row bound, along with the calls behind it', async () => {
    live = await harness();
    const calls = five();
    expect(
      live.hook.planLabels(
        [
          { callId: 'call-2', original: 'Called tool', hidden: 2 },
          { callId: null, original: 'Called tool' },
          { callId: null, original: 'Called tool' }
        ],
        calls
      )
    ).toEqual([
      [0, calls[2], calls.slice(0, 2)],
      [1, calls[3], []],
      [2, calls[4], []]
    ]);
  });

  it('treats a missing or nonsense fold count as no folding at all', async () => {
    live = await harness();
    const calls = [call({ turnId: 't1', callId: 'a' })];
    for (const hidden of [undefined, 0, -3, 1.5, '4', null]) {
      expect(
        live.hook.planLabels([{ callId: null, original: 'Called tool', hidden } as never], calls)
      ).toEqual([[0, calls[0], []]]);
    }
  });
});

/**
 * Every rule in planLabels is an argument from position, and position is what goes wrong
 * when the recorder's view of a turn and the page's view of it are not the same set of
 * calls. The row's own Fiber descriptor is the one piece of evidence that is about *that
 * row* and nothing else, so it gets a veto over all of them.
 *
 * Both fixtures here were taken from live chats on 2026-08-16, where in each case the
 * single bound row on the page was wearing another call's name: a row whose descriptor
 * said `screenshot` labelled with a recorded `list_windows`, and a row whose descriptor
 * said `run_powershell` labelled with a recorded `computer`. Both were produced by rules
 * that "fit" — the counts came out even, so the pairing looked proven.
 */
describe('a row refusing a call the page says it did not make', () => {
  const named = (tool: string, title: string) =>
    call({ turnId: 't1', tool, summary: { kind: 'agent', tone: 'neutral', title } });

  it('refuses the pairing when the descriptor names a different tool', async () => {
    live = await harness();
    // The live row 9 case: one row, one recorded call, the counts could not fit better.
    const calls = [named('computer', 'Focused a window and 1 more')];
    expect(
      live.hook.planLabels([{ callId: null, original: 'Called tool', tool: 'run_powershell' }], calls)
    ).toEqual([]);
  });

  it('pairs exactly as before when the descriptor agrees', async () => {
    live = await harness();
    const calls = [named('run_powershell', 'Ran a script')];
    expect(
      live.hook.planLabels([{ callId: null, original: 'Called tool', tool: 'run_powershell' }], calls)
    ).toEqual([[0, calls[0], []]]);
  });

  it('says nothing either way when the page did not name the row', async () => {
    live = await harness();
    const calls = [named('computer', 'Clicked something')];
    for (const tool of [undefined, null]) {
      expect(
        live.hook.planLabels([{ callId: null, original: 'Called tool', tool }], calls)
      ).toEqual([[0, calls[0], []]]);
    }
  });

  it('abandons the whole even pairing when one row contradicts it', async () => {
    live = await harness();
    // Two rows, two calls, in order — the strongest signal this file has. One descriptor
    // disagreeing means these are not the same two calls, so the other pair is worth no
    // more than this one. The contradiction is on the first row, so nothing downstream
    // can label it either: if the even pairing had fired, both rows would be named.
    const calls = [named('read_file', 'Read a.ts'), named('computer', 'Clicked something')];
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool', tool: 'screenshot' },
          { callId: null, original: 'Called tool', tool: 'computer' }
        ],
        calls
      )
    ).toEqual([]);
  });

  it('stops the generic run at the first row the page contradicts', async () => {
    live = await harness();
    // Three rows and four calls, so the counts do not fit and the weakest rule is reached.
    // It walks in order, which means one wrong row puts every later row at an unknown
    // offset — so it ends the run rather than skipping the entry.
    const calls = [
      named('read_file', 'Read a.ts'),
      named('screenshot', 'Took a picture'),
      named('computer', 'Clicked something'),
      named('read_file', 'Read b.ts')
    ];
    expect(
      live.hook.planLabels(
        [
          { callId: null, original: 'Called tool', tool: 'read_file' },
          { callId: null, original: 'Called tool', tool: 'list_windows' },
          { callId: null, original: 'Called tool', tool: 'computer' }
        ],
        calls
      )
    ).toEqual([[0, calls[0], []]]);
  });

  /**
   * "Never move a label" exists so labels do not shuffle between repaints. It is not a
   * reason to let a label the page has since contradicted stay on a row: the first paint
   * can happen before any descriptor has arrived, which is exactly how the live rows got
   * their wrong names.
   */
  it('takes back a bound label the page contradicts, and re-lands both calls', async () => {
    live = await harness();
    const first = call({
      turnId: 't1',
      callId: 'call-b',
      seq: 1,
      tool: 'computer',
      summary: { kind: 'agent', tone: 'neutral', title: 'Clicked something' }
    });
    const second = call({
      turnId: 't1',
      callId: 'call-a',
      seq: 2,
      tool: 'run_powershell',
      summary: { kind: 'agent', tone: 'neutral', title: 'Ran a script' }
    });
    const plan = live.hook.planLabels(
      [
        { callId: 'call-a', original: 'Called tool', tool: 'computer' },
        { callId: null, original: 'Called tool', tool: 'run_powershell' }
      ],
      [first, second]
    );
    // A null call is the instruction to take the label off. The call it was wearing goes
    // back into the pool unconsumed, and both rows then land on the call they name.
    expect(plan).toEqual([
      [0, null, []],
      [0, first, []],
      [1, second, []]
    ]);
  });
});

/**
 * Which agent ran which tool.
 *
 * A run with a prime and two workers puts three streams of calls into one chat. The rows
 * said three tools ran and nothing about who ran them, so a worker's failed command read
 * as the prime's. The app attributes this itself, having run the call, which is why it can
 * be shown flatly rather than hedged the way page-sourced evidence has to be.
 */
describe('naming the agent behind a row', () => {
  async function turnOf(entries: ActivityEntry[]): Promise<HTMLElement> {
    // Relabelling a row is presentation, so it lives behind the same switch as the stream
    // and a test that wants it has to ask. See renderingOn().
    renderingOn();
    const section = assistantTurn(
      live!.document,
      'turn-1',
      entries.map(() => 'Called tool')
    );
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries,
        job: null
      }
    }));
    await live!.hook.pullActivity();
    await settle();
    return section;
  }

  it('puts the agent in front of what it did', async () => {
    live = await harness();
    const section = await turnOf([
      call({ turnId: 'turn-1', seq: 1, agent: 'prime', summary: { kind: 'read', tone: 'neutral', title: 'Read a.ts' } }),
      call({
        turnId: 'turn-1',
        seq: 2,
        agent: 'worker-1',
        outcome: 'error',
        summary: { kind: 'run', tone: 'bad', title: 'Command failed' }
      })
    ]);
    expect(labels(section)).toEqual(['primeRead a.ts', 'worker-1Command failed']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(2);
    expect([...section.querySelectorAll('[data-clf-agent]')].map((node) => node.getAttribute('data-clf-agent'))).toEqual(
      ['prime', 'worker-1']
    );
  });

  it('says nothing in a chat that has no agents', async () => {
    live = await harness();
    const section = await turnOf([
      call({ turnId: 'turn-1', seq: 1, summary: { kind: 'read', tone: 'neutral', title: 'Read a.ts' } })
    ]);
    expect(labels(section)).toEqual(['Read a.ts']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);
    expect(section.querySelector('.clf-agent')).toBeNull();
  });

  /** An id long enough to push the tool's own name off the row would hide the row's point. */
  it('ignores an agent id that is not one', async () => {
    live = await harness();
    for (const agent of ['', '   ', 'w'.repeat(41), 42 as never, null]) {
      const section = await turnOf([
        call({ turnId: 'turn-1', seq: 1, agent, summary: { kind: 'read', tone: 'neutral', title: 'Read a.ts' } })
      ]);
      expect(section.querySelector('.clf-agent'), String(agent)).toBeNull();
      section.remove();
    }
  });

  /**
   * ChatGPT collapses a run of rows by *tool name*, which says nothing about who called
   * it — so one folded row can hide two agents' work behind a third agent's label. That
   * makes the folded list the place where mixing them up is easiest and worst.
   */
  it('names the agent on each call a row folded away', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    // The recorded tool matches the one the row's descriptor names below, as it does for a
    // row that really is these calls — a row only takes a call it does not contradict.
    const entries = ['prime', 'worker-1', 'worker-2'].map((agent, n) =>
      call({
        turnId: 'turn-1',
        seq: n + 1,
        agent,
        tool: 'run_command',
        summary: { kind: 'run', tone: 'neutral', title: `Step ${n}` }
      })
    );
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries,
        job: null
      }
    }));
    await replyFiber([
      {
        v: 8,
        index: 0,
        tool: 'run_command',
        path: null,
        app: null,
        resource: null,
        messageId: null,
        turnId: 'turn-1',
        conversationId: null,
        createTime: null,
        hidden: 2,
        answered: true
      }
    ]);
    await live.hook.pullActivity();
    await settle();

    expect(labels(section)).toEqual(['worker-2Step 2+2']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);
    expect([...section.querySelectorAll('.clf-fold-list .clf-agent')].map((node) => node.textContent)).toEqual([
      'prime',
      'worker-1'
    ]);
  });
});

/**
 * One transcript, not a transcript plus a shadow log.
 *
 * The appended "Local timeline" block existed because relabelling was unreliable, and it
 * restated rows that were already on the page a few pixels above it. Its other half was
 * ChatGPT's own progress captions, which `progressLine()` reads straight out of the
 * reasoning box the page is already showing — so both halves were duplication.
 *
 * The calls that genuinely had nowhere to appear are the ones ChatGPT collapsed into a
 * neighbouring row. Those go inside the row that swallowed them.
 */
describe('the calls a row folded away', () => {
  const FOLDED = {
    v: 8,
    index: 0,
    tool: 'run_command',
    path: '/TobisComputer/mcp/run_command',
    app: 'TobisComputer',
    resource: null,
    messageId: 'msg-1',
    turnId: 'turn-1',
    conversationId: 'conv-1',
    createTime: 1_700_000_000,
    hidden: 4,
    localCount: 5,
    answered: true
  };

  /** A turn of one row that stands for five recorded calls. */
  async function foldedTurn(): Promise<HTMLElement> {
    renderingOn();
    const section = assistantTurn(live!.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    const calls = [0, 1, 2, 3, 4].map((n) =>
      call({
        turnId: 'turn-1',
        callId: `call-${n}`,
        seq: n + 1,
        tool: 'run_command',
        summary: { kind: 'run', tone: 'neutral', title: `Step ${n}`, metric: n === 0 ? '3 lines' : '' }
      })
    );
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: calls,
        job: null
      }
    }));
    await replyFiber([FOLDED]);
    await live!.hook.pullActivity();
    await settle();
    return section;
  }

  it('never appends a second transcript to the turn', async () => {
    live = await harness();
    const section = await foldedTurn();
    expect(section.querySelector('.clf-timeline')).toBeNull();
    expect((section.textContent || '')).not.toContain('Local timeline');
  });

  it('puts them under the row that hides them, closed until asked', async () => {
    live = await harness();
    const section = await foldedTurn();
    expect(labels(section)).toEqual(['Step 4+4']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);

    const list = section.querySelector('.clf-fold-list') as HTMLElement;
    expect(list.hasAttribute('hidden')).toBe(true);
    expect([...list.querySelectorAll('.clf-label')].map((node) => node.textContent)).toEqual([
      'Step 0',
      'Step 1',
      'Step 2',
      'Step 3'
    ]);
    // The row's own metric belongs to the row; a folded call keeps its own.
    expect(list.querySelector('.clf-metric')!.textContent).toBe('3 lines');
  });

  /**
   * The chip sits inside ChatGPT's own header button, so an unhandled click would open
   * the row's card as well — two things from one press, neither of them asked for.
   */
  it('opens and closes them without also working ChatGPT’s own control', async () => {
    live = await harness();
    const section = await foldedTurn();
    const chip = section.querySelector('.clf-folded') as HTMLElement;
    const list = section.querySelector('.clf-fold-list') as HTMLElement;
    const header = section.querySelector('button') as HTMLElement;

    let reached = 0;
    header.addEventListener('click', () => {
      reached++;
    });

    const press = () =>
      chip.dispatchEvent(new live!.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    press();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(list.hasAttribute('hidden')).toBe(false);

    press();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(list.hasAttribute('hidden')).toBe(true);
    expect(reached).toBe(0);
  });

  it('leaves it open across a repaint', async () => {
    live = await harness();
    const section = await foldedTurn();
    const chip = section.querySelector('.clf-folded') as HTMLElement;
    chip.dispatchEvent(new live.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    await live.hook.pullActivity();
    await settle();
    expect((section.querySelector('.clf-folded') as HTMLElement).getAttribute('aria-expanded')).toBe('true');
    expect((section.querySelector('.clf-fold-list') as HTMLElement).hasAttribute('hidden')).toBe(false);
  });

  /** Hidden by default; the popup switch restores it for debugging. */
  it('gives every relabelled row the time the app ran the call when enabled', async () => {
    live = await harness();
    live.hook.setShowTimes(true);
    const section = await foldedTurn();
    const when = section.querySelector('.clf-when') as HTMLElement;
    expect(when.textContent).toBe(new Date(1_700_000_000_005).toLocaleTimeString());
    expect([...section.querySelectorAll('.clf-fold-list .clf-time')].map((node) => node.textContent)).toEqual(
      [1, 2, 3, 4].map((n) => new Date(1_700_000_000_000 + n).toLocaleTimeString())
    );
  });
});

describe('page-native tool presentation and archived row evidence', () => {
  it.skip('legacy row ownership: counts a connector row and ignores the built-in beside it', async () => {
    live = await harness();
    const turn = assistantTurn(live.document, 'turn-mixed', ['Searched the web', 'Called tool!']);
    expect(live.hook.connectorBlockCount(turn)).toBe(1);
  });

  it.skip('legacy row ownership: counts the calls ChatGPT folded behind one connector row', async () => {
    live = await harness();
    const turn = assistantTurn(live.document, 'turn-folded-evidence', ['Called tool!']);
    turn.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    await replyFiber([{
      v: 8,
      index: 0,
      tool: 'read',
      path: '/ChatGPT Local Files Core/link_x/read',
      app: 'ChatGPT Local Files Core',
      resource: 'resource://tools/read',
      messageId: 'msg-folded',
      turnId: 'turn-folded-evidence',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      createTime: 1_700_000_000,
      hidden: 4,
      localCount: 5,
      answered: true
    }]);

    expect(live.hook.connectorBlockCount(turn)).toBe(5);
  });

  it.skip('legacy row ownership: does not let another connector row vouch for this app', async () => {
    live = await harness();
    const turn = assistantTurn(live.document, 'turn-other-connector', ['Called tool!']);
    turn.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    await replyFiber([{
      v: 8,
      index: 0,
      tool: 'search',
      path: '/Gmail/mcp/search',
      app: 'Gmail',
      resource: 'resource://tools/search',
      messageId: 'msg-other',
      turnId: 'turn-other-connector',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      createTime: 1_700_000_000,
      hidden: 3,
      localCount: 0,
      answered: true
    }]);

    expect(live.hook.connectorBlockCount(turn)).toBe(0);
  });

  it.skip('legacy row ownership: offers nothing for a turn that only searched the web', async () => {
    live = await harness();
    const turn = assistantTurn(live.document, 'turn-web', ['Searched the web']);
    expect(live.hook.connectorBlockCount(turn)).toBe(0);
  });

  it.skip('legacy DOM activity identity: records the visible built-in label without connector evidence', async () => {
    live = await harness();
    // Reported as the live generation's, because that is the only turn whose rows can be
    // dated. A row on a settled section is deliberately not re-reported: its label keeps
    // being rewritten long after the turn ended, and reporting every section every tick
    // filed finished turns' activity as if it had just happened.
    const turn = assistantTurn(live.document, 'turn-native-web', ['Searched the web']);
    startGenerating(live.document);
    live.hook.observe();
    await settle();

    const native = emitted(live.sent, 'page_tool');
    expect(native).toHaveLength(1);
    expect(native[0]!.event.text).toBe('Searched the web');
    // The local generation key, not ChatGPT's `data-turn-id` — the page reuses those.
    expect(native[0]!.event.turnId).toMatch(/^g-[a-z0-9]+-\d+-\d+$/);
    // Namespaced by that same generation and numbered by the step, not by the row: React
    // replaces these rows as they settle, so the id survives ChatGPT rewriting the label and
    // cannot be claimed by a later turn.
    expect(native[0]!.event.messageId).toMatch(/^g-[a-z0-9]+-\d+-\d+#s0$/);
    expect(native[0]!.event.messageId!.startsWith(`${native[0]!.event.turnId}#`)).toBe(true);
  });

  it.skip('legacy DOM activity identity: does not record ChatGPT saying it is busy as a step it took', async () => {
    live = await harness();
    // The live shape: one reasoning row that says `Thinking` before it says anything real.
    // Recorded, it became a timeline row reading `ChatGPT: Thinking`.
    assistantTurn(live.document, 'turn-busy', ['Thinking']);
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'page_tool')).toHaveLength(0);

    // A step whose name merely begins with one of those words is a step.
    const label = live.document.querySelector('.text-start') as HTMLElement;
    label.textContent = 'Thinking through the release gate';
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'page_tool').map((entry) => entry.event.text)).toEqual([
      'Thinking through the release gate'
    ]);
  });

  it.skip('legacy DOM activity identity: rewrites one reasoning row in place', async () => {
    live = await harness();
    // ChatGPT reuses a single headline node for every reasoning step of a turn. Keyed by
    // the node alone, six visible steps arrived under one id and superseded each other,
    // so the log kept whichever happened to be last.
    assistantTurn(live.document, 'turn-steps', ['Documenting harness issues']);
    startGenerating(live.document);
    const label = live.document.querySelector('.text-start') as HTMLElement;
    live.hook.observe();
    await settle();

    // Same step, finished. The tense changed, the step did not.
    label.textContent = 'Documented harness issues';
    live.hook.observe();
    await settle();

    // A different step. This one has to stand on its own.
    label.textContent = 'Updating the issue log';
    live.hook.observe();
    await settle();

    const steps = emitted(live.sent, 'page_tool');
    expect(steps.map((entry) => entry.event.text)).toEqual([
      'Documenting harness issues',
      'Documented harness issues',
      'Updating the issue log'
    ]);
    // The first two are one row being finished; the third is a row of its own.
    expect(steps[1]!.event.messageId).toBe(steps[0]!.event.messageId);
    expect(steps[2]!.event.messageId).not.toBe(steps[0]!.event.messageId);
  });

  /**
   * Measured live on 2026-08-17: sampling the page every 400ms caught the moment ChatGPT
   * replaces a settling reasoning row, with the outgoing and incoming node both on screen
   * holding `Read README and provided intermediate updates`. Identity taken from the row
   * recorded that step twice, once per node.
   */
  it.skip('legacy DOM activity identity: records one step across duplicate DOM rows', async () => {
    live = await harness();
    const turn = assistantTurn(live.document, 'turn-replaced', [
      'Reading README and Providing Intermediate Updates'
    ]);
    startGenerating(live.document);
    live.hook.observe();
    await settle();

    // The replacement arrives before the outgoing row goes, and settles the tense with it.
    const settling = 'Read README and provided intermediate updates';
    (live.document.querySelector('.text-start') as HTMLElement).textContent = settling;
    const replacement = toolBlock(live.document, settling);
    turn.insertBefore(replacement, turn.firstChild);
    live.hook.observe();
    await settle();

    const steps = emitted(live.sent, 'page_tool');
    expect(steps.map((entry) => entry.event.text)).toEqual([
      'Reading README and Providing Intermediate Updates',
      settling
    ]);
    // One step, updated — not a second row that happens to read the same.
    expect(steps[1]!.event.messageId).toBe(steps[0]!.event.messageId);
  });

  /**
   * The other half of the same measurement: React does not keep these rows, so the stamp on
   * a destroyed row is freed and the *next* step's row claims it. A genuinely new step then
   * arrived under the previous step's id and overwrote it.
   */
  it.skip('legacy DOM activity identity: separates steps when ChatGPT reuses a row', async () => {
    live = await harness();
    const turn = assistantTurn(live.document, 'turn-recycled', ['Inspecting the source directory']);
    startGenerating(live.document);
    live.hook.observe();
    await settle();

    // The whole row is thrown away and rebuilt for the step after it.
    turn.replaceChildren(toolBlock(live.document, 'Reading the release notes'));
    live.hook.observe();
    await settle();

    const steps = emitted(live.sent, 'page_tool');
    expect(steps.map((entry) => entry.event.text)).toEqual([
      'Inspecting the source directory',
      'Reading the release notes'
    ]);
    expect(steps[1]!.event.messageId).not.toBe(steps[0]!.event.messageId);
  });

  /**
   * The live 1.7.1 failure, from the other end. `isConnectorBlock` reads a control ChatGPT
   * removes on re-render, so Fiber is what keeps a row classified as ours. While that test
   * still spelled the single pre-1.7.1 connector name, a row belonging to the renamed
   * connector failed it — and a local call was then recorded a second time as ChatGPT's own
   * page-native activity, which is what put `ChatGPT: Inspected repository…` into the
   * desktop timeline as if the assistant had said it.
   */
  it.skip('legacy row ownership: takes a renamed connector row as this app’s own', async () => {
    live = await harness();
    const turn = assistantTurn(live.document, 'turn-renamed-connector', ['Called tool!']);
    const control = turn.querySelector('[aria-label="Open tool call list"]')!;
    control.setAttribute('data-clf-fiber', '0');
    await replyFiber([{
      v: 8,
      index: 0,
      tool: 'computer',
      path: '/ChatGPT Local Files Desktop/link_x/computer',
      app: 'ChatGPT Local Files Desktop',
      resource: 'resource://tools/computer',
      messageId: 'msg-renamed',
      turnId: 'turn-renamed-connector',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      createTime: 1_700_000_000,
      hidden: 0,
      localCount: 1,
      answered: true
    }]);

    // Classification is written onto the row for presentation even though row counts are no
    // longer an ownership signal.
    expect(control.closest('[data-clf-local="1"]')).not.toBeNull();
  });

  it('restores stock ChatGPT presentation when Overwrite is explicitly switched off', async () => {
    // Production now defaults Overwrite ON. The harness deliberately starts presentation
    // disabled so capture-only tests stay isolated; this case pins the user-facing OFF path:
    // a row the app *could* name, with a matching recorded call, is still left saying exactly
    // what ChatGPT wrote. Invisible capture stamps are allowed through and deliberately not
    // asserted against: they are how the recorder keeps a row's identity across rewrites.
    live = await harness();
    live.hook.setRenderStream(false);
    const section = assistantTurn(live.document, 'turn-untouched', ['Called tool!']);
    const row = section.querySelector('.pointer-events-none.contents') as HTMLElement;
    const label = row.querySelector('.text-start') as HTMLElement;
    const said = label.textContent;
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [call({ turnId: 'turn-untouched', callId: 'call-visible' })],
        job: null
      }
    }));
    startGenerating(live.document);
    live.hook.observe();
    await live.hook.pullActivity();
    await settle();
    live.hook.renderStreams();
    live.hook.paint();

    expect(label.textContent).toBe(said);
    expect(label.getAttribute('title')).toBeNull();
    expect(label.classList.contains('clf-tool-title')).toBe(false);
    expect(row.className).toBe('pointer-events-none contents');
    expect(row.dataset['clfCall']).toBeUndefined();
    expect(row.dataset['clfPage']).toBeUndefined();
    expect(live.document.querySelectorAll('.clf-stream')).toHaveLength(0);
    expect(live.document.querySelectorAll('.clf-tool, .clf-page')).toHaveLength(0);
    expect(section.querySelectorAll('[data-clf-native-hidden]')).toHaveLength(0);
    // Nothing of ours inserted into the row either — no icon, no duration, no agent chip.
    expect(row.querySelectorAll('[class^="clf-"], [class*=" clf-"]')).toHaveLength(0);
  });

  it('takes its own labels back off the page when the renderer is switched off', async () => {
    // The disabled path runs the restore rather than skipping the loop. Without that, a
    // switch flipped mid-session would leave this app's names frozen over ChatGPT's for the
    // life of the tab — the page would keep asserting a record nobody is maintaining.
    live = await harness();
    const section = assistantTurn(live.document, 'turn-restored', ['Called tool!']);
    const row = section.querySelector('.pointer-events-none.contents') as HTMLElement;
    const label = row.querySelector('.text-start') as HTMLElement;
    const said = label.textContent;
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [call({ turnId: 'turn-restored', callId: 'call-restored' })],
        job: null
      }
    }));
    renderingOn();
    await live.hook.pullActivity();
    await settle();
    live.hook.paint();
    expect(label.textContent).not.toBe(said);
    expect(row.classList.contains('clf-tool')).toBe(true);

    live.hook.setRenderStream(false);
    live.hook.paint();

    expect(label.textContent).toBe(said);
    expect(label.classList.contains('clf-tool-title')).toBe(false);
    expect(row.classList.contains('clf-tool')).toBe(false);
    expect(row.dataset['clfCall']).toBeUndefined();
  });

  it.skip('legacy row ownership: is not taught a built-in by seeing it twice', async () => {
    live = await harness();
    // The frequency guess this replaced would learn "Searched the web" as the connector's
    // own label here, because it is the largest group of identically-named unmatched rows,
    // and every later turn would then vouch for calls it never made.
    const twice = assistantTurn(live.document, 'turn-twice', ['Searched the web', 'Searched the web']);
    expect(live.hook.connectorBlockCount(twice)).toBe(0);

    // And the sharper version: the built-in outnumbers the connector rows, so the guess
    // would have picked it outright.
    const outnumbered = assistantTurn(live.document, 'turn-outnumbered', [
      'Searched the web',
      'Searched the web',
      'Searched the web',
      'Called tool!',
      'Called tool!'
    ]);
    expect(live.hook.connectorBlockCount(outnumbered)).toBe(2);
  });

  it.skip('legacy row ownership: keeps the first live connector row when a fresh chat is assigned its /c/<id>', async () => {
    live = await harness('https://chatgpt.com/');
    startGenerating(live.document);

    // The worker bootstrap starts on `/`. ChatGPT assigns the conversation id while the
    // first turn is already running. Treating that pathname change as a different chat
    // used to seed this row as history, so join_agent never saw evidence from its own tab.
    live.window.history.replaceState({}, '', '/c/11111111-2222-3333-4444-555555555555');
    assistantTurn(live.document, 'turn-first-worker-call', ['Called tool!']);
    await settle();

    expect(sightings(live.sent)).toEqual([{ turnId: 'turn-first-worker-call', count: 1 }]);
  });

  it('does not close a bound conversation when ChatGPT temporarily loses its route id', async () => {
    const chat = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    live = await harness(`https://chatgpt.com/c/${chat}`);
    live.hook.observe();
    await settle();
    live.sent.splice(0);

    // React/router churn can briefly leave the document without a /c/<id> even though the
    // tab and conversation are still alive. That absence must never become a lifecycle
    // event: background.js owns real tab closure via chrome.tabs.onRemoved.
    live.window.history.replaceState({}, '', '/');
    live.hook.observe();
    await settle();
    expect(live.sent.filter((message) => message.type === 'closed')).toEqual([]);

    // When the same route comes back, it is still the same bound conversation.
    live.window.history.replaceState({}, '', `/c/${chat}`);
    live.hook.observe();
    await settle();
    expect(live.sent.filter((message) => message.type === 'closed')).toEqual([]);
  });

  it('does not file a fresh composer’s first turn into the chat whose route just disappeared', async () => {
    const first = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const second = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    live = await harness(`https://chatgpt.com/c/${first}`);
    userTurn(live.document, 'turn-a1', 'question in chat A');
    live.hook.observe();
    await settle();

    // The real failure window: React has already replaced A with the fresh composer/turn,
    // but ChatGPT has not assigned /c/B yet. The old code kept `conversationId === A` here
    // and durably emitted B's user message, generation, Fiber prose/activity and request-id
    // evidence as A.
    live.document.querySelector('[data-turn-id="turn-a1"]')!.remove();
    live.dom.reconfigure({ url: 'https://chatgpt.com/' });
    userTurn(live.document, 'turn-b1', 'question in chat B');
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-b', []);
    live.hook.observe();
    await settle();
    await replyFiber([], [{
      turnId: 'page-turn-b',
      conversationId: second,
      calls: [{
        messageId: 'fiber-call-b',
        tool: 'read_file',
        order: 0,
        answered: false,
        requestId: 'wfr-chat-b'
      }],
      messages: [{
        messageId: 'site-message-b',
        stable: true,
        rawText: 'working in chat B',
        renderedHtml: '<p>working in chat B</p>'
      }],
      activities: [{ messageId: 'thought-b-0', label: 'Inspecting chat B' }]
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'user_message').map((entry) => [entry.conversationId, entry.event.text])).toEqual([
      [first, 'question in chat A']
    ]);
    expect(emitted(live.sent, 'turn_start')).toEqual([]);
    expect(emitted(live.sent, 'assistant_message')).toEqual([]);
    expect(emitted(live.sent, 'page_tool')).toEqual([]);
    expect(emitted(live.sent, 'tool_evidence')).toEqual([]);

    // Once the page supplies a concrete identity, A is retired first and the exact same DOM
    // is now safe to observe as B. Nothing is guessed from elapsed time or tail position.
    live.dom.reconfigure({ url: `https://chatgpt.com/c/${second}` });
    live.hook.observe();
    await settle();
    await replyFiber([], [{
      turnId: 'page-turn-b',
      conversationId: second,
      calls: [{
        messageId: 'fiber-call-b',
        tool: 'read_file',
        order: 0,
        answered: false,
        requestId: 'wfr-chat-b'
      }],
      messages: [{
        messageId: 'site-message-b',
        stable: true,
        rawText: 'working in chat B',
        renderedHtml: '<p>working in chat B</p>'
      }],
      activities: [{ messageId: 'thought-b-0', label: 'Inspecting chat B' }]
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'user_message').map((entry) => [entry.conversationId, entry.event.text])).toEqual([
      [first, 'question in chat A'],
      [second, 'question in chat B']
    ]);
    for (const kind of ['turn_start', 'assistant_message', 'page_tool', 'tool_evidence']) {
      const entries = emitted(live.sent, kind);
      expect(entries.length, kind).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.conversationId === second), kind).toBe(true);
    }
  });

  it('does close the old conversation when a different concrete chat replaces it', async () => {
    const first = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const second = '11111111-2222-3333-4444-555555555555';
    live = await harness(`https://chatgpt.com/c/${first}`);
    live.hook.observe();
    await settle();
    live.sent.splice(0);

    live.window.history.replaceState({}, '', `/c/${second}`);
    live.hook.observe();
    await settle();
    expect(live.sent.filter((message) => message.type === 'closed')).toEqual([
      { type: 'closed', conversationId: first }
    ]);
  });

  it.skip('legacy row ownership: reports a connector row the moment ChatGPT inserts it, cumulatively', async () => {
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-live', ['Searched the web', 'Called tool!']);
    await settle();
    expect(sightings(live.sent)).toEqual([{ turnId: 'turn-live', count: 1 }]);

    // A tick over the same rows is no new evidence, so no second call can claim them.
    live.hook.observe();
    await settle();
    expect(sightings(live.sent)).toHaveLength(1);

    turn.append(toolBlock(live.document, 'Called tool!'));
    await settle();
    expect(sightings(live.sent)).toEqual([
      { turnId: 'turn-live', count: 1 },
      { turnId: 'turn-live', count: 2 }
    ]);
  });

  /**
   * The turn that began and ended between two ticks.
   *
   * This is the race that made the poll unusable on its own. The app now answers a tool
   * call without waiting to work out where it came from, so a quick read can be answered,
   * consumed and the whole reply finished inside one observe interval. A page that only
   * looked once a second would find nothing generating and report nothing, and the chat's
   * own call would be recorded as if it had come from another device.
   */
  it.skip('legacy row ownership: still reports a row when the turn is over before the next tick', async () => {
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-fast', []);
    live.hook.observe();
    await settle();

    // Everything ChatGPT does between ticks: the row, the answer, and the stop button
    // going away — with no observe() in between.
    turn.append(toolBlock(live.document, 'Called tool!'));
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'fast answer';
    turn.append(answer);
    live.document.querySelector('[data-testid="stop-button"]')!.remove();
    await settle();
    expect(sightings(live.sent)).toEqual([{ turnId: 'turn-fast', count: 1 }]);

    // And the end arrives after the evidence, never before it: the app discards a turn's
    // unclaimed rows when the turn ends, so the other order would strand them.
    await settleTurn(live);
    const kinds = live.sent
      .filter((message) => message.type === 'events')
      .flatMap((message) => (message.entries ?? []) as Array<Record<string, any>>)
      .map((entry) => entry.event.kind);
    expect(kinds.indexOf('tool_block')).toBeLessThan(kinds.indexOf('turn_end'));
  });

  it.skip('legacy row ownership: sees a row that arrives wrapped inside a larger subtree', async () => {
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-wrapped', []);
    live.hook.observe();
    await settle();

    // React inserts a subtree, not a row: what the page appends is a wrapper, and the
    // connector row is somewhere underneath it.
    const wrapper = live.document.createElement('div');
    wrapper.append(live.document.createElement('div'));
    wrapper.firstElementChild!.append(toolBlock(live.document, 'Called tool!'));
    turn.append(wrapper);
    await settle();
    expect(sightings(live.sent)).toEqual([{ turnId: 'turn-wrapped', count: 1 }]);
  });

  it.skip('legacy row ownership: offers no evidence at all for a chat that is merely being opened', async () => {
    live = await harness();
    // History arriving after the page is up: a whole thread of turns, nothing generating.
    assistantTurn(live.document, 'turn-old-1', ['Called tool!', 'Called tool!']);
    assistantTurn(live.document, 'turn-old-2', ['Called tool!']);
    await settle();
    live.hook.observe();
    await settle();
    expect(sightings(live.sent)).toEqual([]);

    // And the chat stays capable of vouching for its own next call.
    startGenerating(live.document);
    live.document.querySelector('[data-turn-id="turn-old-2"]')!.append(toolBlock(live.document, 'Called tool!'));
    await settle();
    expect(sightings(live.sent)).toEqual([{ turnId: 'turn-old-2', count: 2 }]);
  });
});

/** Every observation of one kind the content script has sent, in order. */
function emitted(sent: Array<Record<string, any>>, kind: string): Array<Record<string, any>> {
  return sent
    .filter((message) => message.type === 'events')
    .flatMap((message) => (message.entries ?? []) as Array<Record<string, any>>)
    .filter((entry) => entry.event?.kind === kind);
}

/** One error banner, in the shape ChatGPT renders a toast. */
function alertBanner(document: Document, text: string): HTMLElement {
  const node = document.createElement('div');
  node.setAttribute('role', 'alert');
  node.textContent = text;
  document.body.append(node);
  return node;
}

/**
 * Moving between chats in a single-page app.
 *
 * ChatGPT changes `/c/<id>` and replaces the transcript as two separate steps, and there
 * is no promise about which comes first. The content script cannot wait a fixed time for
 * the DOM to catch up — a guess that is too short files the old chat into the new one and
 * a guess that is too long drops the new chat's opening message — so what it does instead
 * is prove which sections it was already watching before the URL moved.
 */
describe('recording authored message text', () => {
  it('reports ChatGPT’s generated document title as conversation metadata and ignores the generic shell title', async () => {
    live = await harness();
    live.document.title = 'Fix Local Files Reconstruction | ChatGPT';
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'conversation_title').map((entry) => entry.event.text)).toEqual([
      'Fix Local Files Reconstruction'
    ]);

    live.document.title = 'ChatGPT';
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'conversation_title')).toHaveLength(1);
  });

  it('does not persist Show more / Show less controls as part of a user message', async () => {
    live = await harness();
    const section = userTurn(live.document, 'turn-user-chrome', 'the exact authored message');
    const message = section.querySelector('[data-message-id]')!;
    for (const label of ['Show more', 'Show less']) {
      const button = live.document.createElement('button');
      button.textContent = label;
      message.append(button);
    }

    live.hook.observe();
    await settle();

    const messages = emitted(live.sent, 'user_message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.event.text).toBe('the exact authored message');
  });

  /**
   * A turn that streamed commentary and called tools but never produced authored prose.
   *
   * The preferred path reads `.markdown`, which excludes commentary by construction. The
   * whole-node fallback did not: it stripped our own surfaces, ChatGPT's controls and the
   * tool rows, and then returned everything else — including the `[data-interrupted]`
   * commentary. So a turn with no answer at all promoted its own thinking-out-loud to
   * `assistant_message` with `final: true`, which is a completed turn as far as every
   * reader downstream is concerned. Recovery then treats the turn as answered, and the
   * text it "answered" with is a caption the user watched scroll past.
   */
  it.skip('legacy progress source: does not promote commentary to a final answer for a turn that produced no prose', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-no-prose', []);
    const commentary = live.document.createElement('div');
    commentary.setAttribute('data-interrupted', 'false');
    commentary.textContent = 'Reading the recorder';
    // Our own rendered stream, and a native tool row: both are inside the section and
    // neither is anything the assistant authored.
    const ours = live.document.createElement('div');
    ours.className = 'clf-stream';
    ours.textContent = 'Read recorder.ts';
    section.append(commentary, ours, toolBlock(live.document, 'Searched the web'));

    live.hook.observe();
    await settle();
    live.document.querySelector('[data-testid="stop-button"]')!.remove();
    live.hook.observe();
    await settle();

    // The commentary is captured — as commentary, which is what it is.
    expect(emitted(live.sent, 'progress').map((entry) => entry.event.text)).toEqual(['Reading the recorder']);
    // And nothing was recorded as the turn's answer.
    expect(emitted(live.sent, 'assistant_message')).toHaveLength(0);
  });

  it.skip('legacy progress source: records assistant markdown between tools as current-turn progress and finalises only the last block', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'request-reused-0', []);

    const first = live.document.createElement('div');
    first.className = 'markdown';
    first.textContent = 'I will inspect the recorder first.';
    section.append(first);

    live.hook.observe();
    await settle();

    const second = live.document.createElement('div');
    second.className = 'markdown';
    second.textContent = 'The recorder path is correct; now I am checking duplicates.';
    section.append(second);
    live.hook.observe();
    await settle();

    const interim = emitted(live.sent, 'progress').filter((entry) =>
      String(entry.event.progressId || '').includes('#a')
    );
    expect(interim.map((entry) => entry.event.text)).toEqual([
      'I will inspect the recorder first.',
      'The recorder path is correct; now I am checking duplicates.'
    ]);
    expect(new Set(interim.map((entry) => entry.event.turnId)).size).toBe(1);
    const localTurn = interim[0]!.event.turnId;
    expect(localTurn).toMatch(/^g-/);

    const final = live.document.createElement('div');
    final.className = 'markdown';
    final.textContent = 'Recorder fixed.';
    section.append(final);
    await settleTurn(live);

    const answers = emitted(live.sent, 'assistant_message');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.event.text).toBe('Recorder fixed.');
    expect(answers[0]!.event.turnId).toBe(localTurn);
    expect(answers[0]!.event.turnId).not.toBe('request-reused-0');
  });

  /**
   * The double transcription: one answer recorded twice, the first copy a truncated prefix
   * of the second.
   *
   * The stop button is not a statement that the answer is finished. ChatGPT unmounts it
   * between phases and across rerenders, so the page reports "not generating" in the middle
   * of a turn that is still being written — which is why a turn is not closed until the
   * button has stayed gone for a settle window.
   *
   * The guard that was supposed to cover that window asked whether the section had changed
   * since the previous observation. A live answer is momentarily unchanged between render
   * frames, so a flicker that landed on a still frame answered "settled", and the prefix on
   * screen at that instant was published as the final answer. The rest of the answer then
   * arrived as a second message under a different digest, and the session held both.
   */
  /**
   * The double transcription, from session 2026-08-18-6098b925: one answer recorded twice,
   * the first copy a frozen truncated prefix of the second, both in the same turn.
   *
   * The two families of streaming text are told apart by where they sit — prose is
   * `.markdown` outside a `[data-interrupted]` container, commentary is what is inside one
   * — and ChatGPT moves text across that line mid-answer, mounting the markdown first and
   * wrapping it a moment later. So the same words were reported under `#a0` and then under
   * `#p0`. The `#p0` chain revised itself correctly with every token; nothing could ever
   * revise `#a0`, because no later observation used that id again. The user's screen kept
   * "Yeah bro, I'll stay on the **current" above the finished paragraph, for good.
   */
  it.skip('legacy progress source: keeps one row when ChatGPT wraps streaming prose into its commentary container', async () => {
    live = await harness();
    goLive();

    const section = assistantTurn(live.document, 'turn-wrapped', []);
    const prose = live.document.createElement('div');
    prose.className = 'markdown';
    prose.textContent = "Yeah bro, I'll stay on the **current";
    section.append(prose);
    live.hook.observe();
    await settle();

    // ChatGPT wraps what it has already written, and goes on writing into it.
    const container = live.document.createElement('div');
    container.setAttribute('data-interrupted', '');
    section.append(container);
    container.append(prose);
    prose.textContent = "Yeah bro, I'll stay on the current Claude Code run, and watch the live state.";
    live.hook.observe();
    await settle();

    const rows = emitted(live.sent, 'progress');
    expect(rows.length).toBeGreaterThan(1);
    // One identity, so the app has one row to revise rather than an orphaned prefix and a
    // second row that grows beside it.
    expect(new Set(rows.map((entry) => entry.event.progressId)).size).toBe(1);
    expect(rows.at(-1)!.event.text).toBe(
      "Yeah bro, I'll stay on the current Claude Code run, and watch the live state."
    );
  });

  /**
   * Two different answers that ChatGPT gave the same id and that happen to be the same
   * length.
   *
   * Streaming assistant prose has no id of its own, so one is derived from the section's
   * turn id — and the page reuses those. After a content-script reload the map that would
   * make the derived id unique is empty, which is exactly when the whole visible transcript
   * is offered again. The occurrence key therefore has to separate them by *what they say*.
   * It used to be a 32-bit FNV hash plus the length; a collision there drops a real message
   * before the recorder ever sees it, and the log cannot be repaired from a message that
   * was never sent.
   */
  it.skip('legacy local-id source: keeps two same-length answers that ChatGPT filed under one id', async () => {
    live = await harness();
    const first = assistantTurn(live.document, 'turn-reused', []);
    const one = live.document.createElement('div');
    one.className = 'markdown';
    one.textContent = 'the first settled answer';
    first.append(one);

    live.hook.observe();
    await settle();

    // The next turn, rendered under the id the page has just reused. Nothing distinguishes
    // the two derived message ids, so the only thing that can tell the answers apart is
    // what they say — and these two say different things at exactly the same length.
    first.remove();
    const second = assistantTurn(live.document, 'turn-reused', []);
    const two = live.document.createElement('div');
    two.className = 'markdown';
    two.textContent = 'the second sealed answer';
    second.append(two);
    expect(two.textContent!.length).toBe(one.textContent!.length);

    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'assistant_message').map((entry) => entry.event.text)).toEqual([
      'the first settled answer',
      'the second sealed answer'
    ]);
  });
});

describe('canonical Fiber transcript ingestion in 1.8', () => {
  it('records the first unstable assistant interim before any MCP request id exists', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-first-interim', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'page-turn-first-interim',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'assistant-first-interim-raw-id',
        rawMessageId: 'assistant-first-interim-raw-id',
        role: 'assistant',
        stable: false,
        createTime: 1_787_165_100_125,
        rawText: 'Starting with the first visible interim.',
        renderedHtml: '<p>Starting with the first visible interim.</p>'
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    const first = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      messageId: 'assistant-first-interim-raw-id',
      text: 'Starting with the first visible interim.',
      time: 1_787_165_100_125,
      state: 'streaming',
      final: false
    });
    expect(emitted(live.sent, 'tool_evidence')).toHaveLength(0);

    // Streaming growth under the same ChatGPT id is another revision of the same logical
    // transcript row, not a second interim.
    await replyFiber([], [{
      turnId: 'page-turn-first-interim',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'assistant-first-interim-raw-id',
        rawMessageId: 'assistant-first-interim-raw-id',
        role: 'assistant',
        stable: false,
        createTime: 1_787_165_100_125,
        rawText: 'Starting with the first visible interim. Still working.',
        renderedHtml: '<p>Starting with the first visible interim. Still working.</p>'
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    const revisions = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(revisions).toHaveLength(2);
    expect(new Set(revisions.map((entry) => entry.messageId))).toEqual(new Set(['assistant-first-interim-raw-id']));
  });

  it('records a page-model user message even when the DOM has not exposed data-message-id yet', async () => {
    live = await harness();
    assistantTurn(live.document, 'page-turn-model-user', []);

    await replyFiber([], [{
      turnId: 'page-turn-model-user',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'user-model-opening-id',
        rawMessageId: 'user-model-opening-id',
        role: 'user',
        stable: true,
        createTime: 1_787_165_090_500,
        rawText: 'opening prompt from the page model',
        renderedHtml: ''
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'user_message').map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({
        messageId: 'user-model-opening-id',
        text: 'opening prompt from the page model',
        time: 1_787_165_090_500
      })
    );
  });

  it('records exact historical transcript from a Fiber descriptor with no page turn id', async () => {
    live = await harness();
    await replyFiber([], [{
      turnId: null,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'assistant-idless-history',
        rawMessageId: 'assistant-idless-history',
        role: 'assistant',
        stable: true,
        createTime: 1_780_000_000_000,
        rawText: 'Historical answer from an id-less virtualized section.',
        renderedHtml: ''
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({
        messageId: 'assistant-idless-history',
        text: 'Historical answer from an id-less virtualized section.',
        time: 1_780_000_000_000,
        turnId: undefined
      })
    );
  });

  it('publishes streaming and final revisions under one ChatGPT message id with rendered HTML', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'page-turn-canonical', []);
    const prose = live.document.createElement('div');
    prose.className = 'markdown';
    prose.textContent = 'I inspected';
    section.append(prose);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'page-turn-canonical',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'msg-canonical-123',
        stable: true,
        rawText: 'I inspected',
        renderedHtml: '<p>I <strong>inspected</strong></p>'
      }]
    }]);
    await settle();
    await live.hook.flush();
    await settle();

    await settleTurn(live);
    await replyFiber([], [{
      turnId: 'page-turn-canonical',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'msg-canonical-123',
        stable: true,
        rawText: 'I inspected the tree.',
        renderedHtml: '<p>I <strong>inspected</strong> the tree.</p><pre><code>ok</code></pre>'
      }]
    }]);
    await settle();
    await live.hook.flush();
    await settle();

    const messages = emitted(live.sent, 'assistant_message');
    expect(messages).toHaveLength(2);
    expect(messages.map((entry) => entry.event.messageId)).toEqual(['msg-canonical-123', 'msg-canonical-123']);
    expect(messages[0]!.event.state).toBe('streaming');
    expect(messages[1]!.event.state).toBe('final');
    expect(messages[1]!.event.renderedHtml).toContain('<strong>inspected</strong>');
    expect(messages[1]!.event.renderedHtml).toContain('<pre><code>ok</code></pre>');
  });

  it('does not publish the same Fiber snapshot twice', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'page-turn-repeat', []);
    const prose = live.document.createElement('div');
    prose.className = 'markdown';
    prose.textContent = 'Same';
    section.append(prose);
    live.hook.observe();
    await settle();
    const turn = {
      turnId: 'page-turn-repeat',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{ messageId: 'msg-repeat', stable: true, rawText: 'Same', renderedHtml: '<p>Same</p>' }]
    };
    await replyFiber([], [turn]);
    await settle();
    await live.hook.flush();
    await settle();
    await replyFiber([], [turn]);
    await settle();
    await live.hook.flush();
    await settle();
    expect(emitted(live.sent, 'assistant_message')).toHaveLength(1);
  });

  it('re-publishes a canonical Fiber snapshot when exact local turn ownership becomes known later', async () => {
    live = await harness();
    // This section is already on screen before generation begins. Until ChatGPT visibly
    // changes it, generationTurn() correctly refuses to guess that it belongs to the new run.
    const section = assistantTurn(live.document, 'page-turn-late-owner', []);
    live.hook.observe();
    await settle();
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    const descriptor = {
      turnId: 'page-turn-late-owner',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [{
        messageId: 'call-late-owner',
        tool: 'read_file',
        order: 0,
        answered: false,
        requestId: 'wfr-late-owner'
      }],
      messages: [{
        messageId: 'msg-late-owner',
        stable: true,
        rawText: 'Checking ownership.',
        renderedHtml: '<p>Checking ownership.</p>'
      }],
      activities: [{ messageId: 'thought-late-owner-0', label: 'Inspecting ownership' }]
    };
    await replyFiber([], [descriptor]);
    await live.hook.flush();
    await settle();
    expect(emitted(live.sent, 'assistant_message').at(-1)!.event.turnId).toBeUndefined();
    expect(emitted(live.sent, 'page_tool').at(-1)!.event.turnId).toBeUndefined();
    expect(emitted(live.sent, 'tool_evidence').at(-1)!.event.turnId).toBeUndefined();

    // The page now proves that the pre-existing section is the one this generation is
    // writing into. The Fiber payload itself is byte-identical; only ownership improved.
    const authored = live.document.createElement('div');
    authored.className = 'markdown';
    authored.textContent = 'Checking ownership.';
    section.append(authored);
    live.hook.observe();
    await settle();
    await replyFiber([], [descriptor]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').at(-1)!.event.turnId).toBe(opened);
    expect(emitted(live.sent, 'page_tool').at(-1)!.event.turnId).toBe(opened);
    expect(emitted(live.sent, 'tool_evidence').at(-1)!.event.turnId).toBe(opened);
  });

  it('publishes one stable native activity id and revises only its label', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-activity', []);
    live.hook.observe();
    await settle();

    const base = {
      turnId: 'page-turn-activity',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: []
    };
    await replyFiber([], [{
      ...base,
      activities: [{ messageId: 'thought-activity-uuid-0', label: 'Inspecting the repository' }]
    }]);
    await settle();
    await live.hook.flush();
    await replyFiber([], [{
      ...base,
      activities: [{ messageId: 'thought-activity-uuid-0', label: 'Inspected the repository' }]
    }]);
    await settle();
    await live.hook.flush();

    const activity = emitted(live.sent, 'page_tool').map((entry) => entry.event);
    expect(activity.map((entry) => entry.messageId)).toEqual([
      'thought-activity-uuid-0',
      'thought-activity-uuid-0'
    ]);
    expect(activity.map((entry) => entry.text)).toEqual([
      'Inspecting the repository',
      'Inspected the repository'
    ]);
  });

  it('keeps ChatGPT model order when a thinking headline and interim prose arrive in one scan', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-interleaved', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'page-turn-interleaved',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [{
        messageId: 'interim-public',
        rawMessageId: 'interim-public',
        stable: true,
        order: 3,
        rawText: 'I have the first result; now I am checking the next part.',
        renderedHtml: '<p>I have the first result; now I am checking the next part.</p>'
      }],
      activities: [{
        messageId: 'thought-before-interim',
        label: 'Inspected the first part',
        order: 1
      }]
    }]);
    await live.hook.flush();
    await settle();

    const ordered = live.sent
      .filter((message) => message.type === 'events')
      .flatMap((message) => (message.entries ?? []) as Array<Record<string, any>>)
      .map((entry) => entry.event as Record<string, any>)
      .filter((event) => event?.kind === 'page_tool' || event?.kind === 'assistant_message')
      .map((event) => [event.kind, event.text]);
    expect(ordered).toEqual([
      ['page_tool', 'Inspected the first part'],
      ['assistant_message', 'I have the first result; now I am checking the next part.']
    ]);
  });

  it('keeps interim public prose partial when a later public message ends the turn', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-partial-final', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'page-turn-partial-final',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      endMessageId: 'final-public',
      calls: [],
      messages: [
        {
          messageId: 'interim-public',
          rawMessageId: 'interim-public',
          stable: true,
          order: 1,
          rawText: 'Interim explanation.',
          renderedHtml: '<p>Interim explanation.</p>'
        },
        {
          messageId: 'final-public',
          rawMessageId: 'final-public',
          stable: true,
          order: 3,
          rawText: 'Final answer.',
          renderedHtml: '<p>Final answer.</p>'
        }
      ],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').map((entry) => [entry.event.text, entry.event.state, entry.event.final])).toEqual([
      ['Interim explanation.', 'streaming', false],
      ['Final answer.', 'final', true]
    ]);
  });

  it('fails closed for native activity without a stable site id and for generic busy captions', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'page-turn-activity-closed', []);
    live.hook.observe();
    await settle();
    await replyFiber([], [{
      turnId: 'page-turn-activity-closed',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [],
      activities: [
        { label: 'Searched the web' },
        { messageId: 'thought-busy-0', label: 'Thinking' }
      ]
    }]);
    await settle();
    await live.hook.flush();
    expect(emitted(live.sent, 'page_tool')).toHaveLength(0);
  });
});

/** Gives the observer a live generation so node→generation mapping is available in tests. */
function goLive(): void {
  startGenerating(live!.document);
  live!.hook.observe();
}

/**
 * Turns the synthetic renderer on for one test.
 *
 * Production ships enabled by default as of 1.7.4. The test harness still starts it off so
 * renderer side effects cannot contaminate capture/attribution fixtures that are testing a
 * different concern; renderer cases opt in explicitly here.
 */
function renderingOn(): void {
  live!.hook.setRenderStream(true);
}

/**
 * Gives one or more synthetic assistant sections the same ephemeral Fiber-turn stamp the
 * real MAIN-world helper writes, then feeds the stable website objects used for ownership.
 * The numeric index is test plumbing only; production never persists it as identity.
 */
async function bindFiberTurns(
  bindings: Array<{ section: HTMLElement; turn: Record<string, unknown> }>
): Promise<void> {
  bindings.forEach(({ section }, index) => section.setAttribute('data-clf-fiber-turn', String(index)));
  await replyFiber(
    [],
    bindings.map(({ turn }, index) => ({
      index,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [],
      messages: [],
      activities: [],
      ...turn
    }))
  );
  await settle();
}

async function bindFiberRequest(section: HTMLElement, requestId: string, tool = 'read_file'): Promise<void> {
  await bindFiberTurns([{ section, turn: {
    turnId: section.getAttribute('data-turn-id'),
    calls: [{ messageId: `fiber-${requestId}`, tool, order: 0, answered: true, requestId }]
  } }]);
}

describe('naming rows in a chat that has been reloaded', () => {
  /**
   * The live failure: relabelling worked, the tab was refreshed, and the same chat came
   * back wearing nothing but ChatGPT's own names. Nothing had been switched off — the join
   * had expired. `data-turn-id` is minted per page load (`g-…` live, `request-WEB:<load>-…`
   * after a refresh), so the turn id every recorded call carries names no visible turn any
   * more. ChatGPT's connector request id is on both sides and means the same thing across
   * a reload, so that is what the fallback matches on.
   */
  it('names a reloaded turn from the request id, when its recorded turn id is gone', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live!.document, 'request-WEB:6b1f2f0a-4d2c-4f2e-9a6a-2c1d6f0b0a11-3', [
      'Called tool!'
    ]);
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [
          call({ turnId: 'g-1s6atlm1inbjf2-0-1', callId: 'call-before-reload', requestId: 'wfr_reloaded_turn' })
        ],
        job: null
      }
    }));
    await live!.hook.pullActivity();
    await settle();
    await bindFiberRequest(section, 'wfr_reloaded_turn');
    live!.hook.paint();

    const row = section.querySelector('.pointer-events-none.contents') as HTMLElement;
    expect(row.dataset['clfCall']).toBe('call-before-reload');
    expect(labels(section)[0]).toContain('Read src/main/bridge.ts');
    // Not the quieter page-named treatment, which is what this row used to fall back to:
    // that one has no result, no duration and no outcome behind it.
    expect(row.dataset['clfPage']).toBeUndefined();
  });

  it('gives one response’s calls to one visible turn and no more', async () => {
    live = await harness();
    renderingOn();
    const first = assistantTurn(live!.document, 'request-WEB:6b1f2f0a-0000-4f2e-9a6a-2c1d6f0b0a11-0', [
      'Called tool!'
    ]);
    const second = assistantTurn(live!.document, 'request-WEB:6b1f2f0a-0000-4f2e-9a6a-2c1d6f0b0a11-1', [
      'Called tool!'
    ]);
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [call({ turnId: 'g-shared-0-1', callId: 'call-once', requestId: 'wfr_one_response' })],
        job: null
      }
    }));
    await live!.hook.pullActivity();
    await settle();
    // Both sections claim the same request. One response's calls cannot have been made by
    // two visible turns, so the second must not be handed the same call over again.
    await bindFiberTurns([
      {
        section: first,
        turn: {
          turnId: first.getAttribute('data-turn-id'),
          calls: [{ messageId: 'fiber-first', tool: 'read_file', order: 0, answered: true, requestId: 'wfr_one_response' }]
        }
      },
      {
        section: second,
        turn: {
          turnId: second.getAttribute('data-turn-id'),
          calls: [{ messageId: 'fiber-second', tool: 'read_file', order: 0, answered: true, requestId: 'wfr_one_response' }]
        }
      }
    ]);
    live!.hook.paint();

    expect((first.querySelector('.pointer-events-none.contents') as HTMLElement).dataset['clfCall']).toBe('call-once');
    expect(
      (second.querySelector('.pointer-events-none.contents') as HTMLElement).dataset['clfCall']
    ).toBeUndefined();
  });
});

describe('the app-owned chronological stream', () => {
  const turnId = 'turn-app-stream';
  const activity = () => ({
    ok: true,
    data: {
      entries: [],
      stream: [
        { seq: 1, time: 100, kind: 'turn_start', turnId, agent: 'prime' },
        {
          seq: 4,
          time: 400,
          kind: 'tool_call',
          turnId,
          agent: 'prime',
          tool: 'read_file',
          callId: 'call-third',
          requestId: 'wfr-app-stream',
          outcome: 'ok',
          durationMs: 3,
          summary: { kind: 'read', tone: 'neutral', title: 'Read third.ts' }
        },
        { seq: 2, time: 200, kind: 'progress', turnId, agent: 'prime', text: 'Checking the repository' },
        {
          seq: 3,
          time: 300,
          kind: 'tool_call',
          turnId,
          agent: 'prime',
          tool: 'read_file',
          callId: 'call-second',
          requestId: 'wfr-app-stream',
          outcome: 'ok',
          durationMs: 2,
          summary: { kind: 'read', tone: 'neutral', title: 'Read second.ts' }
        }
      ],
      job: null
    }
  });

  it('shows local calls even when ChatGPT rendered no native tool row for them', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(section, 'wfr-app-stream');

    live.hook.renderStreams();

    const rows = [...section.querySelectorAll('.clf-stream-row .clf-stream-text')].map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual(['Turn started', 'Checking the repository', 'Read second.ts', 'Read third.ts']);
    expect(section.querySelectorAll('.clf-stream-tool_call')).toHaveLength(2);
    expect(section.querySelectorAll('.pointer-events-none.contents')).toHaveLength(0);
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('keeps recorder calls with no turn id visible in the turn whose time window they ran in', async () => {
    const orphanActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-one', agent: null },
          { seq: 2, time: 140, kind: 'turn_end', turnId: 'g-one', outcome: 'unknown', detail: '' },
          {
            seq: 3,
            time: 120,
            kind: 'tool_call',
            turnId: null,
            tool: 'read_file',
            callId: 'orphan-call',
            requestId: 'wfr-orphan-render',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read recorder.ts' }
          },
          { seq: 4, time: 200, kind: 'turn_start', turnId: 'g-two', agent: null }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: orphanActivity });
    renderingOn();
    const first = assistantTurn(live.document, 'dom-one', []);
    const second = assistantTurn(live.document, 'dom-two', []);
    await bindFiberRequest(first, 'wfr-orphan-render');
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(first.textContent).toContain('Read recorder.ts');
    expect(second.textContent).not.toContain('Read recorder.ts');
  });

  it('reconstructs exact orphan assistant/activity rows after a prematurely recorded turn end', async () => {
    const brokenTurn = 'g-broken-interrupted';
    const brokenActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: brokenTurn, agent: 'prime' },
          { seq: 2, time: 110, kind: 'assistant_message', turnId: brokenTurn, agent: 'prime', messageId: 'site-before-dropout', text: 'Before the dropout.', final: true },
          { seq: 3, time: 120, kind: 'turn_end', turnId: brokenTurn, agent: 'prime', outcome: 'interrupted', detail: '' },
          { seq: 4, origin: 4, time: 130, kind: 'assistant_message', turnId: null, agent: 'prime', messageId: 'site-orphan-one', text: 'Still working after it.', final: true },
          {
            seq: 5,
            time: 140,
            kind: 'tool_call',
            turnId: null,
            agent: 'prime',
            tool: 'read_file',
            callId: 'orphan-after-end',
            requestId: 'wfr-after-broken-end',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read after the false end' }
          },
          { seq: 6, time: 150, kind: 'page_tool', turnId: null, agent: 'prime', messageId: 'thought-orphan-after-end-0', label: 'Inspected after the false end' },
          { seq: 7, origin: 7, time: 160, kind: 'assistant_message', turnId: null, agent: 'prime', messageId: 'site-orphan-two', text: 'And kept going.', final: true }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: brokenActivity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-broken-interrupted', []);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-broken-interrupted',
      calls: [{ messageId: 'fiber-broken-call', tool: 'read_file', order: 0, answered: true, requestId: 'wfr-after-broken-end' }],
      messages: [
        { messageId: 'site-before-dropout', stable: true, rawText: 'Before the dropout.', renderedHtml: '' },
        { messageId: 'site-orphan-one', stable: true, rawText: 'Still working after it.', renderedHtml: '' },
        { messageId: 'site-orphan-two', stable: true, rawText: 'And kept going.', renderedHtml: '' }
      ],
      activities: [{ messageId: 'thought-orphan-after-end-0', label: 'Inspected after the false end' }]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    const rows = [...section.querySelectorAll('.clf-stream-row .clf-stream-text')].map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual([
      'Turn started',
      'Before the dropout.',
      'Still working after it.',
      'Read after the false end',
      'Inspected after the false end',
      'And kept going.',
      'Turn interrupted'
    ]);
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('reconstructs a visible Fiber turn from canonical assistant ids even with no local lifecycle group', async () => {
    const messageOnlyActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 10, origin: 4, time: 100, kind: 'assistant_message', turnId: null, agent: null, messageId: 'site-message-only-one', text: 'First canonical partial.', final: true },
          { seq: 11, origin: 9, time: 200, kind: 'assistant_message', turnId: null, agent: null, messageId: 'site-message-only-two', text: 'Second canonical partial.', final: true }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: messageOnlyActivity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-message-only', []);
    const native = live.document.createElement('div');
    native.className = 'markdown';
    native.textContent = 'Second canonical partial.';
    section.append(native);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-message-only',
      messages: [
        { messageId: 'site-message-only-one', stable: true, rawText: 'First canonical partial.', renderedHtml: '' },
        { messageId: 'site-message-only-two', stable: true, rawText: 'Second canonical partial.', renderedHtml: '' }
      ]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    const rows = [...section.querySelectorAll('.clf-stream-assistant_message .clf-stream-text')].map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual(['First canonical partial.', 'Second canonical partial.']);
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('never hides native assistant prose when the local stream has the tool call but not that message yet', async () => {
    const incompleteActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-incomplete-overwrite', agent: 'prime' },
          {
            seq: 2,
            time: 120,
            kind: 'tool_call',
            turnId: 'g-incomplete-overwrite',
            agent: 'prime',
            tool: 'read_file',
            callId: 'call-incomplete-overwrite',
            requestId: 'wfr-incomplete-overwrite',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read while transcript catches up' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: incompleteActivity });
    renderingOn();
    const section = assistantTurn(live.document, 'page-incomplete-overwrite', []);
    const native = live.document.createElement('div');
    native.className = 'markdown';
    native.textContent = 'This native interim has not reached the local app yet.';
    section.append(native);
    await bindFiberTurns([{ section, turn: {
      turnId: 'page-incomplete-overwrite',
      calls: [{
        messageId: 'fiber-incomplete-call',
        tool: 'read_file',
        order: 0,
        answered: true,
        requestId: 'wfr-incomplete-overwrite'
      }],
      messages: [{
        messageId: 'site-incomplete-interim',
        stable: false,
        rawText: 'This native interim has not reached the local app yet.',
        renderedHtml: ''
      }]
    } }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(section.getAttribute('data-clf-turn-replaced')).toBeNull();
    expect(section.querySelector('.clf-stream')).toBeNull();
    expect(native.textContent).toBe('This native interim has not reached the local app yet.');
  });

  it('does not merge separate assistant turns when ChatGPT reuses the same DOM turn id', async () => {
    const reusedActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-one', agent: null },
          { seq: 2, time: 120, kind: 'progress', turnId: 'g-one', text: 'First work' },
          { seq: 3, time: 130, kind: 'assistant_message', turnId: 'g-one', messageId: 'site-reused-one', text: 'First answer', final: true },
          { seq: 4, time: 140, kind: 'turn_end', turnId: 'g-one', outcome: 'unknown', detail: '' },
          { seq: 5, time: 200, kind: 'turn_start', turnId: 'g-two', agent: null },
          { seq: 6, time: 220, kind: 'progress', turnId: 'g-two', text: 'Second work' },
          { seq: 7, time: 230, kind: 'assistant_message', turnId: 'g-two', messageId: 'site-reused-two', text: 'Second answer', final: true }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: reusedActivity });
    renderingOn();
    const first = assistantTurn(live.document, 'request-reused', []);
    userTurn(live.document, 'user-between', 'next');
    const second = assistantTurn(live.document, 'request-reused', []);
    await bindFiberTurns([
      { section: first, turn: { turnId: 'request-reused', messages: [{ messageId: 'site-reused-one', stable: true, rawText: 'First answer', renderedHtml: '' }] } },
      { section: second, turn: { turnId: 'request-reused', messages: [{ messageId: 'site-reused-two', stable: true, rawText: 'Second answer', renderedHtml: '' }] } }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(first.textContent).toContain('First work');
    expect(first.textContent).not.toContain('Second work');
    expect(second.textContent).toContain('Second work');
    expect(live.document.querySelectorAll('.clf-stream')).toHaveLength(2);
  });

  it('hides timestamps by default and can show them without changing the stream', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(section, 'wfr-app-stream');
    live.hook.renderStreams();
    expect(section.querySelector('.clf-when')).toBeNull();

    live.hook.setShowTimes(true);
    live.hook.renderStreams();
    expect(section.querySelector('.clf-when')).not.toBeNull();
  });

  it('does not present an exec yield duration as if it were a finished-command duration', async () => {
    const metricActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId, agent: null },
          {
            seq: 2,
            time: 110,
            kind: 'tool_call',
            turnId,
            agent: null,
            tool: 'exec_command',
            callId: 'still-running',
            requestId: 'wfr-metric-stream',
            outcome: 'ok',
            durationMs: 10_000,
            summary: { kind: 'run', tone: 'good', title: 'Ran npm run verify', metric: '✓ 10.0s' }
          },
          {
            seq: 3,
            time: 120,
            kind: 'tool_call',
            turnId,
            agent: null,
            tool: 'exec_command',
            callId: 'failed',
            requestId: 'wfr-metric-stream',
            outcome: 'error',
            durationMs: 900,
            summary: { kind: 'run', tone: 'bad', title: 'Command failed npm test', metric: '✕ exit 1' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: metricActivity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(section, 'wfr-metric-stream', 'exec_command');
    live.hook.renderStreams();

    expect(section.textContent).toContain('Ran npm run verify');
    expect(section.textContent).not.toContain('✓ 10.0s');
    expect(section.textContent).toContain('✕ exit 1');
  });

  it('ignores ChatGPT DOM reasoning order and renders only the order recorded by the app', async () => {
    const orderedActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 0, time: 90, kind: 'turn_start', turnId, agent: null },
          {
            seq: 1,
            time: 100,
            kind: 'tool_call',
            turnId,
            agent: null,
            tool: 'list_roots',
            callId: 'roots-call',
            requestId: 'wfr-order-stream',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Listed approved folders' }
          },
          {
            seq: 2,
            time: 200,
            kind: 'tool_call',
            turnId,
            agent: null,
            tool: 'list_windows',
            callId: 'windows-call',
            requestId: 'wfr-order-stream',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Listed open windows' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: orderedActivity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    const reasoning = live.document.createElement('div');
    reasoning.setAttribute('data-interrupted', 'false');
    reasoning.append(toolBlock(live.document, 'Checked available roots'));
    const prose = live.document.createElement('p');
    prose.textContent = 'checking windows';
    reasoning.append(prose);
    reasoning.append(toolBlock(live.document, 'Listed roots and windows'));
    section.append(reasoning, toolBlock(live.document, 'Called tool!'), toolBlock(live.document, 'Called tool!'));
    await bindFiberRequest(section, 'wfr-order-stream', 'list_roots');

    live.hook.renderStreams();

    const rows = [...section.querySelectorAll('.clf-stream-row .clf-stream-text')].map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual(['Turn started', 'Listed approved folders', 'Listed open windows']);
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(reasoning.getAttribute('data-clf-native-hidden')).toBeNull();
    for (const block of blocksOf(section)) expect(block.getAttribute('data-clf-native-hidden')).toBeNull();
  });

  it('replaces a recorded ChatGPT-native web row while leaving connector attribution separate', async () => {
    const nativeActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId, agent: null },
          { seq: 2, time: 200, kind: 'page_tool', turnId, agent: null, label: 'Searched the web', messageId: 'native-web' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: nativeActivity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, ['Searched the web']);
    await bindFiberTurns([{ section, turn: {
      turnId,
      activities: [{ messageId: 'native-web', label: 'Searched the web' }]
    } }]);

    live.hook.renderStreams();

    expect(section.querySelector('.clf-stream-page_tool')?.textContent).toContain('Searched the web');
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(blocksOf(section)[0]!.getAttribute('data-clf-native-hidden')).toBeNull();
  });

  it('keeps a settled turn app-owned and renders its final assistant message from the app feed', async () => {
    const settledActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId, agent: 'prime' },
          { seq: 2, time: 200, kind: 'progress', turnId, agent: 'prime', text: 'Checking the repository' },
          {
            seq: 3,
            time: 300,
            kind: 'tool_call',
            turnId,
            agent: 'prime',
            tool: 'read_file',
            callId: 'call-second',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read second.ts' }
          },
          { seq: 4, time: 400, kind: 'assistant_message', turnId, agent: 'prime', messageId: 'site-settled-answer', text: 'Here is the answer.', final: true },
          { seq: 5, time: 500, kind: 'turn_end', turnId, agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: settledActivity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, ['Called tool!']);
    const reasoning = live.document.createElement('div');
    reasoning.setAttribute('data-interrupted', 'false');
    reasoning.textContent = 'Checking the repository';
    const prose = live.document.createElement('div');
    prose.className = 'markdown';
    prose.textContent = 'Here is the answer.';
    section.append(reasoning, prose);

    await bindFiberTurns([{ section, turn: {
      turnId,
      messages: [{ messageId: 'site-settled-answer', stable: true, rawText: 'Here is the answer.', renderedHtml: '' }]
    } }]);
    live.hook.renderStreams();
    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(section.querySelector('.clf-stream-assistant_message')?.textContent).toContain('Here is the answer.');
    expect(section.querySelector('.clf-stream-turn_end')?.textContent).toContain('Turn completed');
    // React's original answer is deliberately still mounted underneath the replacement.
    expect(prose.textContent).toBe('Here is the answer.');
  });

  it('aligns durable app turns to visible assistant turns after a page reload even when DOM ids differ', async () => {
    const reloadedActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-recorded-1', agent: null },
          { seq: 2, time: 200, kind: 'assistant_message', turnId: 'g-recorded-1', agent: null, messageId: 'site-reload-one', text: 'First answer', final: true },
          { seq: 3, time: 300, kind: 'turn_end', turnId: 'g-recorded-1', agent: null, outcome: 'completed', detail: '' },
          { seq: 4, time: 400, kind: 'turn_start', turnId: 'g-recorded-2', agent: null },
          { seq: 5, time: 500, kind: 'assistant_message', turnId: 'g-recorded-2', agent: null, messageId: 'site-reload-two', text: 'Second answer', final: true },
          { seq: 6, time: 600, kind: 'turn_end', turnId: 'g-recorded-2', agent: null, outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: reloadedActivity });
    renderingOn();
    const first = assistantTurn(live.document, 'request-reused-x', []);
    const second = assistantTurn(live.document, 'request-reused-y', []);
    await bindFiberTurns([
      { section: first, turn: { turnId: 'request-reused-x', messages: [{ messageId: 'site-reload-one', stable: true, rawText: 'First answer', renderedHtml: '' }] } },
      { section: second, turn: { turnId: 'request-reused-y', messages: [{ messageId: 'site-reload-two', stable: true, rawText: 'Second answer', renderedHtml: '' }] } }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(first.querySelector('.clf-stream-assistant_message')?.textContent).toContain('First answer');
    expect(second.querySelector('.clf-stream-assistant_message')?.textContent).toContain('Second answer');
    expect(first.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(second.getAttribute('data-clf-turn-replaced')).toBe('1');
  });

  it('uses stable website message ids when one MCP request id spans several durable turns', async () => {
    const sharedRequest = 'wfr-shared-across-local-turns';
    const splitActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-split-one', agent: 'prime' },
          {
            seq: 2,
            time: 110,
            kind: 'tool_call',
            turnId: 'g-split-one',
            agent: 'prime',
            tool: 'read_file',
            callId: 'split-one',
            requestId: sharedRequest,
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read first turn' }
          },
          { seq: 3, time: 120, kind: 'assistant_message', turnId: 'g-split-one', agent: 'prime', messageId: 'site-split-one', text: 'First answer', final: true },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-split-one', agent: 'prime', outcome: 'completed', detail: '' },
          {
            seq: 5,
            time: 140,
            kind: 'tool_call',
            turnId: null,
            agent: 'prime',
            tool: 'search_files',
            callId: 'split-orphan',
            requestId: sharedRequest,
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'search', tone: 'neutral', title: 'Searched between turns' }
          },
          { seq: 6, time: 200, kind: 'turn_start', turnId: 'g-split-two', agent: 'prime' },
          {
            seq: 7,
            time: 210,
            kind: 'tool_call',
            turnId: 'g-split-two',
            agent: 'prime',
            tool: 'read_file',
            callId: 'split-two',
            requestId: sharedRequest,
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read second turn' }
          },
          { seq: 8, time: 220, kind: 'assistant_message', turnId: 'g-split-two', agent: 'prime', messageId: 'site-split-two', text: 'Second answer', final: true },
          { seq: 9, time: 230, kind: 'turn_end', turnId: 'g-split-two', agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: splitActivity });
    renderingOn();
    const first = assistantTurn(live.document, 'page-split-one', []);
    const second = assistantTurn(live.document, 'page-split-two', []);
    await bindFiberTurns([
      {
        section: first,
        turn: {
          turnId: 'page-split-one',
          calls: [{ messageId: 'fiber-split-one', tool: 'read_file', order: 0, answered: true, requestId: sharedRequest }],
          messages: [{ messageId: 'site-split-one', stable: true, rawText: 'First answer', renderedHtml: '' }]
        }
      },
      {
        section: second,
        turn: {
          turnId: 'page-split-two',
          calls: [{ messageId: 'fiber-split-two', tool: 'read_file', order: 0, answered: true, requestId: sharedRequest }],
          messages: [{ messageId: 'site-split-two', stable: true, rawText: 'Second answer', renderedHtml: '' }]
        }
      }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(first.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(first.textContent).toContain('Read first turn');
    expect(first.textContent).toContain('Searched between turns');
    expect(first.textContent).not.toContain('Read second turn');
    expect(second.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(second.textContent).toContain('Read second turn');
    expect(second.textContent).not.toContain('Read first turn');
  });

  it('uses the preceding user message to reconstruct one response split across local lifecycle turns', async () => {
    const sharedRequest = 'wfr-shared-even-across-user-boundaries';
    const anchoredActivity = () => ({
      ok: true,
      data: {
        entries: [],
        userAnchors: [
          { seq: 1, time: 100, messageId: 'm-user-anchor-one' },
          { seq: 10, time: 1000, messageId: 'm-user-anchor-two' }
        ],
        stream: [
          { seq: 2, time: 110, kind: 'turn_start', turnId: 'g-anchor-one-a', agent: 'prime' },
          {
            seq: 3, time: 120, kind: 'tool_call', turnId: 'g-anchor-one-a', agent: 'prime',
            tool: 'read_file', callId: 'anchor-one-a', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read first response part' }
          },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-anchor-one-a', agent: 'prime', outcome: 'unknown', detail: '' },
          { seq: 5, time: 140, kind: 'turn_start', turnId: 'g-anchor-one-b', agent: 'prime' },
          {
            seq: 6, time: 150, kind: 'tool_call', turnId: 'g-anchor-one-b', agent: 'prime',
            tool: 'exec_command', callId: 'anchor-one-b', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'exec', tone: 'neutral', title: 'Ran second response part' }
          },
          { seq: 7, time: 160, kind: 'turn_end', turnId: 'g-anchor-one-b', agent: 'prime', outcome: 'unknown', detail: '' },
          { seq: 11, time: 1010, kind: 'turn_start', turnId: 'g-anchor-two', agent: 'prime' },
          {
            seq: 12, time: 1020, kind: 'tool_call', turnId: 'g-anchor-two', agent: 'prime',
            tool: 'read_file', callId: 'anchor-two', requestId: sharedRequest, outcome: 'ok', durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read next user response' }
          }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: anchoredActivity });
    renderingOn();
    userTurn(live.document, 'user-anchor-one', 'first question');
    const first = assistantTurn(live.document, 'page-anchor-one', []);
    userTurn(live.document, 'user-anchor-two', 'second question');
    const second = assistantTurn(live.document, 'page-anchor-two', []);
    await bindFiberTurns([
      {
        section: first,
        turn: {
          turnId: 'page-anchor-one',
          calls: [{ messageId: 'fiber-anchor-one', tool: 'exec_command', order: 0, answered: true, requestId: sharedRequest }]
        }
      },
      {
        section: second,
        turn: {
          turnId: 'page-anchor-two',
          calls: [{ messageId: 'fiber-anchor-two', tool: 'read_file', order: 0, answered: true, requestId: sharedRequest }]
        }
      }
    ]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(first.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(first.textContent).toContain('Read first response part');
    expect(first.textContent).toContain('Ran second response part');
    expect(first.textContent).toContain('prime');
    expect(first.textContent).not.toContain('Read next user response');
    expect(second.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(second.textContent).toContain('Read next user response');
    expect(second.textContent).not.toContain('Read first response part');
  });

  it('keeps an id-less assistant section native until Fiber proves the local replacement is complete', async () => {
    const anchoredActivity = () => ({
      ok: true,
      data: {
        entries: [],
        userAnchors: [{ seq: 1, time: 100, messageId: 'm-user-idless-anchor' }],
        stream: [
          { seq: 2, time: 110, kind: 'turn_start', turnId: 'g-idless-anchor', agent: 'prime' },
          {
            seq: 3,
            time: 120,
            kind: 'tool_call',
            turnId: 'g-idless-anchor',
            agent: 'prime',
            tool: 'read_file',
            callId: 'idless-anchor-call',
            outcome: 'ok',
            durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read anchored file' }
          },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-idless-anchor', agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: anchoredActivity });
    renderingOn();
    userTurn(live.document, 'user-idless-anchor', 'keep this user turn visible');
    const section = assistantTurn(live.document, 'temporary-page-id', []);
    section.removeAttribute('data-turn-id');
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(section.getAttribute('data-clf-turn-replaced')).toBeNull();
    expect(section.querySelector('.clf-stream')).toBeNull();
    expect(live.document.body.textContent).toContain('keep this user turn visible');
  });

  it('does not merge a genuine reissue after the same user message when its request id changed', async () => {
    const reissueActivity = () => ({
      ok: true,
      data: {
        entries: [],
        userAnchors: [
          { seq: 1, time: 100, messageId: 'm-user-reissue' },
          { seq: 20, time: 2000, messageId: 'm-user-after-reissue' }
        ],
        stream: [
          { seq: 2, time: 110, kind: 'turn_start', turnId: 'g-reissue-old', agent: 'prime' },
          {
            seq: 3, time: 120, kind: 'tool_call', turnId: 'g-reissue-old', agent: 'prime',
            tool: 'read_file', callId: 'reissue-old', requestId: 'wfr-old-response', outcome: 'ok', durationMs: 2,
            summary: { kind: 'read', tone: 'neutral', title: 'Read superseded response' }
          },
          { seq: 4, time: 130, kind: 'turn_end', turnId: 'g-reissue-old', agent: 'prime', outcome: 'unknown', detail: '' },
          { seq: 5, time: 140, kind: 'turn_start', turnId: 'g-reissue-current', agent: 'prime' },
          {
            seq: 6, time: 150, kind: 'tool_call', turnId: 'g-reissue-current', agent: 'prime',
            tool: 'exec_command', callId: 'reissue-current', requestId: 'wfr-current-response', outcome: 'ok', durationMs: 2,
            summary: { kind: 'exec', tone: 'neutral', title: 'Ran current response' }
          },
          { seq: 7, time: 160, kind: 'turn_end', turnId: 'g-reissue-current', agent: 'prime', outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: reissueActivity });
    renderingOn();
    userTurn(live.document, 'user-reissue', 'same user message');
    const section = assistantTurn(live.document, 'page-current-reissue', []);
    await bindFiberTurns([{
      section,
      turn: {
        turnId: 'page-current-reissue',
        calls: [{ messageId: 'fiber-current-reissue', tool: 'exec_command', order: 0, answered: true, requestId: 'wfr-current-response' }]
      }
    }]);
    await live.hook.pullActivity();
    live.hook.renderStreams();

    expect(section.getAttribute('data-clf-turn-replaced')).toBe('1');
    expect(section.textContent).toContain('Ran current response');
    expect(section.textContent).not.toContain('Read superseded response');
  });

  it('does not tail-align the previous recorded turn into a new assistant turn before its activity arrives', async () => {
    const previousActivity = () => ({
      ok: true,
      data: {
        entries: [],
        stream: [
          { seq: 1, time: 100, kind: 'turn_start', turnId: 'g-recorded-old', agent: null },
          { seq: 2, time: 200, kind: 'assistant_message', turnId: 'g-recorded-old', agent: null, messageId: 'site-old-answer', text: 'Previous answer', final: true },
          { seq: 3, time: 300, kind: 'turn_end', turnId: 'g-recorded-old', agent: null, outcome: 'completed', detail: '' }
        ],
        job: null
      }
    });
    live = await harness(undefined, { activity: previousActivity });
    renderingOn();

    // Reload recovery is by the stable website message id, never by list position.
    const previous = assistantTurn(live.document, 'request-old', []);
    await bindFiberTurns([{ section: previous, turn: {
      turnId: 'request-old',
      messages: [{ messageId: 'site-old-answer', stable: true, rawText: 'Previous answer', renderedHtml: '' }]
    } }]);
    live.hook.observe();
    live.hook.renderStreams();
    expect(previous.querySelector('.clf-stream-assistant_message')?.textContent).toContain('Previous answer');

    // The next user message and assistant section are on screen before /activity has had the
    // round trip needed to return this new turn_start. That gap must never make reload-only
    // tail alignment reinterpret the previous durable group as the new turn.
    userTurn(live.document, 'user-next', 'Next question');
    const next = assistantTurn(live.document, 'request-new', []);
    await bindFiberTurns([
      { section: previous, turn: { turnId: 'request-old', messages: [{ messageId: 'site-old-answer', stable: true, rawText: 'Previous answer', renderedHtml: '' }] } },
      { section: next, turn: { turnId: 'request-new', messages: [{ messageId: 'site-new-answer', stable: true, rawText: 'New answer beginning', renderedHtml: '' }] } }
    ]);
    live.hook.observe();
    live.hook.renderStreams();

    expect(previous.querySelector('.clf-stream-assistant_message')?.textContent).toContain('Previous answer');
    expect(next.querySelector('.clf-stream')).toBeNull();
    expect(next.textContent).not.toContain('Previous answer');
  });

  it('reattaches the same recorded stream after React replaces the assistant section', async () => {
    live = await harness(undefined, { activity });
    renderingOn();
    const first = assistantTurn(live.document, turnId, []);
    await bindFiberRequest(first, 'wfr-app-stream');
    live.hook.renderStreams();
    expect(first.querySelector('.clf-stream')).not.toBeNull();

    first.remove();
    const replacement = assistantTurn(live.document, turnId, []);
    replacement.setAttribute('data-clf-fiber-turn', '0');
    live.hook.renderStreams();

    expect(replacement.querySelectorAll('.clf-stream')).toHaveLength(1);
    expect(replacement.textContent).toContain('Read second.ts');
    expect(replacement.textContent).toContain('Read third.ts');
  });
});

describe('where the page stream puts an event that was recorded late', () => {
  /** The same shape `src/shared/chronology.ts` is pinned against, run through content.js. */
  const row = (seq: number, time: number, kind: string, turnId: string | null) => ({ seq, time, kind, turnId });

  it('reads a turn in the order it happened, not the order it was appended', async () => {
    live = await harness();
    const read = live.hook
      .chronological([
        row(1, 100, 'turn_start', 't1'),
        row(2, 110, 'progress', 't1'),
        row(3, 150, 'progress', 't1'),
        row(4, 120, 'tool_call', 't1'),
        row(5, 160, 'assistant_message', 't1'),
        row(6, 170, 'turn_end', 't1')
      ])
      .map((entry) => entry.seq);
    expect(read).toEqual([1, 2, 4, 3, 5, 6]);
  });

  it('agrees with the desktop transcript exactly', async () => {
    // Two copies of one contract. If they ever drift, the app and the page disagree about
    // what the user's own session says, and there is no way to tell which one is lying.
    live = await harness();
    const window = [
      row(1, 100, 'turn_start', 't1'),
      row(2, 110, 'progress', 't1'),
      row(3, 150, 'progress', 't1'),
      row(4, 120, 'tool_call', 't1'),
      row(5, 160, 'assistant_message', 't1'),
      row(6, 170, 'turn_end', 't1'),
      row(7, 200, 'user_message', null),
      row(8, 210, 'turn_start', 't2'),
      row(9, 130, 'tool_call', 't1'),
      row(10, 90, 'assistant_message', 'page-turn-old')
    ];
    expect(live.hook.chronological(window).map((entry) => entry.seq)).toEqual(
      chronological(window).map((entry) => entry.seq)
    );
  });

  it('gives a delayed call back to the turn that made it after the next turn has opened', async () => {
    live = await harness();
    const groups = live.hook.streamTurnGroups(
      live.hook.chronological([
        row(1, 100, 'turn_start', 'g-one'),
        row(2, 160, 'assistant_message', 'g-one'),
        row(3, 170, 'turn_end', 'g-one'),
        row(4, 210, 'turn_start', 'g-two'),
        row(5, 120, 'tool_call', 'g-one'),
        row(6, 260, 'assistant_message', 'g-two')
      ])
    );

    expect(groups.map((group) => group.id)).toEqual(['g-one', 'g-two']);
    expect(groups[0]!.entries.map((entry) => entry.seq)).toEqual([1, 5, 2, 3]);
    expect(groups[1]!.entries.map((entry) => entry.seq)).toEqual([4, 6]);
  });

  it('refuses a historical answer replayed under a page id into the open turn', async () => {
    // Reload backfill re-reports what the page can see, under ChatGPT's own recycled request
    // ids. Placed by position it lands mid-turn in the live generation; it belongs to no
    // local turn, so it belongs to no group.
    live = await harness();
    const groups = live.hook.streamTurnGroups(
      live.hook.chronological([
        row(1, 100, 'turn_start', 'g-new'),
        row(2, 110, 'progress', 'g-new'),
        row(3, 115, 'assistant_message', 'request-old'),
        row(4, 120, 'tool_call', null),
        row(5, 160, 'assistant_message', 'g-new'),
        row(6, 170, 'turn_end', 'g-new')
      ])
    );

    expect(groups).toHaveLength(1);
    // The unowned tool has no request id, so the renderer no longer guesses a turn for it
    // from time/position alone. Only the locally owned rows remain in the durable group.
    expect(groups[0]!.entries.map((entry) => entry.seq)).toEqual([1, 2, 5, 6]);
  });

  it('moves a late arrival into its slot instead of appending it to the feed', async () => {
    // The incremental case end to end: the cursor delivers the call alone, long after its
    // turn_start, and the page rebuilds the whole window it holds rather than trusting the
    // order the response arrived in.
    const turnId = 'g-late';
    // Flipped explicitly rather than counted: the harness pulls once on boot, so a counter
    // would deliver the late row before the test had asked for it.
    let late = false;
    const activity = () => ({
        ok: true,
        data: {
          entries: [],
          stream: !late
              ? [
                  { seq: 1, time: 100, kind: 'turn_start', turnId, agent: null },
                  { seq: 2, time: 110, kind: 'progress', turnId, agent: null, text: 'Checking the repository' },
                  { seq: 3, time: 150, kind: 'progress', turnId, agent: null, text: 'Writing it up' },
                  { seq: 4, time: 170, kind: 'assistant_message', turnId, agent: null, messageId: 'site-late-anchor', text: 'Final answer', final: true }
                ]
              : [
                  {
                    seq: 500,
                    time: 120,
                    kind: 'tool_call',
                    turnId,
                    agent: null,
                    tool: 'read_file',
                    callId: 'call-late',
                    outcome: 'ok',
                    durationMs: 3,
                    summary: { kind: 'read', tone: 'neutral', title: 'Read second.ts' }
                  }
                ],
          job: null
        }
      });

    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    await bindFiberTurns([{ section, turn: {
      turnId,
      messages: [{ messageId: 'site-late-anchor', stable: true, rawText: 'Final answer', renderedHtml: '' }]
    } }]);

    await live.hook.pullActivity();
    live.hook.renderStreams();
    const before = [...section.querySelectorAll('.clf-stream-row .clf-stream-text')].map((node) =>
      (node.textContent || '').trim()
    );
    expect(before).toEqual(['Turn started', 'Checking the repository', 'Writing it up', 'Final answer']);

    late = true;
    await live.hook.pullActivity();
    live.hook.renderStreams();
    const after = [...section.querySelectorAll('.clf-stream-row .clf-stream-text')].map((node) =>
      (node.textContent || '').trim()
    );
    expect(after).toEqual(['Turn started', 'Checking the repository', 'Read second.ts', 'Writing it up', 'Final answer']);
  });

  it.skip('keeps a superseded caption to one row after the reorder', async () => {
    const turnId = 'g-supersede';
    let pull = 0;
    const activity = () => {
      pull++;
      return {
        ok: true,
        data: {
          entries: [],
          stream: [
            { seq: 1, time: 100, kind: 'turn_start', turnId, agent: null },
            {
              seq: 2,
              time: 110,
              kind: 'progress',
              turnId,
              agent: null,
              progressId: 'p1',
              text: pull === 1 ? 'Inspecting files' : 'Inspected files'
            }
          ],
          job: null
        }
      };
    };

    live = await harness(undefined, { activity });
    renderingOn();
    const section = assistantTurn(live.document, turnId, []);
    goLive();

    await live.hook.pullActivity();
    await live.hook.pullActivity();
    live.hook.renderStreams();

    const rows = [...section.querySelectorAll('.clf-stream-row .clf-stream-text')].map((node) =>
      (node.textContent || '').trim()
    );
    expect(rows).toEqual(['Turn started', 'Inspected files']);
  });
});

describe('navigating from one chat to another', () => {
  const CHAT_B = 'https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

  it('does not file the old chat’s still-rendered messages into the new conversation', async () => {
    live = await harness();
    userTurn(live.document, 'turn-a1', 'the first chat’s question');
    assistantTurn(live.document, 'turn-a2', []);
    live.hook.observe();
    await settle();

    const before = emitted(live.sent, 'user_message');
    expect(before.map((entry) => entry.event.text)).toEqual(['the first chat’s question']);
    expect(before[0]!.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    // The URL moves first and React has not replaced anything yet: chat A's transcript is
    // still the DOM. This is the ordering that used to re-emit every visible message under
    // B's id, because resetConversation() had just cleared the seen-message set.
    live.dom.reconfigure({ url: CHAT_B });
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'user_message')).toHaveLength(1);
    expect(live.sent.filter((message) => message.type === 'closed')).toHaveLength(1);
  });

  it('records the new chat’s own messages once its DOM actually arrives', async () => {
    live = await harness();
    userTurn(live.document, 'turn-a1', 'the first chat’s question');
    live.hook.observe();
    await settle();

    live.dom.reconfigure({ url: CHAT_B });
    live.hook.observe();
    await settle();

    // React catches up: A's section goes, B's arrives.
    live.document.querySelector('[data-turn-id="turn-a1"]')!.remove();
    userTurn(live.document, 'turn-b1', 'the second chat’s question');
    live.hook.observe();
    await settle();

    const messages = emitted(live.sent, 'user_message');
    expect(messages.map((entry) => entry.event.text)).toEqual([
      'the first chat’s question',
      'the second chat’s question'
    ]);
    expect(messages[1]!.conversationId).toBe('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  });

  /**
   * The opposite ordering must not regress. If React replaces the transcript before the
   * URL changes, none of the visible sections were ever watched under the old chat, so
   * there is nothing to retire — and the new chat's opening message, which is the one
   * thing this pipeline exists to keep, is recorded normally.
   */
  it('keeps the new chat’s opening message when the DOM is replaced before the URL changes', async () => {
    live = await harness();
    userTurn(live.document, 'turn-a1', 'the first chat’s question');
    live.hook.observe();
    await settle();

    live.document.querySelector('[data-turn-id="turn-a1"]')!.remove();
    userTurn(live.document, 'turn-b1', 'the second chat’s question');
    live.dom.reconfigure({ url: CHAT_B });
    live.hook.observe();
    await settle();

    const messages = emitted(live.sent, 'user_message');
    expect(messages.map((entry) => entry.event.text)).toEqual([
      'the first chat’s question',
      'the second chat’s question'
    ]);
    expect(messages[1]!.conversationId).toBe('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  });

  /**
   * `resetConversation()` clears state, but a request already in flight is not state. The
   * reply lands afterwards and used to be applied to whatever chat was current by then.
   */
  it('throws away an activity reply that was requested for the chat it has left', async () => {
    let release: (() => void) | null = null;
    live = await harness('https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      activity: (message) => {
        if (message.conversationId !== 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') {
          return { ok: true, data: { entries: [], job: null } };
        }
        // Chat A's reply, held open until the tab has already moved to chat B.
        return new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: {
                entries: [call({ turnId: 'turn-a1', seq: 1, summary: { kind: 'read', tone: 'neutral', title: 'Read from chat A' } })],
                job: { busy: true, stage: 'opening', error: null },
                bootstrap: 'resume'
              }
            });
        });
      }
    });
    const section = assistantTurn(live.document, 'turn-a1', ['Called tool!']);

    const pull = live.hook.pullActivity();
    await settle();
    expect(release).not.toBeNull();

    // The tab moves while chat A's reply is still outstanding.
    live.dom.reconfigure({ url: CHAT_B });
    live.hook.observe();
    await settle();

    release!();
    await pull;
    await settle();

    // Nothing from chat A may reach chat B: not its labels on the rows still on screen,
    // not its resume job, not its compaction state, not its bootstrap fold.
    expect(labels(section)).toEqual(['Called tool']);
    expect(
      live.hook.controlState({
        job: null,
        connected: true,
        conversationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        pressedAt: 0,
        error: '',
        now: Date.now()
      }).label
    ).toBe('Compact & resume');
  });
});

/**
 * What a turn's outcome is allowed to rest on.
 *
 * `turn_end` is not decoration: compaction and the resume handoff read it to decide
 * whether the last turn's work still needs doing. A turn recorded as `completed` when it
 * produced nothing is worse than no record at all, because it is believed.
 */
describe('generation identity while ChatGPT mounts and reorders assistant sections', () => {
  it.skip('waits for the new section instead of reusing the previous turn when STOP appears first', async () => {
    live = await harness();
    const old = assistantTurn(live.document, 'turn-old', []);
    live.hook.observe();
    await settle();

    // Global generation state changes first. The only assistant section is still history.
    //
    // The turn is announced straight away, and it is announced under an id this script
    // minted. Both halves are deliberate. Waiting for a ChatGPT turn id meant a generation
    // whose section had not mounted yet was never announced at all — and the app places a
    // tool call by asking which conversation is mid-turn, so the turns that call tools
    // fastest were exactly the ones it could not place. Minting the id locally is what
    // makes it mean one generation: the page reuses `data-turn-id` turn after turn.
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    const starts = emitted(live.sent, 'turn_start');
    expect(starts).toHaveLength(1);
    const generation = starts[0]!.event.turnId as string;
    expect(generation).toMatch(/^g-[a-z0-9]+-\d+-\d+$/);

    // What is still withheld is the *binding*: no section has been claimed for this
    // generation yet, so nothing on the page has been reported as its work.
    expect(emitted(live.sent, 'progress')).toHaveLength(0);

    // React catches up with the actual new assistant section and its visible update.
    const fresh = assistantTurn(live.document, 'turn-new', []);
    const progress = live.document.createElement('div');
    progress.setAttribute('data-interrupted', 'false');
    progress.textContent = 'new turn progress';
    fresh.append(progress);
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId)).toEqual([generation]);
    expect(emitted(live.sent, 'progress').map((entry) => [entry.event.turnId, entry.event.text])).toEqual([
      [generation, 'new turn progress']
    ]);

    // The old section becomes last in DOM order later. Progress must stay pinned to the
    // generation we already opened rather than following "whatever assistant is last".
    const misleading = live.document.createElement('div');
    misleading.setAttribute('data-interrupted', 'false');
    misleading.textContent = 'old misleading progress';
    old.append(misleading);
    live.document.querySelector('#thread')!.append(old);
    progress.textContent = 'new turn progress updated';
    live.hook.observe();
    await settle();

    // The whole current text of that commentary item, not the difference since last time:
    // it is reported under the same id, so the app updates the line it already has.
    expect(emitted(live.sent, 'progress').map((entry) => [entry.event.turnId, entry.event.text])).toEqual([
      [generation, 'new turn progress'],
      [generation, 'new turn progress updated']
    ]);
    const ids = new Set(emitted(live.sent, 'progress').map((entry) => entry.event.progressId));
    expect(ids.size).toBe(1);
  });

  /**
   * ChatGPT writes the new turn's commentary into a section that was already on screen.
   *
   * Binding is by evidence: a section that was there before the generation began only
   * becomes this generation's if the page has written into it since. What counts as
   * "written into" is the whole question. The signature used to be the final `.markdown`
   * prose plus a count of tool rows, and visible commentary is neither — it lives in the
   * outermost `[data-interrupted]` roots. So a turn that opened with commentary and had
   * not yet produced prose or called anything changed nothing the signature could see, the
   * generation stayed unbound, and every caption the user watched was lost.
   */
  it.skip('binds a generation to a section it has only written commentary into', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-existing', []);
    const settled = live.document.createElement('div');
    settled.className = 'markdown';
    settled.textContent = 'the answer this section already held';
    section.append(settled);

    // The baseline: at the end of this tick the section is history.
    live.hook.observe();
    await settle();

    startGenerating(live.document);
    const commentary = live.document.createElement('div');
    commentary.setAttribute('data-interrupted', 'false');
    commentary.textContent = 'Looking through the log';
    section.append(commentary);
    live.hook.observe();
    await settle();

    const starts = emitted(live.sent, 'turn_start');
    expect(starts).toHaveLength(1);
    const generation = starts[0]!.event.turnId as string;
    expect(emitted(live.sent, 'progress').map((entry) => [entry.event.turnId, entry.event.text])).toEqual([
      [generation, 'Looking through the log']
    ]);
  });

  /**
   * The other half of the same rule, and the reason it cannot simply read `textContent`.
   *
   * This extension rewrites the visible label of a tool row itself. If that rewrite counted
   * as the page having written into the section, our own relabel would be the evidence that
   * binds a stale section to the new generation — and every row already in it would then be
   * reported as this turn's activity. The signature is taken from page-authored content
   * only: our surfaces are stripped and the tool rows are removed before the text is read,
   * so what a row is *called* cannot move a generation.
   */
  it('does not bind a generation to a section merely because this app renamed a row in it', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-relabelled', ['Searched the web']);
    const settled = live.document.createElement('div');
    settled.className = 'markdown';
    settled.textContent = 'the answer this section already held';
    section.append(settled);

    live.hook.observe();
    await settle();

    startGenerating(live.document);
    // Exactly what paint() does to a row it can name: the label text is replaced in place.
    const label = section.querySelector('.text-start') as HTMLElement;
    label.textContent = 'read_file';
    label.classList.add('clf-tool-title');
    live.hook.observe();
    await settle();

    // The generation opened — that is unconditional and deliberate — but it claimed no
    // section, so nothing already in this one was filed as its work.
    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    expect(emitted(live.sent, 'page_tool')).toHaveLength(0);
    expect(emitted(live.sent, 'progress')).toHaveLength(0);
  });

  it.skip('never records the extension-owned stream back as new ChatGPT progress', async () => {
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-loop', []);
    const reasoning = live.document.createElement('div');
    reasoning.setAttribute('data-interrupted', 'false');
    reasoning.textContent = 'Native progress';
    turn.append(reasoning);

    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'progress').map((entry) => entry.event.text)).toEqual(['Native progress']);

    const synthetic = live.document.createElement('div');
    synthetic.className = 'clf-stream';
    synthetic.textContent = 'Native progress Synthetic copy Synthetic copy';
    reasoning.append(synthetic);
    live.hook.observe();
    await settle();

    // Adding our own renderer must not look like the page emitted another update.
    expect(emitted(live.sent, 'progress').map((entry) => entry.event.text)).toEqual(['Native progress']);
  });

  /**
   * What the app is left holding: the newest text of each commentary item, in the order
   * the items were first seen.
   *
   * This is the fold the recorder and every reader apply. Asserting on it rather than on
   * the raw emissions is the point of the whole redesign — the wire carries a snapshot
   * per redraw so a live reader can watch a line being written, and the question that
   * actually matters is how many *rows* those snapshots collapse to.
   */
  const commentaryRows = (sent: Array<Record<string, any>>): string[] => {
    const byId = new Map<string, string>();
    for (const entry of emitted(sent, 'progress')) byId.set(entry.event.progressId, entry.event.text);
    return [...byId.values()];
  };

  /**
   * The live corruption this whole redesign was reported for, byte for byte.
   *
   * Recorded as `seq15` of a real session: the streaming buffer and the rendered copy of
   * the same sentence, run together on **one line with no newline between them**. Every
   * deduper that compares whole lines — the one this replaced, and the recorder's union
   * check — sees a single unfamiliar string and stores it as authored commentary. The
   * user then reads their own assistant saying half a sentence twice.
   *
   * What is kept is the *second* copy, because the buffer is always the shorter, earlier
   * half, and it is kept as the page wrote it rather than rebuilt.
   */
  it.skip('records only the authored copy of a line the page double-wrote without a newline', async () => {
    const corrupted =
      'Yep bro, **that screenshot basically confirmsYep bro, that screenshot basically confirms the gate theory';
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-echo', []);
    const box = live.document.createElement('div');
    box.setAttribute('data-interrupted', 'false');
    box.textContent = corrupted;
    turn.append(box);

    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'progress').map((entry) => entry.event.text)).toEqual([
      'Yep bro, that screenshot basically confirms the gate theory'
    ]);
  });

  /**
   * The same artefact, but the page got several passes in rather than two.
   *
   * Recorded live as `seq25`-`seq29` of session `2026-08-17-da2de453`: the container held the
   * paragraph it was replacing alongside the replacement on every tick, so one interim message
   * arrived as a chain of ever-longer prefixes of itself, run together on one line. Only an
   * exact `A + A` was recognised before, and no link of that chain is one, so the whole thing
   * was stored — and the user read their assistant restarting the same sentence four times.
   */
  it.skip('records only the last pass of a line the page wrote over itself several times', async () => {
    const first = '**Schritt 3 erled';
    const second = 'Schritt 3 erledigt: Die ersten 15 Zeilen';
    const third = 'Schritt 3 erledigt: Die ersten 15 Zeilen von TODO.md zeigen die aktive Worklist. Dort';
    const fourth =
      'Schritt 3 erledigt: Die ersten 15 Zeilen von TODO.md zeigen die aktive Worklist. Dort steht, ' +
      'dass dies die einzige aktive Work Queue sein soll.';

    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-echo-chain', []);
    const box = live.document.createElement('div');
    box.setAttribute('data-interrupted', 'false');
    box.textContent = `${first}${second}${third}${fourth}`;
    turn.append(box);

    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'progress').map((entry) => entry.event.text)).toEqual([fourth]);
  });

  it.skip('collapses the live short-prefix chain that produced I’veI’ve gotI’ve got…', async () => {
    const first = 'I’ve';
    const second = 'I’ve got';
    const third = 'I’ve got the two durability questions';
    const fourth = 'I’ve got the two durability questions from prime. They matter because they point at the same root cause.';

    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-short-echo-chain', []);
    const box = live.document.createElement('div');
    box.setAttribute('data-interrupted', 'false');
    box.textContent = `${first}${second}${third}${fourth}`;
    turn.append(box);

    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'progress').map((entry) => entry.event.text)).toEqual([fourth]);
  });

  /**
   * And the invariant that keeps the collapse above from eating real prose.
   *
   * A repeated opening is only a double-write if it is long. Commentary legitimately
   * restates a short phrase — "Reading the log. Reading the log for the second failure" is
   * a sentence, not a rendering artefact — and a collapse that swallowed it would delete
   * text the user actually saw, which is worse than the duplication it is fixing.
   */
  it.skip('leaves a short repeated opening alone, because prose really does repeat itself', async () => {
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-repeat', []);
    const box = live.document.createElement('div');
    box.setAttribute('data-interrupted', 'false');
    box.textContent = 'Reading it. Reading it again, properly this time.';
    turn.append(box);

    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'progress').map((entry) => entry.event.text)).toEqual([
      'Reading it. Reading it again, properly this time.'
    ]);
  });

  it.skip('promotes a progress prefix into the settled final instead of rendering both', async () => {
    live = await harness();
    const rendered = live.hook.visibleStream(
      [
        {
          seq: 2,
          time: 100,
          kind: 'progress',
          turnId: 'g-worker',
          progressId: 'g-worker#p0',
          text: 'Inspection finished, no files modified. The ranked'
        },
        {
          seq: 20,
          time: 2_000,
          kind: 'assistant_message',
          turnId: 'g-worker',
          final: true,
          text: 'Inspection finished, no files modified. The ranked critique was sent to prime.'
        }
      ],
      'g-worker'
    );

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.kind).toBe('assistant_message');
    expect(rendered[0]?.text).toBe('Inspection finished, no files modified. The ranked critique was sent to prime.');
  });

  it.skip('records a commentary line once however many times the page redraws it', async () => {
    // ChatGPT re-lays-out its reasoning block mid-turn: a second container appears holding
    // the newest caption, and reading whichever came last made the visible text shrink.
    // A shrink is not a prefix of what came before, so the old delta logic could only report
    // it as new — which is how "Monitoring…" printed twice and "Inspected changes…" three
    // times. Now each container keeps an identity across the redraw and reports its whole
    // current text under it, so a redraw updates a row instead of adding one.
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-dupe', []);
    const outer = live.document.createElement('div');
    outer.setAttribute('data-interrupted', 'false');
    outer.textContent = 'Monitoring the review';
    turn.append(outer);

    live.hook.observe();
    await settle();

    outer.textContent = 'Monitoring the review\nInspected the changes';
    live.hook.observe();
    await settle();

    // The page now grows a second container carrying only the newest caption.
    const inner = live.document.createElement('div');
    inner.setAttribute('data-interrupted', 'false');
    inner.textContent = 'Inspected the changes';
    turn.append(inner);
    live.hook.observe();
    await settle();

    // And redraws it again, in a different arrangement.
    outer.textContent = 'Monitoring the review';
    inner.textContent = 'Inspected the changes\nWrote the summary';
    live.hook.observe();
    await settle();

    // Two containers on the page, so two rows — never one row per redraw.
    expect(commentaryRows(live.sent)).toEqual([
      'Monitoring the review',
      'Inspected the changes\nWrote the summary'
    ]);
  });

  it.skip('keeps one row when the page reparents, shrinks, grows and redraws the same caption', async () => {
    // The exact sequence from the recorded blocker: the container survives every one of
    // these, so all of it has to land on a single logical row.
    live = await harness();
    startGenerating(live.document);
    const turn = assistantTurn(live.document, 'turn-redraw', []);
    const wrapper = live.document.createElement('div');
    turn.append(wrapper);
    const box = live.document.createElement('div');
    box.setAttribute('data-interrupted', 'false');
    box.textContent = 'Reading the recorder';
    wrapper.append(box);

    live.hook.observe();
    await settle();

    // Reparented into a different ancestor by a React re-layout.
    const moved = live.document.createElement('div');
    turn.append(moved);
    moved.append(box);
    box.textContent = 'Reading the recorder\nChecking attribution';
    live.hook.observe();
    await settle();

    // Shrunk — not a prefix of what came before, which is what used to force a new row.
    box.textContent = 'Checking attribution';
    live.hook.observe();
    await settle();

    // Grown again, then redrawn with identical text.
    box.textContent = 'Checking attribution\nWriting the fix';
    live.hook.observe();
    await settle();
    box.textContent = 'Checking attribution\nWriting the fix';
    live.hook.observe();
    await settle();

    expect(commentaryRows(live.sent)).toEqual(['Checking attribution\nWriting the fix']);
    // An unchanged redraw is not an update, so it is never sent at all.
    expect(emitted(live.sent, 'progress')).toHaveLength(4);
  });
});

/**
 * The stop button is not a continuous signal.
 *
 * Every case here is taken from session `2026-08-17-d1354db2`, where the observer read a
 * missing stop button as a finished turn and split single assistant runs into two and three
 * generations: `turn_start` at seq 342 and `turn_end` 432 ms later with `outcome: "unknown"`,
 * the run reopening at 347; the same shape at 357/358/360 across a 2.7 s gap; again at
 * 249/251. `unknown` is what nothing-actually-ended looks like — no answer, no error, no
 * stall. The damage lands in the app: `turn_end` clears the live turn and its pending
 * evidence, so 54 of that session's own connector calls graded `inferred` and went to
 * "Unattributed activity", the first of them 194 ms after the premature end.
 */
describe('a stop button that goes missing while the turn is still running', () => {
  const dropout = async (ticks: number): Promise<void> => {
    stopGenerating(live!.document);
    for (let tick = 0; tick < ticks; tick++) {
      live!.hook.observe();
      await settle();
    }
    startGenerating(live!.document);
    live!.hook.observe();
    await settle();
  };

  it('does not end the turn when the button vanishes for a single observation', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-flicker', []);
    live.hook.observe();
    await settle();

    await dropout(1);

    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  /**
   * The mutation-driven case, which is the one a counter of observations cannot catch.
   * watchTranscript() runs observe() from a MutationObserver microtask, and the rerender
   * that unmounts the stop button is itself a burst of transcript mutations — so the quiet
   * observations arrive back to back within the same millisecond. Only a clock can tell
   * that apart from four seconds of silence.
   */
  it('does not end the turn when many observations land inside the dropout', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-rerender', []);
    live.hook.observe();
    await settle();

    await dropout(12);

    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  it.skip('does not turn an unexplained stop-control dropout into an unknown turn end', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-tool-phase', []);
    live.hook.observe();
    await settle();

    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 3);
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
    expect(emitted(live.sent, 'turn_state').map((entry) => entry.event.active)).toEqual([false]);
  });

  it('ends an unexplained quiet generation when a new user message proves the next turn began', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-before-followup', []);
    live.hook.observe();
    await settle();

    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    userTurn(live.document, 'followup-user', 'one more thing');
    live.hook.observe();
    await settle();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('unknown');
  });

  it('splits two user turns even when the old stop disappears and the new stop appears between observations', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-before-fast-followup', []);
    live.hook.observe();
    await settle();
    const firstGeneration = emitted(live.sent, 'turn_start')[0]!.event.turnId;

    // No observer sees a quiet page: the previous run finishes, the follow-up is submitted,
    // and ChatGPT mounts the next stop control before the next tick. Stop-button-only state
    // therefore still says "generating" on both sides of the boundary.
    stopGenerating(live.document);
    userTurn(live.document, 'followup-between-ticks', 'also check this');
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-after-fast-followup', []);
    live.hook.observe();
    await settle();

    const starts = emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBe(firstGeneration);
    expect(starts[1]).not.toBe(firstGeneration);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe(firstGeneration);
    expect(ends[0]!.outcome).toBe('unknown');
  });

  it.skip('keeps the same generation for work that arrives after the button comes back', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-continues', ['Reading the recorder']);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    await dropout(3);

    // The row the model drew after the flicker, and the answer it settled on.
    section.append(toolBlock(live.document, 'Called tool!'));
    live.hook.observe();
    await settle();
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'Done — the recorder path is fixed.';
    section.append(answer);
    await settleTurn(live);

    expect(emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId)).toEqual([opened]);
    // Every piece of evidence from after the dropout is still this generation's, which is
    // exactly what the app needs to keep placing the calls it is making right now.
    expect(sightings(live.sent)).toEqual([{ turnId: 'turn-continues', count: 1 }]);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe(opened);
    expect(ends[0]!.outcome).toBe('completed');
    const answers = emitted(live.sent, 'assistant_message');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.event.turnId).toBe(opened);
  });

  it('keeps the turn open when connector UI appears while the stop control is absent', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-tool-dropout', []);
    live.hook.observe();
    await settle();

    stopGenerating(live.document);
    section.append(toolBlock(live.document, 'Called tool!'));
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  it('does not treat a transient interrupted marker during a stop dropout as a terminal turn', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-interrupted-tool-phase', []);
    const progress = live.document.createElement('div');
    progress.setAttribute('data-interrupted', 'true');
    progress.textContent = 'Inspecting the repository';
    section.append(progress);
    live.hook.observe();
    await settle();
    const opened = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;

    // This is the live 2026-08-19 failure shape: Stop vanishes and the reasoning container
    // says interrupted even though the same model turn is about to keep talking and calling
    // tools. Surviving the ordinary settle window must not publish a turn_end.
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);

    await replyFiber([], [{
      turnId: 'turn-interrupted-tool-phase',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: [{
        messageId: 'fiber-after-interrupted-marker',
        tool: 'read_file',
        order: 0,
        answered: false,
        requestId: 'wfr-after-interrupted-marker'
      }],
      messages: [{
        messageId: 'site-after-interrupted-marker',
        stable: true,
        rawText: 'Still working after the interrupted marker.',
        renderedHtml: '<p>Still working after the interrupted marker.</p>'
      }],
      activities: []
    }]);
    await live.hook.flush();
    await settle();

    expect(emitted(live.sent, 'assistant_message').at(-1)!.event.turnId).toBe(opened);
    expect(emitted(live.sent, 'tool_evidence').at(-1)!.event.turnId).toBe(opened);

    // The marker still carries the correct outcome once a separate, concrete terminal
    // boundary exists. A follow-up user message proves the previous turn has ended.
    userTurn(live.document, 'followup-after-interrupted', 'continue from there');
    live.hook.observe();
    await settle();
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe(opened);
    expect(ends[0]!.outcome).toBe('interrupted');
  });

  /**
   * The outcome is read when the button first goes, not when the turn finally closes.
   * A banner ChatGPT clears during the settle window would otherwise turn a failed turn
   * into an `unknown` one — the settle window must delay the verdict, never change it.
   */
  it('still records the failure a turn ended with, dismissed during the settle window', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-failed', []);
    live.hook.observe();
    await settle();

    const banner = alertBanner(live.document, 'Message delivery timed out. Please try again.');
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    banner.remove();
    live.advance(live.hook.TURN_SETTLE_MS);
    live.hook.observe();
    await settle();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('failed');
    expect(ends[0]!.detail).toBe('Message delivery timed out. Please try again.');
  });

  it('ends a genuinely finished turn exactly once', async () => {
    live = await harness();
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-done', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'All done.';
    section.append(answer);
    live.hook.observe();
    await settle();

    await settleTurn(live);
    // And the quiet page keeps being observed, as it is on a live tab.
    for (let tick = 0; tick < 5; tick++) {
      live.advance(live.hook.TURN_SETTLE_MS);
      live.hook.observe();
      await settle();
    }

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('completed');
  });

  it('closes from Fiber end_turn once even when ChatGPT leaves the Stop button stuck', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-fiber-ended', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'turn-fiber-ended',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      endMessageId: 'site-final-ended',
      calls: [],
      messages: [{
        messageId: 'site-final-ended',
        stable: true,
        rawText: 'Finished from the page model.',
        renderedHtml: '<p>Finished from the page model.</p>'
      }],
      activities: []
    }]);
    await settle();
    await live.hook.flush();
    await settle();

    // Stop is intentionally still mounted. Repeated observations must not reopen the same
    // terminal website turn as fresh local generations.
    for (let tick = 0; tick < 4; tick++) {
      live.hook.observe();
      await settle();
    }
    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    const ended = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('completed');

    // A real new user message is concrete next-turn evidence and releases the terminal latch
    // even if the stale Stop control has still not disappeared.
    userTurn(live.document, 'after-fiber-ended', 'next question');
    assistantTurn(live.document, 'turn-after-fiber-ended', []);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_start')).toHaveLength(2);
  });

  it('releases the stale-Stop terminal latch when Fiber shows a newer retry attempt', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-fiber-retry', []);
    live.hook.observe();
    await settle();

    await replyFiber([], [{
      turnId: 'turn-fiber-retry',
      endMessageId: 'site-old-final',
      calls: [],
      messages: [{ messageId: 'site-old-final', stable: true, rawText: 'Old final.', renderedHtml: '' }],
      activities: []
    }]);
    await settle();
    await live.hook.flush();
    expect(emitted(live.sent, 'turn_start')).toHaveLength(1);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(1);

    // Stop is still mounted, but the current website turn now has a newer active public
    // message and therefore no endMessageId. The terminal probe must release the old latch.
    await replyFiber([], [{
      turnId: 'turn-fiber-retry',
      endMessageId: null,
      calls: [],
      messages: [{ messageId: 'site-retry-active', stable: true, rawText: 'Trying again.', renderedHtml: '' }],
      activities: []
    }], { pageTurnId: 'turn-fiber-retry', terminalProbe: 'site-old-final' });
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_start')).toHaveLength(2);
  });

  it('treats fresh app activity for the exact local turn as liveness evidence', async () => {
    let stream: any[] = [];
    live = await harness(undefined, {
      activity: () => ({ ok: true, data: { entries: [], stream, nextSince: 0, pendingTools: 0 } })
    });
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-live-tooling', []);
    live.hook.observe();
    await settle();
    const local = emitted(live.sent, 'turn_start')[0]!.event.turnId;

    live.advance(live.hook.STALL_MS + 1);
    stream = [{ seq: 100, time: Date.now(), kind: 'tool_call', turnId: local, callId: 'live-call', tool: 'read', outcome: 'ok' }];
    await live.hook.pullActivity();
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'chat_error').map((entry) => entry.event.text)).not.toContain(
      'No visible progress for ten minutes. The turn is still marked as generating.'
    );
  });

  it('does not let historical activity keep an unrelated live turn from stalling', async () => {
    let stream: any[] = [];
    live = await harness(undefined, {
      activity: () => ({ ok: true, data: { entries: [], stream, nextSince: 0, pendingTools: 0 } })
    });
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-live-no-progress', []);
    live.hook.observe();
    await settle();

    live.advance(live.hook.STALL_MS + 1);
    stream = [{ seq: 101, time: Date.now(), kind: 'tool_call', turnId: 'some-old-turn', callId: 'old-call', tool: 'read', outcome: 'ok' }];
    await live.hook.pullActivity();
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'chat_error').map((entry) => entry.event.text)).toContain(
      'No visible progress for ten minutes. The turn is still marked as generating.'
    );
  });

  /**
   * The user pressing stop is not a signal that needs corroborating, and a composer that
   * stays disabled for four more seconds because the app is being careful is its own bug.
   */
  it('closes at once when the user stopped the turn', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-stopped', ['partial answer before stop']);
    live.hook.observe();
    await settle();

    const stop = live.document.querySelector('[data-testid="stop-button"]')!;
    stop.dispatchEvent(new live.window.MouseEvent('click', { bubbles: true }));
    stopGenerating(live.document);
    live.hook.observe();
    await settle();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('stopped');
    // Visible partial prose is not a completed answer. If this were final:true and the
    // explicit turn_end got lost on reload, recorder recovery would upgrade the stopped
    // turn to completed.
    expect(emitted(live.sent, 'assistant_message').filter((entry) => entry.event.final === true)).toHaveLength(0);
  });

  /**
   * The tool phase is the dropout: ChatGPT unmounts the stop button while it waits on a
   * connector result, and the result cannot come back after the turn that asked for it
   * ended. A call still in flight therefore holds the window open past its own length.
   */
  it('holds the turn open while a local tool call is still running', async () => {
    live = await harness('https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      activity: () => ({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 1 } })
    });
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-tooling', []);
    live.hook.observe();
    await settle();
    await live.hook.pullActivity();
    await settle();

    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 2);
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);

    // The call comes back, but that fact alone is not proof the assistant turn ended. A
    // connector phase can finish while ChatGPT is still preparing the next step, so the
    // unknown quiet turn stays open until final/error/stop/new-user evidence appears.
    live.reply.set('activity', () => ({
      ok: true,
      data: { entries: [], stream: [], nextSince: 0, pendingTools: 0 }
    }));
    await live.hook.pullActivity();
    await settle();
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
  });

  it('does not let process-global pendingTools hold a browser turn that has actually completed', async () => {
    live = await harness('https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      activity: () => ({ ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools: 1 } })
    });
    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-complete-with-foreign-pending', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'This turn is done.';
    section.append(answer);
    live.hook.observe();
    await settle();
    await live.hook.pullActivity();
    await settle();

    // `pendingTools` is app-wide and may belong to another chat. It remains useful to the
    // compaction stop-and-settle path, but ordinary turn lifecycle must use this page's own
    // evidence and close normally.
    await settleTurn(live);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe('completed');
  });
});

/**
 * Reloading a ChatGPT page in the middle of an assistant turn.
 *
 * The content script dies with the document, `RUN_ID` included — and `RUN_ID` is what makes
 * a generation id unique, so the new document cannot reconstruct the id the old one was
 * using. Session `2026-08-17-d1354db2` shows the result at seq 367/368: the app records
 * "the ChatGPT page detached while generating", and the reloaded page immediately opens
 * `g-1cbg9tk1s87kta-2-3` for a run that was already in flight. One assistant run, two
 * generations, and the app's live-turn evidence reset underneath the calls still running.
 *
 * The app holds the durable half of that identity, so the page asks for it before it
 * observes anything.
 */
describe('a content script reloaded into a turn already in flight', () => {
  const activity = (data: Record<string, unknown>) => ({
    ok: true,
    data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, ...data }
  });

  /** A page that already shows a finished exchange and a turn still being written. */
  const midTurn = (document: Document): void => {
    userTurn(document, 'turn-old-user', 'fix the recorder');
    const settled = assistantTurn(document, 'turn-old', []);
    const answered = document.createElement('div');
    answered.className = 'markdown';
    answered.textContent = 'The recorder is fixed.';
    settled.append(answered);
    userTurn(document, 'turn-live-user', 'and now the reload split');
    assistantTurn(document, 'turn-live', ['Reading content.js']);
    startGenerating(document);
  };

  it('adopts the open turn instead of opening a second one', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      midTurn
    );

    // The boot handshake has already run by here; this is the first ordinary tick after it.
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
    // Bound before the first observation, so nothing this page load emits is journalled
    // without a conversation to file it under.
    const order = live.sent.map((message) => message.type);
    expect(order.indexOf('bind')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('bind')).toBeLessThan(order.indexOf('events'));
  });

  it('waits for durable turn identity when the first reload activity request misses the app', async () => {
    let attempts = 0;
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      {
        activity: () => {
          attempts += 1;
          if (attempts === 1) return { ok: false, error: 'app_not_found' };
          return activity({ activeTurnId: 'g-old-run-0-4' });
        }
      },
      midTurn
    );

    // The first boot pull failed. Stop is visible, but that is not permission to mint a new
    // local generation while the app's durable identity question is still unanswered.
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);

    // The ordinary activity poll later reaches the app and adopts the exact durable id.
    await live.hook.pullActivity();
    await settle();
    live.hook.observe();
    await settle();

    expect(attempts).toBe(2);
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
  });

  it('files everything after the reload under the turn it resumed', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      midTurn
    );
    live.hook.observe();
    await settle();

    // Modern capture is canonical page-model capture. Feed the same v8 turn descriptor the
    // live Fiber helper would expose after the reload rather than relying on legacy DOM prose
    // / row scraping, which was deliberately removed from the recorder path.
    const base = {
      turnId: 'turn-live',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calls: []
    };
    const interim = {
      messageId: 'reload-interim',
      rawMessageId: 'reload-interim',
      stable: true,
      order: 2,
      rawText: 'Now looking at the turn lifecycle.',
      renderedHtml: '<p>Now looking at the turn lifecycle.</p>'
    };
    await replyFiber([], [{
      ...base,
      messages: [interim],
      activities: [{ messageId: 'reload-activity', label: 'Reading content.js', order: 1 }]
    }]);
    await live.hook.flush();
    await settle();

    await replyFiber([], [{
      ...base,
      endMessageId: 'reload-final',
      messages: [
        interim,
        {
          messageId: 'reload-final',
          rawMessageId: 'reload-final',
          stable: true,
          order: 3,
          rawText: 'Split fixed.',
          renderedHtml: '<p>Split fixed.</p>'
        }
      ],
      activities: [{ messageId: 'reload-activity', label: 'Reading content.js', order: 1 }]
    }]);
    await live.hook.flush();
    await settle();

    for (const kind of ['page_tool', 'assistant_message', 'turn_end']) {
      const turns = new Set(emitted(live.sent, kind).map((entry) => entry.event.turnId));
      expect([kind, [...turns]]).toEqual([kind, ['g-old-run-0-4']]);
    }
    expect(emitted(live.sent, 'assistant_message').map((entry) => entry.event.text)).toEqual([
      'Now looking at the turn lifecycle.',
      'Split fixed.'
    ]);
    // Exactly one end, for the turn the app already had open — not a second one.
    expect(emitted(live.sent, 'turn_end')).toHaveLength(1);
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
  });

  it('does not replay the settled part of the transcript as this turn’s output', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      midTurn
    );
    live.hook.observe();
    await settle();

    // The finished answer above is reported as history, with no local live-turn ownership.
    // The live turn descriptor is intentionally empty here: the regression is specifically
    // that a reload must not re-label already-settled history as output of the adopted turn.
    const turns = [
      {
        turnId: 'turn-old',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        calls: [],
        messages: [{
          messageId: 'reload-history-answer',
          rawMessageId: 'reload-history-answer',
          stable: true,
          order: 1,
          rawText: 'The recorder is fixed.',
          renderedHtml: '<p>The recorder is fixed.</p>'
        }],
        activities: []
      },
      {
        turnId: 'turn-live',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        calls: [],
        messages: [],
        activities: []
      }
    ];
    await replyFiber([], turns);
    await live.hook.flush();
    await settle();
    const answers = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(answers.map((event) => event.text)).toEqual(['The recorder is fixed.']);
    expect(answers[0]!.turnId).not.toBe('g-old-run-0-4');
    // And it is not re-reported on every later tick either.
    await replyFiber([], turns);
    await live.hook.flush();
    await settle();
    expect(emitted(live.sent, 'assistant_message')).toHaveLength(1);
  });

  it('opens a new turn when the app has none to resume', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: null }) },
      midTurn
    );
    live.hook.observe();
    await settle();

    // The case that must not regress: a genuinely new turn with nothing on the app side
    // still has to be announced, or the first turn of every chat goes unrecorded.
    const starts = emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId as string);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatch(/^g-/);
  });

  /**
   * The turn finished during the reload gap.
   *
   * The page comes back with the answer already on screen and no stop button. The app is
   * still holding `g-old` open and would hold it forever if nothing named the answer:
   * recorder.ts recovers a missing `turn_end` only from a final carrying the id of a turn it
   * has open, and a fresh document has no `settledGenerations` entry to supply one.
   *
   * So the turn is resumed anyway and then closed by the ordinary settle window — which is
   * what makes it safe to resume on a page that looks finished, since the next case is
   * indistinguishable from this one at boot.
   */
  const finishedDuringReload = (document: Document): void => {
    const earlier = assistantTurn(document, 'turn-earlier', []);
    const first = document.createElement('div');
    first.className = 'markdown';
    first.textContent = 'An answer from three turns ago.';
    earlier.append(first);
    const settled = assistantTurn(document, 'turn-old', []);
    const answered = document.createElement('div');
    answered.className = 'markdown';
    answered.textContent = 'The recorder is fixed.';
    settled.append(answered);
  };

  it('closes an open turn that finished while the page was reloading, once', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      finishedDuringReload
    );

    // One quiet DOM sample proves nothing. The durable app turn is adopted first and remains
    // open until the canonical page model identifies the exact public message that ended it.
    live.hook.observe();
    await settle();
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);

    const earlier = live.document.querySelector('[data-turn-id="turn-earlier"]') as HTMLElement;
    const settled = live.document.querySelector('[data-turn-id="turn-old"]') as HTMLElement;
    await bindFiberTurns([
      {
        section: earlier,
        turn: {
          turnId: 'turn-earlier',
          messages: [{
            messageId: 'reload-earlier-final', rawMessageId: 'reload-earlier-final', stable: true, order: 1,
            rawText: 'An answer from three turns ago.', renderedHtml: '<p>An answer from three turns ago.</p>'
          }]
        }
      },
      {
        section: settled,
        turn: {
          turnId: 'turn-old',
          endMessageId: 'reload-gap-final',
          messages: [{
            messageId: 'reload-gap-final', rawMessageId: 'reload-gap-final', stable: true, order: 1,
            rawText: 'The recorder is fixed.', renderedHtml: '<p>The recorder is fixed.</p>'
          }]
        }
      }
    ]);
    await live.hook.flush();
    await settle();

    // No turn was invented for history, and the exact terminal website object closes the one
    // durable turn the app already had open. Historical prose never inherits that local id.
    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe('g-old-run-0-4');
    expect(ends[0]!.outcome).toBe('completed');
    const answers = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(answers.map((entry) => entry.text)).toEqual(['An answer from three turns ago.', 'The recorder is fixed.']);
    expect(answers[0]!.turnId).not.toBe('g-old-run-0-4');
    expect(answers[1]!.turnId).toBe('g-old-run-0-4');

    // And the next real turn is this document's own, not the app's leftover.
    startGenerating(live.document);
    const next = assistantTurn(live.document, 'turn-next', []);
    // A terminal Fiber object deliberately latches until the page model proves a newer
    // response exists. DOM Stop alone is not enough, because ChatGPT can leave it stale.
    next.setAttribute('data-clf-fiber-turn', '0');
    await replyFiber(
      [],
      [{
        turnId: 'turn-next',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        calls: [],
        messages: [{
          messageId: 'reload-next-live', rawMessageId: 'reload-next-live', stable: true, order: 1,
          rawText: 'Next response starting.', renderedHtml: '<p>Next response starting.</p>'
        }],
        activities: []
      }],
      { pageTurnId: 'turn-next', terminalProbe: 'reload-gap-final' }
    );
    live.hook.observe();
    await settle();
    const starts = emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId as string);
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toBe('g-old-run-0-4');
  });

  /**
   * The same page at boot, and a completely different situation: the stop button was simply
   * missing for a moment while the reloaded page rendered. Resuming on the strength of one
   * sample and publishing the visible prose as the answer would close `g-old` from a turn
   * that is still writing — the reload flavour of the dropout bug, and the reason boot goes
   * through the settle window rather than around it.
   */
  it('does not close a resumed turn whose stop button was only missing while the page rendered', async () => {
    live = await harness(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { activity: () => activity({ activeTurnId: 'g-old-run-0-4' }) },
      finishedDuringReload
    );

    live.hook.observe();
    await settle();
    const earlier = live.document.querySelector('[data-turn-id="turn-earlier"]') as HTMLElement;
    const active = live.document.querySelector('[data-turn-id="turn-old"]') as HTMLElement;
    const streamingTurns = [
      {
        section: earlier,
        turn: {
          turnId: 'turn-earlier',
          messages: [{
            messageId: 'reload-earlier-final', rawMessageId: 'reload-earlier-final', stable: true, order: 1,
            rawText: 'An answer from three turns ago.', renderedHtml: '<p>An answer from three turns ago.</p>'
          }]
        }
      },
      {
        section: active,
        turn: {
          turnId: 'turn-old',
          messages: [{
            messageId: 'reload-gap-live', rawMessageId: 'reload-gap-live', stable: true, order: 1,
            rawText: 'The recorder is fixed.', renderedHtml: '<p>The recorder is fixed.</p>'
          }]
        }
      }
    ];
    await bindFiberTurns(streamingTurns);
    await live.hook.flush();
    await settle();
    // React finishes mounting and the stop button is there after all.
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    live.advance(live.hook.TURN_SETTLE_MS * 3);
    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'turn_start')).toHaveLength(0);
    expect(emitted(live.sent, 'turn_end')).toHaveLength(0);
    // The live prose may be journalled as a partial, but it must not be promoted to a final
    // answer merely because Stop was missing during the reload render.
    const beforeFinal = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(beforeFinal.map((entry) => entry.text)).toEqual(['An answer from three turns ago.', 'The recorder is fixed.']);
    expect(beforeFinal[1]!.turnId).toBe('g-old-run-0-4');
    expect(beforeFinal[1]!.final).toBe(false);

    // It finishes properly once the page model marks that same website message terminal,
    // still under the adopted id and still only once.
    stopGenerating(live.document);
    live.hook.observe();
    await settle();
    await bindFiberTurns([
      streamingTurns[0]!,
      {
        section: active,
        turn: {
          turnId: 'turn-old',
          endMessageId: 'reload-gap-live',
          messages: [{
            messageId: 'reload-gap-live', rawMessageId: 'reload-gap-live', stable: true, order: 1,
            rawText: 'The recorder is fixed.', renderedHtml: '<p>The recorder is fixed.</p>'
          }]
        }
      }
    ]);
    await live.hook.flush();
    await settle();
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.turnId).toBe('g-old-run-0-4');
    const afterFinal = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(afterFinal.at(-1)).toMatchObject({ text: 'The recorder is fixed.', turnId: 'g-old-run-0-4', final: true });
  });
});

describe('how a turn is recorded as having ended', () => {
  const endTurn = async (): Promise<void> => {
    await settleTurn(live!);
  };

  /**
   * Live duplicate, session `2026-08-17-7365eb08` events 20 and 21: one answer, stored
   * twice, 19 ms apart, identical text and identical digest — once under ChatGPT's own
   * reused turn id and once under the local generation. The settling tick reports the
   * messages on both sides of the moment the generation mapping is seeded, and the id is
   * derived from that mapping, so the second pass did not recognise its own first pass.
   */
  it.skip('stores one answer once, whichever id the settling tick can derive for it', async () => {
    live = await harness();

    startGenerating(live.document);
    const section = assistantTurn(live.document, 'turn-answered-once', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'Jo bro. Ich teste die neuen Core-Tools.';
    section.append(answer);
    live.hook.observe();
    await settle();
    await endTurn();
    // And a further quiet tick, because the page keeps the settled section on screen.
    live.hook.observe();
    await settle();

    const finals = emitted(live.sent, 'assistant_message').map((entry) => entry.event);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('Jo bro. Ich teste die neuen Core-Tools.');
  });

  it('does not close a silent turn because an earlier turn answered', async () => {
    live = await harness();

    // A first turn that really did answer.
    startGenerating(live.document);
    const first = assistantTurn(live.document, 'turn-1', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'the answer to the first question';
    first.append(answer);
    live.hook.observe();
    await settle();
    await endTurn();

    // A second turn that produces nothing at all.
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-2', []);
    live.hook.observe();
    await settle();
    await endTurn();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    // Two starts, under two different locally minted ids. The second one has no evidence of
    // completion, so it deliberately remains open rather than manufacturing an `unknown`
    // turn_end from an absent stop control.
    const starts = emitted(live.sent, 'turn_start').map((entry) => entry.event.turnId as string);
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
    expect(ends.map((event) => event.turnId)).toEqual([starts[0]]);
    expect(ends[0]!.outcome).toBe('completed');
  });

  it('records a repeated identical error as a second failure rather than suppressing it', async () => {
    live = await harness();
    const TEXT = 'Message delivery timed out. Please try again. Retry';

    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();
    const firstBanner = alertBanner(live.document, TEXT);
    await endTurn();

    // The banner is dismissed and the user tries again; the same failure happens again.
    firstBanner.remove();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-2', []);
    live.hook.observe();
    await settle();
    alertBanner(live.document, TEXT);
    await endTurn();

    // Two failures happened, so two are recorded — keyed on the occurrence, not the words.
    expect(emitted(live.sent, 'chat_error').map((entry) => entry.event.text)).toEqual([TEXT, TEXT]);
    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends.map((event) => event.outcome)).toEqual(['failed', 'failed']);
  });

  it('ignores the screen-reader live regions ChatGPT announces ordinary UI state through', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();

    // All three are `role="alert"`. Only the last one is a failure the user could see; the
    // first two are the announcer, which one recorded run filled with sixty "errors" that
    // never happened.
    const announcer = alertBanner(live.document, 'Reasoning details opened');
    announcer.className = 'sr-only';
    const dictation = alertBanner(live.document, 'Dictation is active and in use');
    dictation.className = 'visually-hidden';
    alertBanner(live.document, 'Something went wrong.');

    live.hook.observe();
    await settle();

    expect(emitted(live.sent, 'chat_error').map((entry) => entry.event.text)).toEqual(['Something went wrong.']);
  });

  it('still reports one rendered occurrence only once, however often it is observed', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();
    alertBanner(live.document, 'Something went wrong.');

    for (let pass = 0; pass < 3; pass++) {
      live.hook.observe();
      await settle();
    }

    expect(emitted(live.sent, 'chat_error')).toHaveLength(1);
  });

  it('does not republish a banner ChatGPT simply leaves on screen', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();
    // Never dismissed: the same node is still there three turns later.
    alertBanner(live.document, 'Something went wrong.');
    await endTurn();

    for (const id of ['turn-2', 'turn-3']) {
      startGenerating(live.document);
      assistantTurn(live.document, id, []);
      live.hook.observe();
      await settle();
      await endTurn();
    }

    expect(emitted(live.sent, 'chat_error')).toHaveLength(1);
  });

  it('does not blame a turn for an error banner that was already on screen when it began', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'turn-1', []);
    live.hook.observe();
    await settle();
    // The failure belongs to turn-1, and its banner is never dismissed.
    alertBanner(live.document, 'Something went wrong.');
    await endTurn();

    startGenerating(live.document);
    const second = assistantTurn(live.document, 'turn-2', []);
    const answer = live.document.createElement('div');
    answer.className = 'markdown';
    answer.textContent = 'the second turn answered perfectly well';
    second.append(answer);
    live.hook.observe();
    await settle();
    await endTurn();

    const ends = emitted(live.sent, 'turn_end').map((entry) => entry.event);
    expect(ends.map((event) => event.outcome)).toEqual(['failed', 'completed']);
  });
});

/**
 * `pagehide` fires for two very different things: the page going away, and the page being
 * frozen into the back/forward cache to come back shortly. Treating the second as a close
 * ended the session, and the next observation from the same tab reopened it — which is
 * where the Activity log's flood of "session … reopened" came from, ten lines in seventy
 * seconds with five tabs open and nothing actually happening.
 */
describe('a page leaving the screen', () => {
  const pagehide = async (persisted: boolean): Promise<void> => {
    const event = live!.window.document.createEvent('Event');
    event.initEvent('pagehide', false, false);
    Object.defineProperty(event, 'persisted', { value: persisted });
    live!.window.dispatchEvent(event);
    await settle();
  };

  it('does not confuse document unload with a conversation close', async () => {
    live = await harness();
    await pagehide(false);
    // Reload, renderer replacement and an actual tab close all produce pagehide. The
    // service worker owns tab lifetime now, so this document may only flush observations.
    expect(live.sent.filter((message) => message.type === 'closed')).toHaveLength(0);
  });

  it('says nothing when the page is only going into the back/forward cache', async () => {
    live = await harness();
    await pagehide(true);
    expect(live.sent.filter((message) => message.type === 'closed')).toHaveLength(0);
  });
});

/**
 * The bridge to the MAIN-world helper.
 *
 * The helper runs in ChatGPT's own JavaScript context, which means the page can post
 * exactly the messages it posts. So the receiving side is written as a validator, not as
 * a parser of something it trusts, and these tests are mostly about what it refuses.
 */
describe('evidence from the page context', () => {
  const GOOD = {
    v: 8,
    index: 0,
    tool: 'agent_status',
    path: '/TobisComputer/mcp/agent_status',
    app: 'TobisComputer',
    resource: 'resource://tools/agent_status',
    messageId: 'msg-1',
    turnId: 'turn-1',
    conversationId: 'conv-1',
    createTime: 1_700_000_000,
    hidden: 4,
    localCount: 5,
    answered: true
  };

  const reply = replyFiber;

  it('reads a well-formed descriptor', async () => {
    live = await harness();
    expect(live.hook.readDescriptor(GOOD)).toMatchObject({
      index: 0,
      tool: 'agent_status',
      app: 'TobisComputer',
      hidden: 4,
      localCount: 5,
      answered: true
    });
  });

  it('refuses anything that is not the shape it knows', async () => {
    live = await harness();
    const bad: unknown[] = [
      null,
      'not an object',
      // A tab still running the previous helper answers with descriptors built the old
      // way — named after the connector bridge when a payload was truncated, paired with
      // whatever result came back next. Refused outright rather than half-understood.
      { ...GOOD, v: 1 },
      { ...GOOD, v: 2 },
      { ...GOOD, v: undefined },
      { ...GOOD, index: -1 },
      { ...GOOD, index: 1.5 },
      { ...GOOD, index: 999 },
      { ...GOOD, index: '0' },
      // A tool name is put on screen and used as an identity; it may not be arbitrary text.
      { ...GOOD, tool: 'agent status; rm -rf' },
      { ...GOOD, tool: 'x'.repeat(65) }
    ];
    for (const raw of bad) expect(live.hook.readDescriptor(raw), JSON.stringify(raw)).toBeNull();
  });

  it('caps long strings and normalises a nonsense fold count', async () => {
    live = await harness();
    const read = live.hook.readDescriptor({
      ...GOOD,
      path: 'p'.repeat(9000),
      hidden: -5
    })!;
    expect(read.path!.length).toBe(200);
    expect(read.hidden).toBe(0);
  });

  /**
   * Argument values are the user's own text and this app's own secrets — `agent_key` has
   * been observed in the raw request JSON. There is no key-level allowlist that
   * generalises across tools, so none of it crosses at all.
   */
  it('has no field that could carry a tool argument or a secret', async () => {
    live = await harness();
    const read = live.hook.readDescriptor({ ...GOOD, args: { agent_key: 'secret' }, agent_key: 'secret' })!;
    expect(JSON.stringify(read)).not.toContain('secret');
    expect(Object.keys(read).sort()).toEqual(
      [
        'answered',
        'app',
        'conversationId',
        'createTime',
        'hidden',
        'index',
        'localCount',
        'messageId',
        'path',
        'resource',
        'tool',
        'turnId'
      ].sort()
    );
  });

  it('matches a descriptor to the row the helper stamped', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    const block = section.querySelector('[aria-label="Open tool call list"]')!;
    block.setAttribute('data-clf-fiber', '0');
    await reply([GOOD]);
    expect(live.hook.fiberFor(block)).toMatchObject({ tool: 'agent_status', hidden: 4 });
  });

  it('maps Fiber call evidence onto the local generation id, never ChatGPT’s reused page turn id', async () => {
    live = await harness();
    startGenerating(live.document);
    assistantTurn(live.document, 'reused-page-turn', []);
    live.hook.observe();
    await settle();
    const local = emitted(live.sent, 'turn_start')[0]!.event.turnId as string;
    expect(local).toMatch(/^g-/);

    // Two Fiber turns expose the same page turn id, which is exactly the live renderer
    // failure mode. The older occurrence still proves its conversation issued a connector
    // request, but only the newest occurrence matching the currently bound assistant turn is
    // allowed to inherit the local durable generation id.
    await reply([], [
      {
        turnId: 'reused-page-turn',
        calls: [{ messageId: 'old-call', tool: 'read', order: 0, answered: true }]
      },
      {
        turnId: 'reused-page-turn',
        calls: [{ messageId: 'live-call', tool: 'agents', order: 0, answered: false }]
      }
    ]);
    // refreshFiber queues the evidence; the normal observer tick is what journals the queue.
    live.hook.observe();
    await settle();

    const evidence = emitted(live.sent, 'tool_evidence').map((entry) => entry.event);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]!.turnId).toBeUndefined();
    expect(evidence[1]!.turnId).toBe(local);
    expect(evidence.some((entry) => entry.turnId === 'reused-page-turn')).toBe(false);
  });

  it('refreshes request-id evidence during a live turn even when ChatGPT renders no connector row', async () => {
    live = await harness();
    assistantTurn(live.document, 'rowless-live-turn', []);
    await settle();
    startGenerating(live.document);

    const window = live.window as any;
    const instant = window.setTimeout;
    window.setTimeout = (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms);
    let answered!: () => void;
    const responseSeen = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const onAsk = (event: any) => {
      if (!event.data || event.data.source !== 'clf-fiber-ask') return;
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: {
            source: 'clf-fiber-reply',
            nonce: event.data.nonce,
            v: 8,
            rows: [],
            turns: [
              {
                index: 0,
                turnId: 'rowless-live-turn',
                conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                calls: [
                  {
                    messageId: 'rowless-request-message',
                    tool: 'read',
                    order: 0,
                    answered: false,
                    requestId: 'wfr_rowless_live',
                    createTime: 1_700_000_000
                  }
                ],
                messages: []
              }
            ]
          },
          source: window
        })
      );
      answered();
    };
    window.addEventListener('message', onAsk);
    try {
      // This is the 1.7.9 regression: no tool row is inserted or mutated. The ordinary live
      // observer itself must still scan ChatGPT's message model for metadata.request_id.
      live.hook.observe();
      await responseSeen;
      await settle();
      await live.hook.flush();
    } finally {
      window.removeEventListener('message', onAsk);
      window.setTimeout = instant;
    }

    const evidence = emitted(live.sent, 'tool_evidence').map((entry) => entry.event);
    expect(evidence).toContainEqual(
      expect.objectContaining({
        kind: 'tool_evidence',
        fiberConversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        calls: [expect.objectContaining({ messageId: 'rowless-request-message', requestId: 'wfr_rowless_live' })]
      })
    );
  });

  it('says nothing about a row the helper did not stamp', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    await reply([GOOD]);
    expect(live.hook.fiberFor(section.querySelector('[aria-label="Open tool call list"]')!)).toBeNull();
  });

  /** Two descriptors claiming one row is a contradiction; believing either is a guess. */
  it('drops both when two descriptors claim the same row', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    const block = section.querySelector('[aria-label="Open tool call list"]')!;
    block.setAttribute('data-clf-fiber', '0');
    await reply([GOOD, { ...GOOD, tool: 'run_command' }]);
    expect(live.hook.fiberFor(block)).toBeNull();
  });

  /**
   * A browser where the MAIN-world script never ran, or a page that never answers, must
   * behave exactly as this extension did before the helper existed: no fold counts, and
   * every row treated as one call.
   */
  it('stays silent when nothing answers', async () => {
    live = await harness();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    const block = section.querySelector('[aria-label="Open tool call list"]')!;
    block.setAttribute('data-clf-fiber', '0');
    await live.hook.refreshFiber();
    expect(live.hook.fiberFor(block)).toBeNull();
  });

  /**
   * The case that made relabelling look broken everywhere but one chat. Verified on disk:
   * the failing conversation's session holds 10 recorded calls, all from a single turn on
   * one day, while the chat's connector rows go back several. The recorder only ever holds
   * the slice it observed live, so for most of a long-running chat there is nothing to
   * match against and no matching rule could ever have fixed it.
   */
  it('names a row the app has no record of, from the page’s own record', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    const row = section.querySelector('[aria-label="Open tool call list"]')!;
    row.setAttribute('data-clf-fiber', '0');
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        job: null
      }
    }));
    await reply([GOOD]);
    await live.hook.pullActivity();
    await settle();

    expect(labels(section)).toEqual(['agent_status']);
    const block = section.querySelector('[data-clf-page]')!;
    expect(block.getAttribute('data-clf-page')).toBe('agent_status');
    // Named, not claimed: no call bound, so a recorded call can still take the row later.
    expect(block.getAttribute('data-clf-call')).toBeNull();
    expect(block.classList.contains('clf-page')).toBe(true);
  });

  it('lets a recorded call take over a row the page had only named', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    const recorded = call({
      turnId: 'turn-1',
      seq: 1,
      // The same tool the descriptor names: the recorder and the page agreeing about what
      // ran is what earns the recorder the row.
      tool: 'agent_status',
      summary: { kind: 'agent', tone: 'neutral', title: 'Checked the swarm' }
    });
    let recordedYet = false;
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: recordedYet ? [recorded] : [],
        job: null
      }
    }));

    // An ordinary row standing for one call, which is the case where a recorded entry can
    // legitimately replace the page's name for it.
    await reply([{ ...GOOD, hidden: 0 }]);
    await live.hook.pullActivity();
    await settle();
    expect(labels(section)).toEqual(['agent_status']);

    recordedYet = true;
    await live.hook.pullActivity();
    await settle();
    // The recorder ran the call and knows what it did; the page only knew its name.
    expect(labels(section)).toEqual(['Checked the swarm']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);
  });

  /**
   * The other direction: the app knows about one call, but the page says this row stands
   * for five. Putting the one label it has on that row would name it after the wrong call.
   */
  it('leaves a folded row alone rather than naming it after the wrong call', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    const recorded = call({ turnId: 'turn-1', seq: 1, summary: { kind: 'agent', tone: 'neutral', title: 'Step one' } });
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [recorded],
        job: null
      }
    }));

    await reply([GOOD]);
    await live.hook.pullActivity();
    await settle();
    // Named from the page, which is honest about what it is, and not bound to the call.
    expect(labels(section)).toEqual(['agent_status']);
    expect(section.querySelector('[data-clf-call]')).toBeNull();
  });

  /**
   * The whole point of the descriptor arriving late: a row can already be wearing the
   * wrong call by the time the page names it. Leaving that standing is the one outcome
   * worse than "Called tool" — another call's name, in this app's styling, with a
   * duration and an outcome, over work it did not describe.
   */
  it('takes a wrong label back off when the page names the row later', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool!']);
    section.querySelector('[aria-label="Open tool call list"]')!.setAttribute('data-clf-fiber', '0');
    const recorded = call({
      turnId: 'turn-1',
      seq: 1,
      tool: 'list_windows',
      summary: { kind: 'agent', tone: 'neutral', title: 'Listed open windows', metric: '6 windows' }
    });
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [recorded],
        job: null
      }
    }));

    // The payload was truncated and the call had not been answered yet, so the page could
    // not name the row. One row, one call, the counts fit: the label goes on.
    await reply([{ ...GOOD, tool: null, hidden: 0 }]);
    await live.hook.pullActivity();
    await settle();
    expect(labels(section)).toEqual(['Listed open windows6 windows']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(1);

    // Then the result comes back and the page names the row a different tool.
    await reply([{ ...GOOD, tool: 'screenshot', hidden: 0 }]);
    await live.hook.pullActivity();
    await settle();
    // Back to ChatGPT's row, renamed from the page's own record, with nothing of the
    // recorded call left on it — not the binding, not the metric, not the styling.
    expect(labels(section)).toEqual(['screenshot']);
    expect(section.querySelector('[data-clf-call]')).toBeNull();
    expect(section.querySelector('.clf-metric')).toBeNull();
    const block = section.querySelector('[data-clf-page]')!;
    expect(block.getAttribute('data-clf-page')).toBe('screenshot');
    expect(block.classList.contains('clf-tool')).toBe(true);
  });
});

describe('the activity feed', () => {
  it('keeps the recorder alive across a transient missing service-worker receiver', async () => {
    let attempts = 0;
    live = await harness(undefined, {
      events: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true, pending: 0, durable: true };
      }
    });

    live.hook.emit({ kind: 'chat_error', text: 'one durable observation' });
    await live.hook.flush();
    await live.hook.flush();

    expect(attempts).toBe(2);
  });

  it('asks for what comes after the last entry, not for the last entry again', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-1', ['Called tool', 'Called tool']);
    const first = call({ turnId: 'turn-1', seq: 4, summary: { kind: 'read', tone: 'neutral', title: 'Read a.ts' } });
    const second = call({
      turnId: 'turn-1',
      seq: 5,
      outcome: 'error',
      summary: { kind: 'run', tone: 'bad', title: 'Command failed  npm test', metric: '✕ exit 1' }
    });

    const asked: number[] = [];
    live.reply.set('activity', (message) => {
      asked.push(message.since);
      return {
        ok: true,
        data: {
          entries: [first, second].filter((entry) => entry.seq >= message.since),
          job: null
        }
      };
    });

    await live.hook.pullActivity();
    await settle();
    await live.hook.pullActivity();
    await settle();

    // The off-by-one that made every poll re-deliver the newest call — and so made the
    // turn look like it had more calls than blocks, which suppressed every label.
    expect(asked).toEqual([0, 6]);
    expect(labels(section)).toEqual(['Read a.ts', 'Command failed npm test✕ exit 1']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(2);
  });

  it('marks a failed call as failed on the block itself, not only in its colour', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-2', ['Called tool']);
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [
          call({
            turnId: 'turn-2',
            outcome: 'error',
            summary: { kind: 'run', tone: 'bad', title: 'Could not run git push', metric: '✕ failed' }
          })
        ],
        job: null
      }
    }));

    await live.hook.pullActivity();
    await settle();

    const block = section.querySelector('.pointer-events-none.contents') as HTMLElement;
    expect(block.dataset.clfOutcome).toBe('error');
    expect(block.classList.contains('clf-bad')).toBe(true);
    expect(block.textContent).toContain('Could not run git push');
  });

  it('survives the same entry being delivered twice', async () => {
    live = await harness();
    renderingOn();
    const section = assistantTurn(live.document, 'turn-3', ['Called tool', 'Called tool']);
    const one = call({ turnId: 'turn-3', seq: 10, summary: { kind: 'read', tone: 'neutral', title: 'Read one.ts' } });
    const two = call({ turnId: 'turn-3', seq: 11, summary: { kind: 'read', tone: 'neutral', title: 'Read two.ts' } });
    live.reply.set('activity', () => ({
      ok: true,
      // A feed that repeats itself, which is what the old `since` produced.
      data: {
        entries: [one, two, two],
        job: null
      }
    }));

    await live.hook.pullActivity();
    await settle();
    await live.hook.pullActivity();
    await settle();

    expect(labels(section)).toEqual(['Read one.ts', 'Read two.ts']);
    expect(section.querySelectorAll('.clf-tool-icon svg')).toHaveLength(2);
  });
});

describe('the Compact & resume control', () => {
  it('does not exist on a brand-new chat before the first message is sent', async () => {
    live = await harness('https://chatgpt.com/');
    live.hook.injectControl();
    expect(live.document.querySelector('.clf-composer')).toBeNull();
  });

  it('sits in the composer, before the send button once the chat exists', async () => {
    live = await harness();
    live.hook.injectControl();

    const control = live.document.querySelector('.clf-composer') as HTMLElement;
    expect(control, 'no Compact & resume control was injected').not.toBeNull();
    const row = live.document.querySelector('[data-testid="composer-trailing-actions"]')!;
    expect(control.parentElement).toBe(row);
    const order = [...row.children].map((node) => node.getAttribute('data-testid') || node.className);
    expect(order).toEqual([
      'composer-speech-button',
      'clf-composer',
      'send-button'
    ]);
    // `data-clf-tip`, not `title`: the hover text is drawn by this extension in ChatGPT's
    // own style rather than by the operating system. See `.clf-tip`.
    expect(control.querySelector('.clf-compact-btn')!.getAttribute('data-clf-tip')).toBe('Compact & resume');
  });

  /**
   * ChatGPT's appearance setting is its own, and can be the opposite of the operating
   * system's. The colours our menu and hover bubble copy have no page variable to read, so
   * one of two written-out sets is chosen — and it has to be chosen from what the page is
   * actually painted, or someone running ChatGPT in Light on a dark Windows gets a black
   * popup on a white conversation.
   */
  it('takes its light or dark surface from the page, not from the operating system', async () => {
    live = await harness();
    const root = live.document.documentElement;
    const form = live.document.querySelector('#composer-form') as HTMLElement;

    form.style.backgroundColor = 'rgb(255, 255, 255)';
    live.hook.syncTheme();
    expect(root.getAttribute('data-clf-theme')).toBe('light');

    // Changed while the tab is open, which is how the setting is actually used.
    form.style.backgroundColor = 'rgb(33, 33, 33)';
    live.hook.syncTheme();
    expect(root.getAttribute('data-clf-theme')).toBe('dark');
  });

  /**
   * The reason the previous control lived in the + menu: ChatGPT replaces the composer's
   * subtree whenever it feels like it. Hiding from that made the control impossible to
   * find, so it has to survive it instead.
   */
  it('comes back after ChatGPT replaces the whole composer', async () => {
    live = await harness();
    live.hook.injectControl();
    expect(live.document.querySelector('.clf-compact-btn')).not.toBeNull();

    const form = live.document.querySelector('#composer-form')!;
    form.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-testid="composer-trailing-actions">
        <button data-testid="composer-speech-button"></button>
        <button data-testid="send-button"></button>
      </div>`;
    expect(live.document.querySelector('.clf-compact-btn')).toBeNull();

    live.hook.injectControl();
    expect(live.document.querySelector('.clf-compact-btn')).not.toBeNull();
    expect(live.document.querySelectorAll('.clf-compact-btn')).toHaveLength(1);
  });

  it('says what the job is doing at every stage', async () => {
    live = await harness();
    const state = (over: Record<string, unknown>) =>
      live!.hook.controlState({
        job: null,
        connected: true,
        conversationId: 'c1',
        pressedAt: 0,
        error: '',
        now: 1000,
        ...over
      });

    expect(state({})).toMatchObject({ mode: 'idle', label: 'Compact & resume', action: 'start' });
    expect(state({ disconnected: true })).toMatchObject({
      mode: 'off',
      hint: 'Browser connection is disconnected in ChatGPT Local Files.',
      action: 'none'
    });
    expect(state({ pressedAt: 900 })).toMatchObject({ mode: 'busy', label: 'Starting…', action: 'none' });

    // The local phases, which no app-side state can describe: the app only knows it has
    // asked and is waiting, so `handoff-pending` plus the phase is the whole report.
    const pending = { sessionId: 's1', stage: 'handoff-pending', busy: true, error: null, handoffId: null };
    expect(state({ job: pending, phase: 'interrupting' })).toMatchObject({
      mode: 'busy',
      label: 'Stopping this turn…',
      action: 'cancel'
    });
    expect(state({ job: pending, phase: 'settling' })).toMatchObject({ mode: 'busy', label: 'Finishing local tools…' });
    expect(state({ job: pending, phase: 'waiting' })).toMatchObject({ mode: 'busy', label: 'ChatGPT is writing…' });
    // An unknown phase — a tab that reloaded mid-run and lost its local state — still says
    // something true rather than nothing.
    expect(state({ job: pending, phase: '' })).toMatchObject({ mode: 'busy', label: 'Asking ChatGPT…' });

    expect(state({ job: { stage: 'opening', busy: true, error: null, handoffId: 'h1' } })).toMatchObject({
      mode: 'busy',
      label: 'Opening fresh chat…',
      action: 'cancel'
    });
    expect(
      state({ job: { stage: 'waiting-for-browser', busy: true, error: 'could not open your browser', handoffId: 'h1' } })
    ).toMatchObject({ mode: 'waiting', label: 'Waiting for Chrome…', action: 'cancel' });
    expect(state({ job: { stage: 'done', busy: false, error: null, handoffId: 'h1' } })).toMatchObject({
      mode: 'done',
      label: 'Fresh chat opened'
    });
    expect(
      state({ job: { stage: 'failed', busy: false, error: 'ChatGPT never wrote the brief', handoffId: null } })
    ).toMatchObject({
      mode: 'error',
      label: 'Compaction failed',
      hint: 'ChatGPT never wrote the brief',
      action: 'start'
    });
    expect(state({ job: { stage: 'failed', busy: false, error: 'cancelled', handoffId: null } })).toMatchObject({
      mode: 'idle',
      hint: 'Resume cancelled',
      action: 'start'
    });
    expect(state({ connected: false })).toMatchObject({ mode: 'off', action: 'none' });
    expect(state({ conversationId: null })).toMatchObject({ mode: 'off', hint: 'Send a message first.' });
  });

  /**
   * The 1.7.1 reversal.
   *
   * Until now the control removed itself the instant ChatGPT started generating, because
   * the only provider behind it read the local recording and so could not run against a
   * turn still being written. The default path interrupts that turn deliberately, and the
   * moment the user reaches for this is precisely a turn they no longer want to wait out —
   * so hiding then is hiding it whenever it is wanted.
   */
  it('stays available while ChatGPT is generating', async () => {
    live = await harness();
    const state = (over: Record<string, unknown>) =>
      live!.hook.controlState({
        job: null,
        connected: true,
        conversationId: 'c1',
        pressedAt: 0,
        error: '',
        now: 1000,
        ...over
      });

    // `generating` is no longer an input the control reads at all, so a caller that still
    // passes it cannot suppress the button by accident.
    expect(state({ generating: true })).toMatchObject({
      mode: 'idle',
      label: 'Compact & resume',
      action: 'start'
    });
    expect(state({ generating: true, job: { stage: 'handoff-pending', busy: true, error: null, handoffId: null } })).toMatchObject({
      mode: 'busy',
      action: 'cancel'
    });
  });

  it('interrupts the live turn, waits for local tools, then prompts this same chat', async () => {
    const prompt = 'Write a handoff brief … your reply to this message must be the brief itself';
    // One local call is still running, and finishes on the third time it is asked about.
    let asked = 0;
    const typedWhileBusy: string[] = [];
    live = await harness(undefined, {
      compact: () => ({
        ok: true,
        data: {
          started: true,
          token: 'tok-nc-1',
          prompt,
          job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
        }
      }),
      activity: () => {
        asked++;
        const pendingTools = asked < 3 ? 1 : 0;
        // Nothing may be typed while a local call is still in flight: a brief written over
        // a half-finished edit describes a machine that no longer exists.
        if (pendingTools > 0) typedWhileBusy.push(composerText(live!.document));
        return { ok: true, data: { entries: [], stream: [], nextSince: 0, pendingTools, job: null } };
      }
    });
    live.hook.injectControl();

    startGenerating(live.document);
    const sends = watchSend(live.document);
    const stop = live.document.querySelector('[data-testid="stop-button"]') as HTMLButtonElement;
    let stopped = false;
    stop.addEventListener('click', () => {
      stopped = true;
      stopGenerating(live!.document);
    });

    await live.hook.startCompact();

    expect(stopped).toBe(true);
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(typedWhileBusy.length).toBeGreaterThan(0);
    expect(typedWhileBusy.filter(Boolean)).toEqual([]);
    expect(composerText(live.document)).toContain('the brief itself');
    expect(sends()).toBe(1);
    const compacts = startedCompactions(live);
    expect(compacts).toHaveLength(1);
    expect(compacts[0]).toMatchObject({ resume: true });
    // The old chat is still the only place the work exists: nothing has been cancelled and
    // nothing has navigated. Opening the fresh chat is the app's job, and only once the
    // generation this send started has handed its brief back.
    expect(live.sent.some((message) => message.type === 'compact' && message.cancel === true)).toBe(false);
  });

  it('leaves the old chat alone and never opens a request at all when the turn will not stop', async () => {
    live = await harness(undefined, {
      compact: (message) => ({
        ok: true,
        data: message.cancel
          ? { cancelled: true }
          : {
              started: true,
              prompt: 'write the brief and call save_handoff',
              job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
            }
      })
    });
    live.hook.injectControl();
    startGenerating(live.document); // and nothing ever clears it
    const sends = watchSend(live.document);

    await live.hook.startCompact();

    // Never typed, never sent — and no app-side request to withdraw, because stopping the
    // turn now happens *before* asking. The request is what makes the app take its copy of
    // the recording, so a conversation that will not hold still never gets that far, and
    // there is no window in which a late save_handoff could save a brief and open a chat
    // for a run that gave up.
    expect(composerText(live.document)).toBe('');
    expect(sends()).toBe(0);
    expect(live.sent.filter((message) => message.type === 'compact')).toEqual([]);
    expect(live.document.querySelector('.clf-pill-text')!.textContent).toContain('would not stop');
  });

  it('never overwrites a draft the user is writing', async () => {
    live = await harness(undefined, {
      compact: (message) => ({
        ok: true,
        data: message.cancel
          ? { cancelled: true }
          : {
              started: true,
              prompt: 'write the brief and call save_handoff',
              job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
            }
      })
    });
    live.hook.injectControl();
    const sends = watchSend(live.document);
    live.document.querySelector('#prompt-textarea')!.textContent = 'half a question I was still typing';

    await live.hook.startCompact();

    expect(composerText(live.document)).toBe('half a question I was still typing');
    expect(sends()).toBe(0);
    const compacts = live.sent.filter((message) => message.type === 'compact');
    expect(compacts[compacts.length - 1]).toMatchObject({ cancel: true });
  });

  it('starts one job on a press and refuses a second press while it runs', async () => {
    live = await harness();
    live.reply.set('compact', () => ({
      ok: true,
      data: {
        started: true,
        job: { sessionId: 's1', stage: 'handoff-pending', busy: true, handoffId: null, error: null }
      }
    }));
    live.hook.injectControl();

    const button = live.document.querySelector('.clf-compact-btn') as HTMLButtonElement;
    // One control, one path: there is no chooser to press instead, so this is the press.
    button.click();
    await settle();

    expect(live.sent.filter((message) => message.type === 'compact')).toHaveLength(1);
    expect((live.document.querySelector('.clf-composer') as HTMLElement).dataset.clfMode).toBe('busy');

    // The impatient second press. The control is now a cancel, so it must not start
    // another compaction — this is the click that used to fan out into several tabs.
    button.click();
    await settle();
    const compacts = live.sent.filter((message) => message.type === 'compact');
    expect(compacts).toHaveLength(2);
    expect(compacts[1]).toMatchObject({ cancel: true });
  });

  it('shows why it could not start rather than silently doing nothing', async () => {
    live = await harness();
    live.reply.set('compact', () => ({
      ok: false,
      status: 409,
      data: { error: 'session_not_recorded', message: 'This chat has no recorded local session to compact.' }
    }));
    live.hook.injectControl();

    (live.document.querySelector('.clf-compact-btn') as HTMLButtonElement).click();
    await settle();

    expect((live.document.querySelector('.clf-composer') as HTMLElement).dataset.clfMode).toBe('error');
    expect(live.document.querySelector('.clf-pill-text')!.textContent).toBe(
      'Could not start · This chat has no recorded local session to compact.'
    );
  });
});

/**
 * The field stacked above the composer.
 *
 * Compact & resume used to say what it was doing in a pill the width of a button, and put
 * its actual output through the composer — the one part of the page that belongs to the
 * user. The work now happens in a second field behind the input, and the input stays empty.
 */
describe('the field above the composer', () => {
  const view = (over: Record<string, unknown>) => live!.hook.stageView({ job: null, ...over });

  it('is not there when nothing is happening', async () => {
    live = await harness();
    expect(view({})).toBeNull();
    live.hook.injectStage();
    expect(live.document.querySelector('.clf-stage')).toBeNull();
  });

  /**
   * Only ever this chat's own work. The job is reported per conversation, so a tab sitting
   * beside a chat that is compacting shows nothing of it.
   */
  it('says nothing about a job that is over', async () => {
    live = await harness();
    expect(view({ job: { stage: 'done', busy: false } })).toBeNull();
  });

  it('names the stage the transaction is in', async () => {
    live = await harness();
    expect(view({ job: { stage: 'handoff-pending', busy: true } })).toMatchObject({
      stage: 'ChatGPT is writing the handoff'
    });
    expect(view({ job: { stage: 'opening', busy: true } })).toMatchObject({ stage: 'Opening a fresh chat' });
    expect(view({ job: { stage: 'waiting-for-browser', busy: true } })).toMatchObject({ stage: 'Waiting for Chrome' });
  });

  it('stacks above the composer rather than inside it, and leaves when it is done', async () => {
    live = await harness();
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        job: { sessionId: 's1', stage: 'opening', busy: true, handoffId: 'h1', error: null }
      }
    }));
    await live.hook.pullActivity();
    await settle();

    const panel = live.document.querySelector('.clf-stage') as HTMLElement;
    const form = live.document.querySelector('#composer-form')!;
    expect(panel.parentElement).toBe(form.parentElement);
    expect(panel.nextElementSibling).toBe(form);
    // The user's own field is untouched, which was the whole complaint.
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toBe('');
    expect(panel.querySelector('.clf-stage-title')!.textContent).toBe('Opening a fresh chat');

    live.reply.set('activity', () => ({
      ok: true,
      data: { entries: [], job: null }
    }));
    await live.hook.pullActivity();
    await settle();
    expect(live.document.querySelector('.clf-stage')).toBeNull();
  });

  it('puts back exactly one panel when ChatGPT replaces the composer', async () => {
    live = await harness();
    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        job: { sessionId: 's1', stage: 'opening', busy: true, handoffId: 'h1', error: null }
      }
    }));
    await live.hook.pullActivity();
    await settle();
    expect(live.document.querySelectorAll('.clf-stage')).toHaveLength(1);

    live.document.querySelector('.clf-stage')!.remove();
    live.hook.injectStage();
    live.hook.injectStage();
    expect(live.document.querySelectorAll('.clf-stage')).toHaveLength(1);
  });
});

/**
 * The instruction the app typed to open the chat.
 *
 * A resumed chat opens with the whole handoff brief and a worker chat with "You are worker
 * agent worker-n …", and both arrive as an ordinary user message. It has to be sent —
 * ChatGPT needs it — but it does not have to be the first thing anybody reads.
 */
describe('folding away the chat’s opening instruction', () => {
  const BRIEF = 'TASK — ship v1.6\nREQUIREMENTS — no install, no reload\nDONE — the store fix';

  async function opened(kind: string | null, text = BRIEF): Promise<HTMLElement> {
    const section = userTurn(live!.document, 'u1', text);
    live!.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        bootstrap: kind,
        job: null
      }
    }));
    await live!.hook.pullActivity();
    await settle();
    return section;
  }

  it('leaves a chat the user started alone', async () => {
    live = await harness();
    const section = await opened(null, 'rename the thing');
    expect(section.querySelector('.clf-boot')).toBeNull();
    expect(section.textContent).toContain('rename the thing');
  });

  it('folds it away without losing a word of it', async () => {
    live = await harness();
    const section = await opened('resume');
    const fold = section.querySelector('.clf-boot') as HTMLElement;
    expect(fold).not.toBeNull();
    expect(fold.querySelector('summary')!.textContent).toContain('not something you typed');
    // Moved, not copied: one copy of a several-thousand-character brief, not two.
    expect(section.querySelectorAll('.whitespace-pre-wrap')).toHaveLength(1);
    expect(fold.textContent).toContain('REQUIREMENTS — no install, no reload');
    expect((section.querySelector('[data-message-id]') as HTMLElement).dataset.clfBootstrap).toBe('resume');
  });

  it('says which kind of machinery it was', async () => {
    live = await harness();
    const section = await opened('worker', 'You are worker agent worker-1. Your task is …');
    expect(section.querySelector('.clf-boot summary')!.textContent).toContain('gave the worker');
  });

  it('folds only the first message, not everything the user went on to say', async () => {
    live = await harness();
    const first = await opened('resume');
    const later = userTurn(live.document, 'u2', 'now do the next bit');
    live.hook.foldBootstrap();
    expect(first.querySelector('.clf-boot')).not.toBeNull();
    expect(later.querySelector('.clf-boot')).toBeNull();
  });

  /**
   * Asks the DOM rather than remembering. React re-rendering the message would take the
   * fold with it, and a remembered "already done" would leave the wall of text on screen.
   */
  it('folds it again when ChatGPT rebuilds the message', async () => {
    live = await harness();
    const section = await opened('resume');
    const message = section.querySelector('[data-message-id]') as HTMLElement;
    message.replaceChildren(live.document.createElement('div'));
    message.firstElementChild!.textContent = BRIEF;

    live.hook.foldBootstrap();
    expect(section.querySelector('.clf-boot')!.textContent).toContain('TASK — ship v1.6');
    expect(section.querySelectorAll('.clf-boot')).toHaveLength(1);
  });

  it('is not fooled by a chat whose first message is the assistant’s', async () => {
    live = await harness();
    assistantTurn(live.document, 'turn-0', []);
    const first = live.document.createElement('div');
    first.setAttribute('data-message-id', 'a1');
    first.setAttribute('data-message-author-role', 'assistant');
    live.document.querySelector('[data-turn="assistant"]')!.append(first);
    const section = userTurn(live.document, 'u1', BRIEF);

    live.reply.set('activity', () => ({
      ok: true,
      data: {
        entries: [],
        bootstrap: 'resume',
        job: null
      }
    }));
    await live.hook.pullActivity();
    await settle();
    expect(section.querySelector('.clf-boot')).toBeNull();
  });
});

describe('the fresh chat the app opened', () => {
  it('delivers the bootstrap before unrelated status restoration can stall startup', async () => {
    let releaseStatus: () => void = () => undefined;
    const statusHeld = new Promise((resolve) => {
      releaseStatus = () => resolve({ connected: true, paired: true, port: 8765, pending: 0 });
    });
    live = await harness(
      'https://chatgpt.com/?clf=cmd-fast-resume',
      {
        // This deliberately never resolves during the assertion. Before the fix,
        // runCommand() sat behind checkStatus(), so the fresh chat stayed blank here.
        status: () => statusHeld,
        redeem: () => ({
          ok: true,
          command: { id: 'cmd-fast-resume', type: 'resume', text: 'the long carried handoff', agent: null }
        }),
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: 'https://chatgpt.com/c/12121212-3434-5656-7878-909090909090' });
        });
      }
    );

    await settle(200);
    expect(live.sent[0]?.type).toBe('redeem');
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toContain('the long carried handoff');
    expect(live.sent.some((message) => message.type === 'ack' && message.status === 'sent')).toBe(true);

    releaseStatus();
    await settle();
  });

  it('does not journal replacement-chat observations until the resume ACK has committed the session move', async () => {
    let releaseAck: () => void = () => undefined;
    const ackHeld = new Promise<{ ok: boolean }>((resolve) => {
      releaseAck = () => resolve({ ok: true });
    });
    live = await harness(
      'https://chatgpt.com/?clf=cmd-gated',
      {
        redeem: () => ({
          ok: true,
          command: { id: 'cmd-gated', type: 'resume', text: 'the carried handoff', agent: null }
        }),
        ack: () => ackHeld
      },
      (document, dom) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: 'https://chatgpt.com/c/99999999-8888-7777-6666-555555555555' });
        });
      }
    );

    // Let the bootstrap send and the fresh chat acquire its id. The ACK is deliberately
    // still blocked, which is the exact window that used to create the three-event shadow.
    await settle(350);
    live.hook.observe();
    live.hook.emit({ kind: 'user_message', text: 'the carried handoff', messageId: 'boot-msg' });
    await live.hook.flush();
    expect(live.sent.filter((message) => message.type === 'events')).toHaveLength(0);

    releaseAck();
    await settle(100);
    const events = live.sent.filter((message) => message.type === 'events');
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((message) => JSON.stringify(message).includes('the carried handoff'))).toBe(true);
  });

  it('redeems the one command its URL names, and reports the conversation it became', async () => {
    live = await harness(
      'https://chatgpt.com/?clf=cmd-7#clf=cmd-7',
      {
        redeem: () => ({
          ok: true,
          command: {
            id: 'cmd-7',
            type: 'resume',
            text: 'Continue the previous ChatGPT session. Handoff: h-1',
            agent: null
          }
        }),
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        // ChatGPT accepting the message is what gives the chat its id.
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555' });
        });
      }
    );

    // No manual call: delivering the command is the first thing the script does on a
    // page the app opened, and that is the path under test.
    await settle(400);

    // The page says which page it is. A command belongs to one of them: a second tab on
    // the same marker is a different claimant, and the app refuses it rather than letting
    // two fresh chats both believe they are the replacement.
    const redeems = live.sent.filter((message) => message.type === 'redeem');
    expect(redeems).toHaveLength(1);
    expect(redeems[0]).toMatchObject({ type: 'redeem', id: 'cmd-7' });
    expect(typeof redeems[0]!.client).toBe('string');
    expect(redeems[0]!.client).not.toBe('');
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toContain('Handoff: h-1');
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      {
        type: 'ack',
        id: 'cmd-7',
        status: 'sent',
        conversationId: '11111111-2222-3333-4444-555555555555',
        agent: null,
        client: redeems[0]!.client
      }
    ]);
  });

  it('sends a worker bootstrap whose task is shorter than the text it verifies', async () => {
    // The bootstrap is the task, a blank line, and the wrapper explaining how to report.
    // The composer turns that blank line into a paragraph break and gives the text back
    // with no newline in it at all, so verifying the insert by looking for the first 80
    // characters verbatim failed for every task short enough to leave the break inside
    // them — reported to the app as ChatGPT having replaced the composer, which retired
    // the worker slot before the chat had said a word. Live, both workers of a two-worker
    // run died this way.
    const task = 'Read /totec/chatgpt-local-files/package.json and report the version field.';
    live = await harness(
      'https://chatgpt.com/?clf=cmd-10',
      {
        redeem: () => ({
          ok: true,
          command: {
            id: 'cmd-10',
            type: 'worker',
            text: `${task}

(You are a worker agent in a ChatGPT Local Files multi-agent run.)`,
            agent: 'worker-1'
          }
        }),
        ack: () => ({ ok: true })
      },
      (document, dom) => {
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          dom.reconfigure({ url: 'https://chatgpt.com/c/22222222-3333-4444-5555-666666666666' });
        });
      }
    );

    await settle(400);

    expect(live.document.querySelector('#prompt-textarea')!.textContent).toContain(task);
    expect(live.sent.filter((message) => message.type === 'ack')).toEqual([
      {
        type: 'ack',
        id: 'cmd-10',
        status: 'sent',
        conversationId: '22222222-3333-4444-5555-666666666666',
        agent: 'worker-1',
        client: expect.any(String)
      }
    ]);
  });

  it('types nothing when the marker is stale', async () => {
    live = await harness('https://chatgpt.com/?clf=cmd-old', {
      redeem: () => ({ ok: true, command: null, gone: true })
    });

    await live.hook.runCommand();
    await settle();

    expect(live.sent.filter((message) => message.type === 'redeem')).toHaveLength(1);
    expect(live.sent.filter((message) => message.type === 'ack')).toHaveLength(0);
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toBe('');
  });

  it('types nothing into a chat that already exists, whatever the marker says', async () => {
    // Every command the app queues opens a *fresh* chat; there is no longer any kind that
    // types into a conversation that already exists. So a marker carried into one — a
    // reloaded tab that has since got an id, a URL out of history, a duplicated tab — is
    // refused on sight, without a keystroke and without an acknowledgement that would
    // retire a command still owed a chat of its own.
    live = await harness('https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?clf=cmd-8', {
      redeem: () => ({
        ok: true,
        command: { id: 'cmd-8', type: 'worker', text: 'You are worker agent "worker-1".', agent: 'worker-1' }
      }),
      ack: () => ({ ok: true })
    });

    await live.hook.runCommand();
    await settle();

    expect(live.sent.filter((message) => message.type === 'ack')).toHaveLength(0);
    expect(live.document.querySelector('#prompt-textarea')!.textContent).toBe('');
  });

  it('tells the app it failed, once, and does not try again', async () => {
    live = await harness(
      'https://chatgpt.com/?clf=cmd-9',
      {
        redeem: () => ({
          ok: true,
          command: { id: 'cmd-9', type: 'worker', text: 'You are worker agent "worker-1".', agent: 'worker-1' }
        }),
        ack: () => ({ ok: true })
      },
      // ChatGPT refuses the insertion: the composer already holds a draft.
      (document) => {
        document.querySelector('#prompt-textarea')!.textContent = 'a draft the user was writing';
      }
    );
    await settle(200);

    for (let attempt = 0; attempt < 3; attempt++) {
      await live.hook.runCommand();
      await settle(200);
    }

    // One attempt, one answer. The retry loop and the `working` acks that renewed a lease
    // between attempts are gone: the page is opened for exactly one command, and what it
    // reports is final. Calling `runCommand` again — a second startup tick, a re-render — is
    // a no-op rather than a second redeem, because a repeat here would have been a second
    // bootstrap typed into the same chat.
    const acks = live.sent.filter((message) => message.type === 'ack');
    expect(acks.map((ack) => ack.status)).toEqual(['failed']);
    expect(acks[0]!.error).toBe('the composer already holds something the user was writing');
    expect(live.sent.filter((message) => message.type === 'redeem')).toHaveLength(1);
  });
});

/**
 * The context meter, and compaction that starts itself.
 *
 * Both read the same two numbers out of `/activity` — what the recording holds, and the
 * lines it is measured against. That is the point of sending them together: a bar that
 * filled against a figure of its own would show a full bar and do nothing, or compact a
 * conversation that still looked half empty.
 */
describe('the context meter and automatic compaction', () => {
  let live: Harness | null = null;

  afterEach(() => {
    live?.close();
    live = null;
  });

  /** An `/activity` answer carrying a token count and the settings it is measured against. */
  const withContext = (
    tokens: number,
    context: Record<string, unknown> | null,
    over: Record<string, unknown> = {}
  ) => ({
    ok: true,
    data: {
      entries: [],
      stream: [],
      nextSince: 0,
      pendingTools: 0,
      job: null,
      tokens,
      context,
      ...over
    }
  });

  const settings = (over: Record<string, unknown> = {}) => ({
    auto: false,
    threshold: 300_000,
    warn: 300_000,
    limit: 400_000,
    ...over
  });

  it('fills towards the limit the app already warns about while nothing acts on the count', async () => {
    live = await harness(undefined, { activity: () => withContext(200_000, settings()) });
    live.hook.injectControl();
    await live.hook.pullActivity();

    const meter = live.hook.meterView()!;
    expect(meter.filled).toBeCloseTo(0.5, 5);
    expect(meter.level).toBe('ok');
    expect(meter.tip).toContain('400k');
    // Approximate on purpose: this counts what the recording holds, which is what a brief
    // would be written from — not ChatGPT's own accounting, which the page cannot see.
    // Below the short status line, which now leads the tooltip.
    expect(meter.tip).toBe(meter.status);
  });

  it('warns amber at the advisory line and red at the limit', async () => {
    live = await harness(undefined, { activity: () => withContext(320_000, settings()) });
    live.hook.injectControl();
    await live.hook.pullActivity();
    expect(live.hook.meterView()!.level).toBe('near');

    live.reply.set('activity', () => withContext(410_000, settings()));
    await live.hook.pullActivity();
    const full = live.hook.meterView()!;
    expect(full.level).toBe('full');
    expect(full.filled).toBe(1);
  });

  /**
   * With automatic compaction on, the threshold is the number that matters, because it is
   * where something will actually happen. A bar filling towards a limit while the chat was
   * being compacted at half of it would be measuring the wrong thing.
   */
  it('fills towards the threshold instead once automatic compaction is on', async () => {
    live = await harness(undefined, {
      activity: () => withContext(100_000, settings({ auto: true, threshold: 200_000 }))
    });
    live.hook.injectControl();
    await live.hook.pullActivity();

    const meter = live.hook.meterView()!;
    expect(meter.filled).toBeCloseTo(0.5, 5);
    expect(meter.tip).toBe('100k/200k · autocompact on');
  });

  /**
   * The count, the ceiling and the switch on one line.
   *
   * The tooltip already said all three in prose, and prose is what nobody reads while they
   * are working. `283k/400k · autocompact on` is the same three facts in the shape the user
   * asked for: whether the thing is armed is as much part of the reading as the number is,
   * because 283k out of 400k means something quite different depending on the answer.
   */
  it('says the count, the ceiling and whether it is armed on one line', async () => {
    live = await harness(undefined, { activity: () => withContext(283_000, settings({ auto: true, threshold: 400_000 })) });
    live.hook.injectControl();
    await live.hook.pullActivity();

    const meter = live.hook.meterView()!;
    expect(meter.status).toBe('283k/400k · autocompact on');
    // And the line leads the tooltip, so hovering says the short thing before the long one.
    expect(meter.tip.startsWith(meter.status)).toBe(true);
  });

  it('says so on the same line when automatic compaction is off', async () => {
    live = await harness(undefined, { activity: () => withContext(283_000, settings({ auto: false })) });
    live.hook.injectControl();
    await live.hook.pullActivity();
    expect(live.hook.meterView()!.status).toBe('283k/400k · autocompact off');
  });

  it('counts towards the threshold in the status line too, once one is set', async () => {
    live = await harness(undefined, {
      activity: () => withContext(100_000, settings({ auto: true, threshold: 200_000 }))
    });
    live.hook.injectControl();
    await live.hook.pullActivity();
    expect(live.hook.meterView()!.status).toBe('100k/200k · autocompact on');
  });

  it('draws nothing when the app has sent no numbers to draw', async () => {
    live = await harness(undefined, { activity: () => withContext(0, null) });
    live.hook.injectControl();
    await live.hook.pullActivity();
    expect(live.hook.meterView()).toBeNull();
    expect((live.document.querySelector('.clf-meter') as HTMLElement).hidden).toBe(true);
  });

  it('stays off the button while a compaction is running', async () => {
    live = await harness(undefined, {
      activity: () =>
        withContext(390_000, settings(), {
          job: { sessionId: 's1', stage: 'compacting', busy: true, handoffId: null, error: null }
        })
    });
    live.hook.injectControl();
    await live.hook.pullActivity();
    // The count is still knowable; it is just no longer the question the control answers.
    expect(live.hook.meterView()).not.toBeNull();
    expect((live.document.querySelector('.clf-meter') as HTMLElement).hidden).toBe(true);
  });

  it('does not compact by itself while the switch is off', async () => {
    live = await harness(undefined, { activity: () => withContext(999_000, settings({ auto: false })) });
    live.hook.injectControl();
    await live.hook.pullActivity();
    await settle();
    expect(live.sent.filter((message) => message.type === 'compact')).toEqual([]);
  });

  it('does not compact an old chat merely because it opens above the threshold', async () => {
    live = await harness(undefined, {
      activity: () => withContext(250_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: false }),
      auto_compact_claim: () => ({ ok: true, data: { claimed: false } }),
      compact: () => ({ ok: true, data: { started: true, job: null } })
    });
    live.hook.injectControl();
    for (let poll = 0; poll < 5; poll++) await live.hook.pullActivity();

    expect(startedCompactions(live)).toEqual([]);
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toEqual([]);
  });

  it('consumes one durable crossing once, then starts Compact & Resume', async () => {
    let ready = true;
    let claimed = false;
    live = await harness(undefined, {
      activity: () => withContext(205_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: ready }),
      auto_compact_claim: () => {
        if (claimed) return { ok: true, data: { claimed: false } };
        claimed = true;
        ready = false;
        return { ok: true, data: { claimed: true } };
      },
      compact: () => ({ ok: true, data: { started: true, job: null } })
    });
    live.hook.injectControl();
    await live.hook.pullActivity();
    await settle();

    expect(startedCompactions(live)).toHaveLength(1);
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toHaveLength(1);
    for (let poll = 0; poll < 4; poll++) await live.hook.pullActivity();
    expect(startedCompactions(live)).toHaveLength(1);
  });

  it('consumes the edge without stopping a new turn that races in after the claim', async () => {
    let ready = true;
    live = await harness(undefined, {
      activity: () => withContext(205_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: ready }),
      auto_compact_claim: () => {
        ready = false;
        // The page was idle when it asked, then the user/new UI started another turn before
        // startCompact got control. Automatic compaction must never click Stop in this race.
        startGenerating(live!.document);
        return { ok: true, data: { claimed: true } };
      },
      compact: () => ({ ok: true, data: { started: true, job: null } })
    });
    live.hook.injectControl();
    await live.hook.pullActivity();
    await settle();

    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toHaveLength(1);
    expect(startedCompactions(live)).toEqual([]);
  });

  it('does not claim while local tools are still settling', async () => {
    live = await harness(undefined, {
      activity: () =>
        withContext(205_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: true, pendingTools: 1 }),
      auto_compact_claim: () => ({ ok: true, data: { claimed: true } })
    });
    live.hook.injectControl();
    await live.hook.pullActivity();
    await settle();
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toEqual([]);
  });

  /**
   * A durable edge is still not permission to interrupt an answer. The content script's
   * generation state and the app's active turn id both have to be idle before it claims.
   */
  it('waits for the crossing turn to be completely idle before claiming it', async () => {
    let ready = true;
    let claimed = false;
    live = await harness(undefined, {
      activity: () => withContext(205_000, settings({ auto: true, threshold: 200_000 }), { autoCompactReady: ready }),
      auto_compact_claim: () => {
        if (claimed) return { ok: true, data: { claimed: false } };
        claimed = true;
        ready = false;
        return { ok: true, data: { claimed: true } };
      },
      compact: () => ({ ok: true, data: { started: true, job: null } })
    }, (document) => {
      startGenerating(document);
      const section = assistantTurn(document, 'turn-auto-cross', []);
      const answer = document.createElement('div');
      answer.className = 'markdown';
      answer.textContent = 'Finished crossing the context threshold.';
      section.append(answer);
    });
    // Generating from before the script starts, so the first poll of all already sees it.
    live.hook.injectControl();
    await live.hook.pullActivity();
    await settle();
    expect(startedCompactions(live)).toEqual([]);
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toEqual([]);

    await settleTurn(live);
    await live.hook.pullActivity();
    await settle();
    expect(startedCompactions(live)).toHaveLength(1);
    expect(live.sent.filter((message) => message.type === 'auto_compact_claim')).toHaveLength(1);
  });
});

/**
 * Which answer becomes the brief.
 *
 * This is the load-bearing guarantee of Compact & Resume, and it is a guarantee about
 * identity rather than about text: the brief is the output of the one generation this tab
 * started by submitting the handoff instruction, and of no other. Not "the last assistant
 * message", not "the next thing that appears", not "the longest block on screen" — a chat
 * being compacted has been talked to for hours, and every one of those rules can be
 * satisfied by something the model wrote about something else entirely.
 *
 * So the tab binds the app's one-time token to a local generation id at the moment it
 * sends, and only that generation may hand a brief back. Every case below is a way that
 * binding could be lost or fooled, and the assertion is always one of two things: the
 * right text is delivered exactly once, or nothing is delivered at all and the transaction
 * is withdrawn — leaving the session in the chat it is already in, which is a failure the
 * user can see and press the button about.
 */
describe('binding the brief to the generation that wrote it', () => {
  const TOKEN = 'tok-capture';
  const CHAT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  /** An app that opens a compaction transaction and records what comes back. */
  const compactionReplies = (): Record<string, (message: Record<string, any>) => unknown> => ({
    compact: (message) => ({
      ok: true,
      data: message.cancel
        ? { cancelled: true }
        : { started: true, token: TOKEN, prompt: 'Write the brief …', job: null }
    })
  });

  /** The briefs this page handed the app, in order. */
  const delivered = (harnessed: Harness): Array<Record<string, any>> =>
    harnessed.sent.filter((message) => message.type === 'compact' && typeof message.summary === 'string');

  /** The withdrawals it sent instead. */
  const withdrawn = (harnessed: Harness): Array<Record<string, any>> =>
    harnessed.sent.filter((message) => message.type === 'compact' && message.cancel === true);

  /** One assistant message inside a turn, of the kind the page gives a message id. */
  function assistantProse(document: Document, section: HTMLElement, id: string, text: string): void {
    const message = document.createElement('div');
    message.setAttribute('data-message-id', id);
    message.setAttribute('data-message-author-role', 'assistant');
    const body = document.createElement('div');
    body.className = 'markdown';
    body.textContent = text;
    message.append(body);
    section.append(message);
  }

  /**
   * Presses the button and lets the compaction turn open, the way the page sees it.
   *
   * The send is what starts the generation, so the generating state goes up inside the
   * click handler — that is the race the arming exists to survive.
   */
  async function press(harnessed: Harness): Promise<void> {
    harnessed.document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
      startGenerating(harnessed.document);
    });
    await harnessed.hook.startCompact();
    harnessed.hook.observe();
    await settle();
  }

  it('delivers the settled final answer of the compaction turn, not its first words', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, compactionReplies());
    live.hook.injectControl();
    await press(live);

    // What a real compaction turn looks like: the model thinks out loud, calls something,
    // and only then writes the document. Everything but the last of those is commentary.
    const turn = assistantTurn(live.document, 'turn-brief', ['Reading the session!']);
    assistantProse(live.document, turn, 'a-1', 'Let me look at what this session did.');
    assistantProse(live.document, turn, 'a-2', 'One moment while I put this together.');
    assistantProse(live.document, turn, 'a-3', 'TASK — finish the rewrite.\nNEXT — run the tests.');
    live.hook.observe();
    await settle();
    await settleTurn(live);

    const briefs = delivered(live);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.token).toBe(TOKEN);
    expect(briefs[0]!.summary).toContain('TASK — finish the rewrite.');
    expect(briefs[0]!.summary).not.toContain('One moment while I put this together.');
    expect(withdrawn(live)).toEqual([]);
  });

  it('hands the brief over once, however many times the turn is observed', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, compactionReplies());
    live.hook.injectControl();
    await press(live);

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — finish the rewrite.');
    await settleTurn(live);

    // Everything after the first settle is a repeat: another observation, another settle
    // window, the same finished turn on screen. The binding is released before the brief
    // is sent, so there is nothing left for any of them to deliver.
    for (let again = 0; again < 3; again++) {
      live.advance(live.hook.TURN_SETTLE_MS);
      live.hook.observe();
      await settle();
    }
    expect(delivered(live)).toHaveLength(1);
  });

  it('never lets a later answer about something else become a second brief', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, compactionReplies());
    live.hook.injectControl();
    await press(live);

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — finish the rewrite.');
    live.hook.observe();
    await settle();
    await settleTurn(live);
    expect(delivered(live)).toHaveLength(1);

    // The user carries on in this chat afterwards. Nothing written later can hand the app
    // another brief for this transaction — including an answer that looks exactly like one,
    // because looking like one was never the test.
    startGenerating(live.document);
    live.hook.observe();
    await settle();
    const later = assistantTurn(live.document, 'turn-later', []);
    assistantProse(live.document, later, 'a-2', 'TASK — something else entirely.\nNEXT — do that instead.');
    live.hook.observe();
    await settle();
    await settleTurn(live);

    const briefs = delivered(live);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.summary).toContain('finish the rewrite');
  });

  /**
   * The window between submitting the instruction and seeing the turn open is the only
   * place the binding is made, and a reload inside it lands in a new document that cannot
   * reconstruct the id the old one would have used. It does not have to: the app holds the
   * open turn for this conversation, and the arming happened before the send, so an open
   * turn that is *not* the one that was stopped to make room is the one the prompt started.
   */
  it('binds a reload that landed before the turn was ever seen', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...compactionReplies(),
        // The app's answer is what tells the new document which turn is still open.
        activity: () => ({
          ok: true,
          data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null, activeTurnId: 'g-open' }
        })
      },
      (document, dom) => {
        startGenerating(document);
        dom.window.sessionStorage.setItem(
          'clf-compact-capture',
          JSON.stringify({
            token: TOKEN,
            conversationId: CHAT,
            generation: null,
            priorGeneration: 'g-before',
            armedAt: 1_700_000_000_000
          })
        );
      }
    );

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — finish the rewrite.');
    await settleTurn(live);

    const briefs = delivered(live);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.token).toBe(TOKEN);
    expect(withdrawn(live)).toEqual([]);
  });

  it('gives up rather than guess when the reload landed after the turn had finished', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...compactionReplies(),
        // Nothing open: the compaction turn ended while this tab was not there to see it.
        activity: () => ({
          ok: true,
          data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null, activeTurnId: null }
        })
      },
      (document, dom) => {
        // The answer is on screen, next to a dozen others, and nothing distinguishes it
        // but a guess — which is exactly what must not happen.
        const turn = assistantTurn(document, 'turn-brief', []);
        const message = document.createElement('div');
        message.setAttribute('data-message-id', 'a-1');
        message.setAttribute('data-message-author-role', 'assistant');
        const body = document.createElement('div');
        body.className = 'markdown';
        body.textContent = 'TASK — finish the rewrite.';
        message.append(body);
        turn.append(message);
        dom.window.sessionStorage.setItem(
          'clf-compact-capture',
          JSON.stringify({
            token: TOKEN,
            conversationId: CHAT,
            generation: null,
            priorGeneration: null,
            armedAt: 1_700_000_000_000
          })
        );
      }
    );
    await settle();

    expect(delivered(live)).toEqual([]);
    expect(withdrawn(live)).toHaveLength(1);
  });

  it('gives up when the reload interrupted a turn it had already bound', async () => {
    live = await harness(
      `https://chatgpt.com/c/${CHAT}`,
      {
        ...compactionReplies(),
        activity: () => ({
          ok: true,
          data: { entries: [], stream: [], nextSince: 0, pendingTools: 0, job: null, activeTurnId: 'g-other' }
        })
      },
      (document, dom) => {
        startGenerating(document);
        // The binding names a generation, and the turn still open is not it.
        dom.window.sessionStorage.setItem(
          'clf-compact-capture',
          JSON.stringify({
            token: TOKEN,
            conversationId: CHAT,
            generation: 'g-gone',
            priorGeneration: null,
            armedAt: 1_700_000_000_000
          })
        );
      }
    );
    await settle();

    expect(delivered(live)).toEqual([]);
    expect(withdrawn(live)).toHaveLength(1);
  });

  it('ignores a binding left behind by a different conversation', async () => {
    live = await harness(`https://chatgpt.com/c/${CHAT}`, compactionReplies(), (document, dom) => {
      startGenerating(document);
      dom.window.sessionStorage.setItem(
        'clf-compact-capture',
        JSON.stringify({
          token: TOKEN,
          conversationId: '99999999-8888-7777-6666-555555555555',
          generation: null,
          priorGeneration: null,
          armedAt: 1_700_000_000_000
        })
      );
    });

    const turn = assistantTurn(live.document, 'turn-brief', []);
    assistantProse(live.document, turn, 'a-1', 'TASK — something in a different chat.');
    await settleTurn(live);

    // Not even a withdrawal: this tab has no business touching another chat's transaction.
    expect(delivered(live)).toEqual([]);
    expect(withdrawn(live)).toEqual([]);
  });
});
