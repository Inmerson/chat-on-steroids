/**
 * The only code this extension runs in ChatGPT's own JavaScript context.
 *
 * It exists for one reason: a collapsed connector row shows the word "Called tool" and
 * nothing else, but the React Fiber behind it already knows exactly which tool ran, under
 * which connector, and how many further calls that single row is standing in for. That
 * last part is why this file has to exist at all — the page renders one row for a run of
 * calls, not always to the same tool, so the visible rows are not a list of the calls, and
 * no amount of DOM reading from the isolated world can recover the ones it folded away.
 *
 * Everything here is written on the assumption that it is the least trusted code in the
 * extension:
 *
 *  · **It runs where the page can reach it.** ChatGPT could replace `JSON.parse`,
 *    `postMessage`, `Array.prototype.map` — anything this file touches. Native references
 *    are captured at load, before the page has had a chance to react to us, and the file
 *    is kept short so there is little to subvert.
 *  · **It emits an allowlist, never a filtered copy.** Only the named fields below cross
 *    into the extension. Copying the props and deleting the sensitive parts would be a
 *    denylist, and one renamed field would be a leak — the request JSON has been observed
 *    carrying tool arguments verbatim.
 *  · **It emits no argument values at all, and does not even parse them.** Tool arguments
 *    are the user's own text and this app's own secrets, and there is no key-level
 *    allowlist that generalises across tools. The request payload is never handed to
 *    `JSON.parse`; only the tool path anchored at the very front of it is read, so `args`
 *    is never walked at all. The tool's identity is what relabelling actually needs; the
 *    app already knows the arguments for every call it ran itself.
 *  · **It fails closed.** An unrecognised Fiber shape yields `null` for that row, which
 *    leaves the row exactly as ChatGPT drew it. Guessing would put a wrong tool name on a
 *    real call, which is worse than the generic label it replaced.
 *
 * The receiving side treats everything here as page-controlled evidence regardless: the
 * page can post these same messages itself. See the trust note in content.js.
 */

(() => {
  'use strict';

  /** Bumped when the descriptor shape changes, so a stale pair cannot half-understand. */
  const VERSION = 4;
  const ASK = 'clf-fiber-ask';
  const REPLY = 'clf-fiber-reply';
  /** The control ChatGPT puts in a connector tool row and nowhere else. */
  const CONNECTOR = '[aria-label="Open tool call list" i]';
  /**
   * A runaway guard on the climb, not a claim about how the page is shaped.
   *
   * This was 30, taken from an observed depth, and the live page put the group node at
   * exactly 30 — one past `up < MAX_CLIMB`. Every row of every chat then produced no
   * descriptor at all, silently, because failing closed is indistinguishable from a
   * browser where this helper never ran. What stops the climb now is `groupOf`'s own test
   * for the shape it wants; this number only keeps a detached or cyclic tree from looping.
   */
  const MAX_CLIMB = 80;
  const MAX_TEXT = 200;
  /** A page with more connector rows than this is not one we need to read exhaustively. */
  const MAX_ROWS = 400;
  /** Assistant turns whose message model is read for per-call evidence, newest first. */
  const MAX_TURNS = 6;
  /** Connector requests reported for one turn. Far above any real turn's call count. */
  const MAX_CALLS = 200;
  /** ChatGPT's own assistant turn sections, which is where a turn's message model hangs. */
  const TURN_SECTION = 'section[data-testid^="conversation-turn"][data-turn-id]';
  /**
   * The connectors this app is reached through. Nothing else is ours to vouch for.
   *
   * There is more than one now: 1.7.1 split the model-facing surface into a Core and a
   * Desktop connector, so a single hardcoded name stopped matching *anything* the page
   * held — every call in every chat lost its page evidence at once and was filed outside
   * the conversation that made it. The name is not user input: ChatGPT takes `app_name`
   * from the `resource_name` this app serves in its own protected-resource metadata
   * (`server.ts`), so these are this app naming itself rather than labels somebody typed.
   * The pre-1.7.1 name stays so an older chat's evidence still reads.
   *
   * Exact names, never a prefix: `ChatGPT Local Files Backup` would be somebody else's
   * connector, and a prefix test would have this app vouch for its traffic.
   */
  const OUR_APPS = ['ChatGPT Local Files Core', 'ChatGPT Local Files Desktop', 'TobisComputer'];

  /** Whether an `invoked_resource.app_name` names one of this app's own connectors. */
  function ourApp(name) {
    if (typeof name !== 'string') return false;
    for (let at = 0; at < OUR_APPS.length; at++) if (OUR_APPS[at] === name) return true;
    return false;
  }

  /** Whether a request path — `/<connector>/link_…/<tool>` — is one of ours. */
  function ourPath(path) {
    if (typeof path !== 'string' || path.charCodeAt(0) !== 47) return false;
    const end = path.indexOf('/', 1);
    return end > 1 && ourApp(path.slice(1, end));
  }
  /**
   * The tool path at the very front of a request payload.
   *
   * Anchored, and it stops at the first quote, so it can only ever see the path — never a
   * key or value from `args`, including the `path` argument a file tool takes, which is a
   * second `"path"` later in the same string.
   */
  const PATH_HEAD = /^\s*\{\s*"path"\s*:\s*"([^"\\]{1,200})"/;
  /** A tool name we are willing to put on a row. */
  const NAME = /^[a-z0-9_.-]{1,64}$/i;

  // Captured before the page can swap them. If the page has already replaced one of these
  // at load time there is nothing to be done about it, but it cannot do so afterwards.
  const post = window.postMessage.bind(window);
  const own = Object.prototype.hasOwnProperty;

  /** A short, plain string or null. Never a number, object, or anything with a toString. */
  function str(value) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null;
  }

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function int(value) {
    const raw = num(value);
    return raw === null ? 0 : Math.max(0, Math.min(999, Math.round(raw)));
  }

  /**
   * The React Fiber node for a DOM element.
   *
   * React hangs it off a property whose name carries a per-build random suffix, so the
   * key has to be discovered rather than named.
   */
  function fiberOf(node) {
    for (const key in node) {
      if (key.charCodeAt(0) === 95 && key.indexOf('__reactFiber$') === 0) return node[key];
    }
    return null;
  }

  /**
   * The props of the node that renders exactly this row's group of messages.
   *
   * Two shapes are reachable by climbing from a row, and only one of them may be used.
   * The near one — observed live at depth 30 — carries `messages`, where `messages[0]` is
   * this row's own request and everything after it is other rows' business. The far one,
   * around depth 43, carries `allMessages`/`turn` for the *whole* turn; reading a row's
   * identity out of that means picking one of a turn's many requests by position, which is
   * how a row ends up labelled with a neighbour's tool. So the turn-level node is not a
   * fallback, it is a stop: reaching it means this row's group was not found, and a row
   * with no group keeps the label ChatGPT gave it.
   */
  function groupOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (Array.isArray(props.allMessages) || (props.turn && typeof props.turn === 'object')) return null;
      if (Array.isArray(props.messages) && props.messages.length > 0) return props;
    }
    return null;
  }
  /**
   * The complete message list for this logical turn, read separately from the row group.
   *
   * Row identity must never come from this list because it contains many requests. For
   * attribution cardinality, though, that is exactly the useful property: it lets us count
   * how many requests in the turn actually target TobisComputer instead of treating
   * ChatGPT's folded-row count as if api_tool metadata calls were local MCP calls.
   */
  function turnMessagesOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn;
      if (turn && typeof turn === 'object' && Array.isArray(turn.messages)) return turn.messages;
      if (Array.isArray(props.allMessages)) return props.allMessages;
    }
    return null;
  }

  /**
   * The connector request this row stands for, or null if `message` is not one.
   *
   * A connector request is an assistant message whose `recipient` names the API tool
   * bridge. The tool is at the front of its content, which is *nearly* JSON: the live page
   * stores the payload truncated — `Unterminated string in JSON at position 741` on a
   * routine call — so parsing it fails on most rows, and the old fallback of naming the row
   * after the recipient turned every one of those into `call_tool`, a tool this app does
   * not have. The path is read off the front of the string instead, which survives the
   * truncation because it is the first field, and nothing else in the payload is looked at.
   */
  function requestOf(message) {
    if (!message || typeof message !== 'object') return null;
    const author = message.author;
    if (!author || author.role !== 'assistant') return null;
    const recipient = str(message.recipient);
    if (!recipient || recipient.indexOf('api_tool') !== 0) return null;

    let path = null;
    const text = message.content && message.content.text;
    if (typeof text === 'string' && text.length > 0) {
      const head = PATH_HEAD.exec(text);
      if (head) path = str(head[1]);
    }

    // ChatGPT stamps every connector request with its own request id, and the same id
    // reaches the app on the MCP request itself — a deterministic join between the page and
    // the call, so two workers calling one tool at once need no timing heuristic to tell
    // apart. Allowlisted like everything else here — an opaque id, never arguments.
    const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    return {
      path,
      messageId: str(message.id),
      requestId: meta ? str(meta.request_id) : null,
      createTime: num(message.create_time)
    };
  }

  /** "/ChatGPT Local Files Core/link_…/read" -> "read", or null if that is not a name. */
  function toolName(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const tail = value.slice(value.lastIndexOf('/') + 1);
    return NAME.test(tail) ? tail : null;
  }

  /**
   * The tool a row ran, from both sources or neither.
   *
   * The request names it and so does the result — `invoked_resource.resource_uri`, which
   * is structured and needs no parsing. Where both are readable they must agree: two
   * sources naming different tools means the pairing is wrong, and a row labelled with the
   * wrong tool is worse than one left saying "Called tool". Where only one is readable it
   * is used, because an unanswered call has no result yet and a truncated payload has no
   * path.
   */
  function identify(request, result) {
    const asked = toolName(request.path);
    const answered = result ? toolName(result.resource) : null;
    if (asked && answered) return asked === answered ? asked : null;
    return asked || answered;
  }

  /** The connector a result came back through, and whether it came back at all. */
  function resultOf(message) {
    if (!message || typeof message !== 'object') return null;
    const meta = message.metadata;
    const resource = meta && meta.invoked_resource;
    if (!resource || typeof resource !== 'object') return null;
    return { app: str(resource.app_name), resource: str(resource.resource_uri) };
  }
  /** Exact number of this app's own invocations represented by the whole turn, or null. */
  function localCountOf(messages) {
    if (!Array.isArray(messages)) return null;
    const ids = [];
    let anonymous = 0;
    const remember = (id) => {
      if (!id) {
        anonymous += 1;
        return;
      }
      for (let at = 0; at < ids.length; at++) if (ids[at] === id) return;
      ids.push(id);
    };

    for (let at = 0; at < messages.length; at++) {
      const message = messages[at];
      const request = requestOf(message);
      if (request && ourPath(request.path)) {
        remember(request.messageId);
      }

      const result = resultOf(message);
      if (result && ourApp(result.app)) {
        const meta = message && typeof message === 'object' ? message.metadata : null;
        remember(meta && typeof meta === 'object' ? str(meta.parent_id) : null);
      }
    }
    return Math.min(999, ids.length + anonymous);
  }

  /**
   * One row's descriptor, or null when the shape is not the one we know.
   *
   * The representative call is `messages[0]` — the group's own request, and the one whose
   * name the row shows. It is also the *last* call of what the row stands for: ChatGPT's
   * own "Open tool call list" for a turn that ran five calls showed four rows whose
   * requests were calls two to five, with call one folded under the first row.
   *
   * The result is found by `parent_id`, never by position. Everything after `messages[0]`
   * is a result, but only the one whose `metadata.parent_id` is this request's id answered
   * *this* call; the rest are chained to requests that are not in this array at all.
   * Taking the nearest one instead — which is what scanning forward does — pairs a row with
   * whatever came back next, and that is the live symptom of a row headed `Search files`
   * sitting over another tool's output.
   */
  function describe(row, index) {
    const fiber = fiberOf(row);
    if (!fiber) return null;

    const group = groupOf(fiber);
    if (!group) return null;

    const turnMessages = turnMessagesOf(fiber);
    const localCount = localCountOf(turnMessages);
    const messages = group.messages;
    const request = requestOf(messages[0]);
    if (!request) return null;

    let result = null;
    if (request.messageId) {
      // An index loop and no array method: this walks page-owned data, and the page can
      // replace Array.prototype.find but it cannot replace the language.
      for (let at = 1; at < messages.length && result === null; at++) {
        const message = messages[at];
        const meta = message && typeof message === 'object' ? message.metadata : null;
        if (meta && typeof meta === 'object' && str(meta.parent_id) === request.messageId) {
          result = resultOf(message);
        }
      }
    }

    /**
     * How many calls the row shows in place of, as the page counts them.
     *
     * Presentation cardinality and nothing else. The prop is named for a run of calls to
     * the same tool, but the live page folds different tools together — `list_resources`
     * under one `agents` call — so it says how many the row stands for, never which.
     */
    const hidden = int(own.call(group, 'collapsedSameToolCallCount') ? group.collapsedSameToolCallCount : null);
    const turnId = str(group.turnId);

    return {
      v: VERSION,
      index,
      tool: identify(request, result),
      path: request.path,
      app: result ? result.app : null,
      resource: result ? result.resource : null,
      messageId: request.messageId,
      turnId,
      conversationId: str(group.clientThreadId) || str(group.conversationId),
      createTime: request.createTime,
      hidden,
      // Turn-wide cardinality only. No request arguments or message bodies cross worlds.
      localCount,
      /** Whether the page has shown a result for the representative call yet. */
      answered: result !== null
    };
  }

  /**
   * Every connector request this turn issued, one entry per call.
   *
   * This is the evidence the app's attribution was missing, and it was here the whole time.
   * The visible rows are a *rendering* of these messages: ChatGPT folds a run of calls into
   * one row and on a fast turn draws no row at all until well after the call was answered,
   * so counting rows counts fewer calls than the turn made. Everything the row count could
   * not account for was then filed outside the chat that made it — a single conversation
   * splitting itself into its real session plus a permanently growing pile of unattributed
   * work. The message list does not fold: each request is its own message, with its own id
   * and its own tool path, whatever the renderer decides to draw.
   *
   * Restricted to this app's own connector. A Gmail or Calendar request in the same turn is
   * some other integration's business, and vouching for it would put a stranger's call into
   * this app's session — the precise false match that made a bare connector row weak
   * evidence in the first place.
   *
   * The allowlist is the same one everything else here obeys, and is if anything tighter:
   * a message id, a tool name derived from the front of the path, the position in the turn
   * and whether a result has come back. No argument values, no result bodies, no reasoning,
   * no whole objects. `content.text` is never parsed — only the anchored path is read off
   * the front of it, exactly as `requestOf` already does.
   */
  function callsOf(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    const seen = [];
    const answered = [];
    // Results first, so a request can say whether its own answer has arrived. `parent_id`
    // is what pairs them; position does not, and pairing by position is how a row came to
    // sit over another tool's output.
    for (let at = 0; at < messages.length && answered.length < MAX_CALLS; at++) {
      const message = messages[at];
      const result = resultOf(message);
      if (!result || !ourApp(result.app)) continue;
      const meta = message && typeof message === 'object' ? message.metadata : null;
      const parent = meta && typeof meta === 'object' ? str(meta.parent_id) : null;
      if (parent) answered.push(parent);
    }

    const duplicated = [];
    for (let at = 0; at < messages.length && out.length < MAX_CALLS; at++) {
      const request = requestOf(messages[at]);
      if (!request || !ourPath(request.path)) continue;
      const tool = toolName(request.path);
      const id = request.messageId;
      if (!tool || !id) continue;
      // An id reported twice is an ambiguity, not a second call, and it is dropped on
      // *both* sides: keeping the first would still hand the app one identity standing
      // for two different requests, which is the same piece of evidence spent twice.
      for (let seenAt = 0; seenAt < seen.length; seenAt++) if (seen[seenAt] === id) duplicated.push(id);
      seen.push(id);
      let hasResult = false;
      for (let ansAt = 0; ansAt < answered.length; ansAt++) if (answered[ansAt] === id) hasResult = true;
      out.push({
        messageId: id,
        tool,
        order: 0,
        answered: hasResult,
        // ChatGPT's own id for the request, and its own timestamp for when the request was
        // created. The app's existing stamp is when the *extension* observed the row, which
        // is a poll tick and jitters per tab; these are the only values on either side that
        // say which request this is and when it was actually issued.
        requestId: request.requestId || null,
        createTime: request.createTime
      });
    }

    const kept = [];
    for (let at = 0; at < out.length; at++) {
      let bad = false;
      for (let badAt = 0; badAt < duplicated.length; badAt++) if (duplicated[badAt] === out[at].messageId) bad = true;
      if (bad) continue;
      out[at].order = kept.length;
      kept.push(out[at]);
    }
    return kept;
  }

  /**
   * The per-turn call evidence for the assistant turns currently on screen.
   *
   * Read from the turn sections rather than from the connector rows, because the case this
   * exists for is the turn that rendered *no* row: climbing from a row cannot reach a turn
   * that has none, which is exactly the turn whose calls went missing.
   */
  function turnsOf() {
    const out = [];
    let sections;
    try {
      sections = document.querySelectorAll(TURN_SECTION);
    } catch {
      return out;
    }
    const first = Math.max(0, sections.length - MAX_TURNS);
    for (let at = first; at < sections.length; at++) {
      const section = sections[at];
      let entry = null;
      try {
        const fiber = fiberOf(section);
        if (!fiber) continue;
        const calls = callsOf(turnMessagesOf(fiber));
        if (calls.length === 0) continue;
        entry = { turnId: str(section.getAttribute('data-turn-id')), calls };
      } catch {
        // One unreadable turn must not cost the others their evidence.
        entry = null;
      }
      if (entry && entry.turnId) out.push(entry);
    }
    return out;
  }

  /**
   * Answers a request from the isolated world.
   *
   * The rows are stamped with their index before the reply is sent, so the two worlds
   * agree on which descriptor belongs to which row without relying on both querying the
   * DOM at the same instant — React can re-render between the two.
   */
  function scan(nonce) {
    const rows = [];
    let turns = [];
    try {
      turns = turnsOf();
    } catch {
      turns = [];
    }
    let found;
    try {
      found = document.querySelectorAll(CONNECTOR);
    } catch {
      return post({ source: REPLY, nonce, v: VERSION, rows: [], turns }, location.origin);
    }
    const limit = Math.min(found.length, MAX_ROWS);
    for (let index = 0; index < limit; index++) {
      const row = found[index];
      let descriptor = null;
      try {
        descriptor = describe(row, index);
      } catch {
        // One unreadable row must not cost the rest of the page its labels.
        descriptor = null;
      }
      try {
        row.setAttribute('data-clf-fiber', String(index));
      } catch {
        // If the page will not take the marker, the descriptor is unusable: drop it
        // rather than let the other side match it to a row by position.
        descriptor = null;
      }
      if (descriptor) rows.push(descriptor);
    }
    post({ source: REPLY, nonce, v: VERSION, rows, turns }, location.origin);
  }

  window.addEventListener('message', (event) => {
    // Only this window, only our own request shape. Anything else is not ours to answer.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== ASK) return;
    const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 64) : '';
    if (!nonce) return;
    try {
      scan(nonce);
    } catch {
      try {
        post({ source: REPLY, nonce, v: VERSION, rows: [], turns: [] }, location.origin);
      } catch {
        // Nothing further to try. The other side times out and keeps ChatGPT's labels.
      }
    }
  });
})();
