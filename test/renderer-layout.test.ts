/**
 * The desktop window's layout contract.
 *
 * The window is a fixed size and its content is a fixed set of controls, so a control
 * going missing is a layout failure rather than a styling opinion. On the installed build
 * the session card's header held the title, a three-way view switcher and three buttons in
 * one flex row, and at the window's own default width "Compact & resume" — the primary
 * action of the whole app — was pushed entirely off the right edge. Not clipped: absent.
 *
 * jsdom does no layout, so this cannot measure pixels. What it can do is hold the
 * structural rules that made the overflow possible in the first place: the actions cluster
 * must not be allowed to shrink, the title must be the thing that yields, navigation must
 * not compete with actions for the same row, and nothing anywhere may scroll sideways.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

let document: Document;
let css = '';
let chatSource = '';

beforeAll(async () => {
  const [html, styles, chat] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8')
  ]);
  document = new JSDOM(html).window.document;
  css = styles;
  chatSource = chat;
});

/** The declarations of one selector, whitespace-normalised. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : '';
}

describe('the session card header', () => {
  /**
   * A gear, and nothing that starts work. Compact & resume is pressed in the ChatGPT tab,
   * because the chat is what writes the brief — a button here would be a second way to
   * start the one thing that must happen exactly once.
   */
  it('carries the gear and no action that starts a compaction', () => {
    const header = document.querySelector('#chatTitle')!.closest('h2')!;
    const acts = header.querySelector('.acts')!;
    const gear = document.getElementById('chatSettingsBtn');
    expect(gear).not.toBeNull();
    expect(acts.contains(gear!)).toBe(true);
    for (const id of ['resumeBtn', 'compactBtn', 'cancelCompact']) {
      expect(document.getElementById(id), `#${id} is back`).toBeNull();
    }
    expect(acts.querySelectorAll('.btn.is-primary')).toHaveLength(0);
  });

  /**
   * Settings is not a view of the session the way the timeline and the compaction are;
   * it is app configuration reached from the session. It belongs on the gear.
   */
  it('reaches settings from the gear rather than from the view switcher', () => {
    const views = [...document.getElementById('chatView')!.querySelectorAll('[data-view]')].map(
      (button) => (button as HTMLElement).dataset.view
    );
    expect(views).toEqual(['timeline', 'compact']);
    // The view itself still exists — only its entry point moved.
    expect(document.querySelector('#chatBody > .view[data-view="settings"]')).not.toBeNull();
  });

  /**
   * The switcher is navigation, not an action. Sharing the row with three buttons is what
   * made the row wider than the window; giving it its own is what makes the fit provable
   * rather than a matter of how long the session title happens to be.
   */
  it('moves the view switcher out of the header row', () => {
    const header = document.querySelector('#chatTitle')!.closest('h2')!;
    const view = document.getElementById('chatView')!;
    expect(header.contains(view)).toBe(false);
    expect(view.closest('.subhead')).not.toBeNull();
    expect(view.closest('.subhead')!.previousElementSibling).toBe(header);
  });

  it('lets the title shrink and never the actions', () => {
    expect(rule('.acts')).toContain('flex: none');
    const title = rule('.card > h2 > span:first-child');
    expect(title).toContain('min-width: 0');
    expect(title).toContain('text-overflow: ellipsis');
    // The title is the first child of the header, which is what that selector relies on.
    expect(document.querySelector('#chatTitle')!.closest('h2')!.firstElementChild!.id).toBe('chatTitle');
  });

  it('has a place to say what is happening without opening the Activity log', () => {
    const note = document.getElementById('chatState')!;
    expect(note.closest('.subhead')).not.toBeNull();
    expect(rule('.subhead-note')).toContain('text-overflow: ellipsis');
  });
});

/**
 * The session list is the one surface where rows are near-identical by construction: a
 * resume and its workers are all opened within a minute of each other. Which run a row
 * belongs to, and whether its tab ever opened, are carried by chips — so the chips are
 * the part that must survive a narrow row, and the counts are the part that yields.
 */
describe('a session row', () => {
  it('keeps its chips whole and lets the counts truncate', () => {
    expect(rule('.sess-sub')).toContain('display: flex');
    expect(rule('.sess-sub .chip')).toContain('flex: none');
    const bits = rule('.sess-bits');
    expect(bits).toContain('min-width: 0');
    expect(bits).toContain('text-overflow: ellipsis');
  });

  it('never borrows live worker status from a different run that reused worker-1/worker-2', () => {
    // Worker ids are slot names and repeat every run. The conversation is the durable chat
    // identity, so both have to match before an old recorded session can show the current
    // swarm's `joined` / `finished` badge. This pins the screenshot regression where several
    // old worker-2 rows all suddenly said `joined` when one new worker-2 was active.
    expect(chatSource).toMatch(/entry\.id === origin\.agentId[\s\S]{0,220}entry\.conversationId === summary\.conversationId/);
  });
});

describe('the session-row delete affordance', () => {
  it('reserves its top-right hit target instead of laying the timestamp underneath it', () => {
    expect(rule('.sess-del')).toContain('position: absolute');
    expect(rule('.sess-top em')).toContain('margin-right: 30px');
  });
});

/**
 * Every card in this app is a grid with an explicit row for each of its children. The
 * Sessions card has three children; the session card has four, because it also carries a
 * navigation row. They shared one three-track template, so on the session card the tracks
 * landed on the wrong children: `.subhead` took the flexible `1fr` track and floated the
 * view switcher into the vertical middle of an empty card, while `.scroll` fell into an
 * implicit `auto` row sized to its whole content and painted the timeline over the header.
 *
 * jsdom does no layout, so this counts tracks against children instead of pixels. That is
 * the invariant that was actually violated, and it is checkable.
 */
describe('the chat panel cards', () => {
  /** The track list a card's own rule declares, as an array. */
  function tracks(selector: string): string[] {
    const declarations = rule(selector);
    const match = /grid-template-rows:([^;]*)/.exec(declarations);
    expect(match, `${selector} declares no grid-template-rows`).not.toBeNull();
    // minmax(0, 1fr) is one track despite its comma.
    return match![1]!.trim().replace(/minmax\([^)]*\)/g, 'minmax').split(/\s+/);
  }

  it('gives the sessions card one row per child', () => {
    const card = document.getElementById('sessionList')!.closest('.card')!;
    expect(card.classList.contains('is-session')).toBe(false);
    expect(tracks("[data-panel='chat'] .card")).toHaveLength(card.children.length);
  });

  it('gives the session card one row per child, including its navigation row', () => {
    const card = document.getElementById('chatTitle')!.closest('.card')!;
    // Header, subhead, body, foot. If a child is added, the template must grow with it.
    expect(card.children.length).toBe(4);
    expect(card.classList.contains('is-session')).toBe(true);
    expect(tracks("[data-panel='chat'] .card.is-session")).toHaveLength(card.children.length);
  });

  /**
   * The flexible track must be the scrolling body and nothing else. When it landed on
   * `.subhead`, an empty Compaction view pushed the switcher into the middle of the card.
   */
  it('gives the flexible track to the body, not to the navigation row', () => {
    const card = document.getElementById('chatTitle')!.closest('.card')!;
    const bodyIndex = [...card.children].indexOf(document.getElementById('chatBody')!);
    expect(bodyIndex).toBeGreaterThan(-1);
    const list = tracks("[data-panel='chat'] .card.is-session");
    expect(list[bodyIndex]).toBe('minmax');
    expect(list.filter((track) => track === 'minmax')).toHaveLength(1);
  });
});

/**
 * A recorded tool call is a `<details>`. A `<details>` whose `display` is changed stops
 * stacking its summary above its body and lays the two out as siblings — which is how the
 * arguments/result panel came to sit beside the row, pinned to the right edge of the card
 * and clipped. A bare `.tool` rule for the permission checkboxes was matching it.
 */
describe('an expanded tool call', () => {
  it('opens underneath its row rather than beside it', () => {
    expect(rule('.tool')).toContain('display: block');
  });

  it('does not share a selector with the permission checkboxes', () => {
    // The permission row is a `<label class="tool">` laid out in two columns, a checkbox
    // and its text. Scoping that to its container is what keeps the row's own `display`
    // off the timeline's `<details class="tool">`, whichever layout the row uses.
    expect(css).toMatch(/\n\.tools \.tool \{[^}]*display: grid/);
    expect(rule('.tool')).toContain('display: block');
  });
});

/**
 * Every recorded event kind has a row.
 *
 * `eventBody` ends in a `default` arm that renders the words "Unknown event", so a kind
 * added to the recorder and not to the renderer does not fail a build or a type check —
 * it ships, and shows the user grey placeholder rows in their own timeline. That is how
 * `agent_message` came to be unrendered: it was added to the union, written by the
 * recorder, and read by nothing in the renderer.
 *
 * Checked against the union in the shared types rather than a hand-kept list here, so the
 * next kind is covered the moment it is declared.
 */
describe('the session timeline', () => {
  it('renders every event kind the recorder can write', async () => {
    const [shared, chat] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'src', 'shared', 'session.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8')
    ]);
    const union = shared.slice(shared.indexOf('export type SessionEvent ='), shared.indexOf('export type SessionEventKind'));
    const declared = [...new Set([...union.matchAll(/\bkind: '([a-z_]+)'/g)].map((match) => match[1]!))];
    expect(declared.length).toBeGreaterThan(5);

    const body = chat.slice(chat.indexOf('function eventBody'));
    const handled = new Set([...body.slice(0, body.indexOf('\n}')).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!));
    expect(declared.filter((kind) => !handled.has(kind))).toEqual([]);
  });
});

describe('the window as a whole', () => {
  /**
   * Two panels each had a `#agentFilter`. `getElementById` only ever returns the first, so
   * the Activity panel's filter was unreachable and two modules bound handlers to the same
   * node. Ids are the app's only wiring between markup and script; duplicates are a bug.
   */
  it('has no duplicate element ids', () => {
    const seen = new Map<string, number>();
    for (const node of document.querySelectorAll('[id]')) {
      seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
    }
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
    expect(duplicates).toEqual([]);
  });

  it('never scrolls sideways', () => {
    expect(css).not.toMatch(/overflow-x:\s*(auto|scroll)/);
    expect(css).not.toMatch(/overflow:\s*(auto|scroll)\s+/);
    // The one scrolling surface in the app is vertical only.
    expect(rule('.scroll')).toContain('overflow: hidden auto');
  });
});
