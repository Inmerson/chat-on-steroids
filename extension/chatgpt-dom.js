/**
 * Everything that knows what ChatGPT's page looks like.
 *
 * This is the only file that will break when ChatGPT changes, which is why it is the
 * only file allowed to contain a selector. Every function returns a safe empty value
 * instead of throwing, so a redesign degrades the companion to "records nothing new"
 * rather than breaking the page the user is working in.
 *
 * Anchors used, in order of how directly the live page exposes them:
 *   · turn/message data-* attributes when present (data-turn-id, data-message-id,
 *     data-message-author-role, data-interrupted, data-testid)
 *   · `.markdown` for assistant prose when the current renderer supplies no assistant
 *     data-message-id; progress markdown under data-interrupted is excluded
 *   · the id #prompt-textarea on the composer
 *   · one structural tool-message class substring
 *
 * None of these are a public ChatGPT API. In the live 2026-08-15 page one logical
 * assistant request can also be split into several sections sharing data-turn-id, so
 * turns are grouped before messages, progress or tool blocks are counted. Hashed
 * CSS-module class names are never matched because they are intentionally ephemeral.
 */

var CLF_DOM = (() => {
  const TURN = 'section[data-testid^="conversation-turn"]';
  // ChatGPT has used both shapes in the live renderer: the older tool-message span
  // and, as of 2026-08-15, a display-contents row wrapping the visible tool label.
  // Keep both explicit structural anchors; hashed CSS-module names remain off limits.
  const TOOL_LEGACY = 'span[class*="tool-message"]';
  const TOOL = `${TOOL_LEGACY}, div.pointer-events-none.contents`;
  const STOP =
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], ' +
    'button[aria-label="Stop streaming"], button[aria-label="Stop generating"]';
  const SEND = 'button[data-testid="send-button"], form button[aria-label^="Send" i]';

  const safe = (fn, fallback) => {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  };

  const text = (node, cap = 200_000) =>
    node ? (node.textContent || '').replace(/ /g, ' ').trim().slice(0, cap) : '';

  /**
   * ChatGPT sometimes renders transport failures inside the same `.markdown` shape as
   * a final assistant answer. Treating "Message delivery timed out … Retry" as model
   * prose makes a broken/reloaded turn look completed. role=alert remains the primary
   * signal; these are narrow fallbacks for failure copy observed on the live site.
   */
  function transportFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    return /(?:message delivery timed out|unknown error occurred|there was an error generating (?:a|the) response|error in message stream|network error|something went wrong)/i.test(line);
  }

  /** The conversation this tab is on, or null for a chat that has not been sent yet. */
  function conversationId() {
    return safe(() => {
      const match = /^\/c\/([0-9a-f-]{8,64})/i.exec(location.pathname);
      return match ? match[1] : null;
    }, null);
  }

  /**
   * Logical conversation turns, newest last.
   *
   * ChatGPT can render one assistant request as several sibling `section` elements
   * carrying the same data-turn-id. Treating each section as a turn makes a five-call
   * request look like several partial requests, so every one fails content.js's
   * one-block-per-call safety check and the page is left with a wall of "Called tool".
   * Group only sections that explicitly share role + id; id-less sections stay
   * independent because merging those would be a guess.
   */
  function turns() {
    return safe(() => {
      const out = [];
      const byKey = new Map();
      for (const node of document.querySelectorAll(TURN)) {
        const id = node.getAttribute('data-turn-id');
        const role = node.getAttribute('data-turn');
        const key = id ? `${role || ''}:${id}` : null;
        if (key && byKey.has(key)) {
          byKey.get(key).nodes.push(node);
          continue;
        }
        const turn = { node, nodes: [node], id, role };
        out.push(turn);
        if (key) byKey.set(key, turn);
      }
      return out;
    }, []);
  }

  const turnNodes = (turn) =>
    turn && Array.isArray(turn.nodes) && turn.nodes.length > 0 ? turn.nodes : turn && turn.node ? [turn.node] : [];

  /**
   * Visible messages, newest last.
   *
   * textContent rather than innerText on purpose: a long user message is visually
   * clamped by ChatGPT, and the clamped part is exactly the part a five-hour session
   * cannot afford to lose.
   */
  function messages() {
    return safe(() => {
      const out = [];
      const seen = new Set();
      for (const [index, turn] of turns().entries()) {
        const nodes = turnNodes(turn);
        let explicit = 0;
        for (const section of nodes) {
          for (const node of section.querySelectorAll('[data-message-id]')) {
            const id = node.getAttribute('data-message-id');
            if (!id || seen.has(id)) continue;
            const role = node.getAttribute('data-message-author-role') || turn.role;
            if (role !== 'user' && role !== 'assistant') continue;
            seen.add(id);
            explicit++;
            out.push({
              id,
              role,
              text: text(node),
              turnId: turn.id,
              interrupted: interrupted(turn)
            });
          }
        }

        // The current ChatGPT renderer no longer gives streaming assistant prose a
        // data-message-id. Final prose is still exposed as `.markdown`; live progress
        // prose is also `.markdown`, but lives under `[data-interrupted]`. Only use the
        // fallback when there is no explicit assistant message and only collect
        // markdown outside progress/tool containers. content.js itself waits until the
        // turn has stopped generating before recording this as the final answer.
        if (turn.role === 'assistant' && explicit === 0) {
          const parts = [];
          for (const section of nodes) {
            for (const markdown of section.querySelectorAll('.markdown')) {
              if (markdown.closest && markdown.closest('[data-interrupted]')) continue;
              if (markdown.closest && markdown.closest(TOOL)) continue;
              const value = text(markdown);
              if (value && parts[parts.length - 1] !== value) parts.push(value);
            }
          }
          if (parts.length > 0) {
            const value = parts.join('\n\n');
            if (!transportFailure(value)) {
              out.push({
                id: `assistant:${turn.id || index}`,
                role: 'assistant',
                text: value,
                turnId: turn.id,
                interrupted: interrupted(turn)
              });
            }
          }
        }
      }
      return out;
    }, []);
  }

  /** True while ChatGPT is producing a turn. The stop button is the honest signal. */
  function generating() {
    return safe(() => document.querySelector(STOP) !== null, false);
  }

  function stopButton() {
    return safe(() => document.querySelector(STOP), null);
  }

  /**
   * The live progress line of a turn.
   *
   * ChatGPT keeps its running commentary inside the block it also marks with
   * data-interrupted, so that attribute doubles as the anchor for both.
   */
  function progressLine(turn) {
    return safe(() => {
      let latest = null;
      for (const section of turnNodes(turn)) {
        for (const box of section.querySelectorAll('[data-interrupted]')) {
          const lines = (box.innerText || box.textContent || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.length > 0) latest = lines[lines.length - 1].slice(0, 400);
        }
      }
      return latest;
    }, null);
  }

  function interrupted(turn) {
    return safe(
      () => turnNodes(turn).some((section) => section.querySelector('[data-interrupted="true"]') !== null),
      false
    );
  }

  /** Marks ChatGPT's own progress/reasoning containers so our CSS can make them legible. */
  function markProgress(turn) {
    return safe(() => {
      let marked = 0;
      for (const section of turnNodes(turn)) {
        for (const box of section.querySelectorAll('[data-interrupted]')) {
          if (!box.hasAttribute('data-clf-progress')) marked++;
          box.setAttribute('data-clf-progress', '1');
        }
      }
      return marked;
    }, 0);
  }

  /** The tool-call blocks of one logical turn, across every split section, in DOM order. */
  function toolBlocks(turn) {
    return safe(
      () =>
        turnNodes(turn).flatMap((section) => {
          const current = [...section.querySelectorAll(TOOL)];
          return current.length > 0 ? current : [...section.querySelectorAll(TOOL_LEGACY)];
        }),
      []
    );
  }

  /**
   * The single text node inside a tool block that reads "Called tool".
   *
   * Found structurally — the first text-bearing leaf of the block's header button —
   * rather than by matching the English string, so it also works in other languages.
   */
  function toolLabel(block) {
    return safe(() => {
      const marked = block.querySelector('[data-clf-label]');
      if (marked) return marked;
      const header = block.querySelector('button') || block;
      for (const node of header.querySelectorAll('*')) {
        if (node.children.length === 0 && (node.textContent || '').trim().length > 0) {
          node.setAttribute('data-clf-label', '1');
          return node;
        }
      }
      return null;
    }, null);
  }

  /** Visible error banners plus narrowly recognised transport-failure markdown. */
  function errors() {
    return safe(() => {
      const out = [...document.querySelectorAll('[role="alert"]')]
        .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((value) => value.length > 2 && value.length < 500);
      for (const turn of turns()) {
        if (turn.role !== 'assistant') continue;
        for (const section of turnNodes(turn)) {
          for (const markdown of section.querySelectorAll('.markdown')) {
            const value = text(markdown, 500).replace(/\s+/g, ' ').trim();
            if (value && transportFailure(value) && !out.includes(value)) out.push(value);
          }
        }
      }
      return out;
    }, []);
  }

  function composer() {
    return safe(() => document.querySelector('#prompt-textarea'), null);
  }

  /** Types into the composer. Refuses if the user already has a draft there. */
  function insertPrompt(value) {
    return safe(() => {
      const box = composer();
      if (!box) return false;
      if ((box.textContent || '').trim() !== '') return false;
      box.focus();
      // execCommand still produces the native editing path ChatGPT listens for. Newer
      // composer builds occasionally ignore its return value, so verify the DOM and
      // also emit input so React cannot miss the mutation.
      document.execCommand('insertText', false, value);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return (box.textContent || '').trim().length > 0;
    }, false);
  }

  function send() {
    return safe(() => {
      const button = document.querySelector(SEND);
      if (button && !button.disabled) {
        button.click();
        return true;
      }
      const box = composer();
      if (!box) return false;
      const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      box.dispatchEvent(new KeyboardEvent('keydown', key));
      box.dispatchEvent(new KeyboardEvent('keyup', key));
      return true;
    }, false);
  }

  return {
    conversationId,
    turns,
    messages,
    generating,
    stopButton,
    progressLine,
    interrupted,
    markProgress,
    toolBlocks,
    toolLabel,
    errors,
    composer,
    insertPrompt,
    send
  };
})();
