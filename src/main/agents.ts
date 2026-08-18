/**
 * The multi-agent broker.
 *
 * Experimental and disabled by default. One ChatGPT conversation is the prime agent; it
 * spawns workers, each of which is a separate ChatGPT tab the extension opens. All state
 * lives here, in this app: the browser only opens tabs and types the first message.
 *
 * ## One run, bound to one conversation
 *
 * There is at most one run at a time, and a run *is* its prime conversation. The prime is
 * established by exactly one event — a successful `spawn` from a ChatGPT conversation this
 * app has proven the call came from — and `primeConversationId` never changes afterwards
 * except through the app's own authenticated Compact & Resume transfer. Nothing infers a
 * prime, nothing promotes one, nothing takes one over, and no chat becomes prime as a side
 * effect of anything else it does.
 *
 * That makes every other question a lookup rather than a guess:
 *
 *   · a call from `primeConversationId` is the prime;
 *   · a call from a worker's bound conversation is that worker;
 *   · every other conversation is a stranger, and while a run exists it is told
 *     `AGENTS_BUSY` and nothing else — never the run's contents.
 *
 * ## Why spawn is atomic
 *
 * `spawn` used to create workers and then work out who the prime was, which is how a chat
 * that was not the prime ended up owning worker chats. Here the order is fixed and every
 * step that can fail happens before the first mutation: prove the caller's conversation →
 * check it is not a worker → check no other run holds the swarm → claim it as prime →
 * create workers. If anything before the binding fails, zero workers exist.
 *
 * ## Why nobody holds a credential
 *
 * Every agent here is identified by *where it is*, and only by that. The prime is the
 * conversation the user is sitting in; a worker is the conversation this app opened for its
 * slot and watched itself open. Making a model carry a bearer secret through every tool call
 * put a routing token in the transcript for roles that a conversation id already names, and
 * a token the model has to remember is a token it can forget, paste into the wrong chat, or
 * have stripped by ChatGPT's own harness.
 *
 * ## A worker is a worker before it speaks
 *
 * The lifecycle transition is the app's, not the model's. The extension opens the tab, learns
 * its exact `/c/<id>`, and reports it; {@link bindConversation} binds *and activates* the slot
 * in one step, before the model in that chat has said anything. So the first user message in
 * a worker chat is the task itself — there is no handshake to perform, no key to quote, and
 * nothing a worker has to do before it can start working.
 *
 * ## What is left of `join`
 *
 * One emergency. If that report never arrived — the app restarted between opening the tab and
 * hearing back, say — the slot is unbound and the chat doing the work is a stranger. `join`
 * with the slot's one-time key is the manual way back, and it is spent on use. It is never
 * part of a normal startup, and the key is never handed to the model: it is minted when a
 * bootstrap goes out and written to the app's own log, where the user can find it.
 *
 * Join keys are held as hashes, so a run survives a restart without this app ever keeping the
 * plaintext, and each is registered with agent-secrets.ts so it is scrubbed out of anything
 * durable.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AgentInfo, AgentMessage, AgentState, SwarmState } from '../shared/session.js';
import { forgetAgentSecrets, registerAgentSecret } from './agent-secrets.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { inheritWorkspace } from './workspace.js';

export const PRIME_ID = 'prime';

/**
 * Unacknowledged messages held per agent before the broker pushes back.
 *
 * Reached only if an agent stops calling tools entirely while the other side keeps talking.
 * Dropping the oldest to make room quietly destroyed exactly the messages most likely to
 * matter while still telling the sender "Sent", so the limit is a refusal instead.
 */
const MAX_QUEUE = 200;
export const MAX_MESSAGE_CHARS = 4000;
const MAX_TASK_CHARS = 4000;
const MAX_LABEL_CHARS = 60;

/**
 * How long a Compact & Resume handover may stay open before the prime binding is released.
 *
 * The handover is the only window in which `primeConversationId` moves, so it is deliberately
 * short-lived: an unfinished one must not leave the run transferable to whatever chat opens
 * next, and an abandoned one must eventually let the prime's disappearance end the run.
 */
export const TRANSFER_TTL_MS = 10 * 60_000;

export class AgentError extends Error {}

/** Raised at every `agents` action reached from a conversation outside the active run. */
export class AgentsBusyError extends AgentError {
  constructor() {
    super(
      'AGENTS_BUSY: another ChatGPT conversation is already running the one sub-agent swarm this app supports. ' +
        'Nothing about that run is visible from here. Wait for it to finish, or ask the user to press Clear swarm ' +
        'in ChatGPT Local Files.'
    );
  }
}

/**
 * Raised when a call meant for the run could not be placed in any conversation.
 *
 * Every identity here is a conversation, so a call this app cannot place is a call it cannot
 * attribute — and the answer to that is to say so, not to accept a key the model is carrying
 * instead. In practice this is a page whose extension is not reporting: the fix is in the
 * browser, and the message says where to look.
 */
export class IdentityLostError extends AgentError {
  constructor() {
    super(
      'WORKER_IDENTITY_LOST: ChatGPT Local Files could not tell which conversation this call came from, so it cannot ' +
        'act on the run from here. Check that the extension is connected in this tab and try once more. If this chat ' +
        'was opened as a worker and never took up its slot, the user can recover it with agents action=join and the ' +
        'recovery key from the app log.'
    );
  }
}

/**
 * An agent that will not act again, whichever way it ended.
 *
 * `finished` and `failed` differ only in what the user is told. Everything that asks "is
 * this run still going", "may this worker still be messaged", "does this worker still owe
 * us a tab" wants both.
 */
export function isOver(state: AgentState): boolean {
  return state === 'finished' || state === 'failed';
}

interface Agent {
  info: AgentInfo;
  queue: AgentMessage[];
  /**
   * sha256 of the one-time emergency recovery key.
   *
   * Never part of a normal startup: the extension tells this app which conversation it
   * opened for which worker, and that report is what activates the slot. The key exists for
   * the one case that cannot recover otherwise — the report never arrived — and it is spent
   * on use.
   */
  joinKeyHash: string | null;
}

/**
 * The single run, or null.
 *
 * `primeConversationId` is immutable for the lifetime of a run except through
 * {@link commitPrimeTransfer}, which is only ever reached from the commit step of the app's
 * own Compact & Resume session rebind.
 */
interface Run {
  runId: string;
  primeConversationId: string;
  startedAt: number;
  agents: Map<string, Agent>;
  /**
   * An open Compact & Resume handover, at most one.
   *
   * Bookkeeping only: the authority is the session layer's continuation transaction, and
   * this just records that the prime chat is expected to go away right now.
   *
   * `frozen` is what makes the commit safe. A handover expires while it is merely *open* —
   * an abandoned one must not leave the run transferable forever — but the session layer
   * freezes it before it starts the durable write, so time spent on disk can never turn a
   * preflighted handover into an expired one and split the session from its swarm.
   */
  transfer: { from: string; at: number; frozen: boolean } | null;
}

let run: Run | null = null;

let spawnRequest: ((workers: WorkerSpawn[]) => void) | null = null;
const listeners = new Set<() => void>();
const endListeners = new Set<(reason: string, retired: RetiredChat[]) => void>();
let persist: (() => void) | null = null;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const mintKey = (): string => randomBytes(24).toString('base64url');

// ------------------------------------------------------------------ listeners

export function onSwarmChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  persist?.();
  for (const listener of listeners) listener();
}

/** The store registers here so the broker needs to know nothing about files. */
export function onSwarmPersist(handler: (() => void) | null): void {
  persist = handler;
}

/**
 * Called when a run ends, for any reason.
 *
 * The bridge listens so worker bootstraps queued for the run that just ended are cancelled
 * in the same tick; without it the browser kept opening tabs for workers of a swarm that no
 * longer existed.
 */
export function onSwarmEnd(listener: (reason: string, retired: RetiredChat[]) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

/** A worker chat that was still going when its run ended. */
interface RetiredChat {
  id: string;
  conversationId: string;
}

/** A worker whose chat still has to be opened. Carries no credential. */
export interface WorkerSpawn {
  id: string;
  task: string;
}

/** Workers that exist but have not joined: their chat is still owed. */
export function pendingWorkerSpawns(): WorkerSpawn[] {
  if (!run) return [];
  return [...run.agents.values()]
    .filter((agent) => agent.info.role === 'worker' && agent.info.state === 'invited')
    .map((agent) => ({ id: agent.info.id, task: agent.info.task }));
}

/**
 * The bridge registers here, so the broker never has to know about HTTP or tabs.
 *
 * Registration replays whatever is already owed: startup restores the run before the bridge
 * exists, so the restore itself has nobody to ask for a tab.
 */
export function onSpawnRequest(handler: (workers: WorkerSpawn[]) => void): void {
  spawnRequest = handler;
  const owed = pendingWorkerSpawns();
  if (owed.length > 0) {
    handler(owed);
    logInfo(`multi-agent: ${owed.length} worker chat(s) still owed a tab`);
  }
}

// ------------------------------------------------------------------ identity

/**
 * What a caller can offer as proof of who it is. No field is ever an agent id.
 */
export interface Caller {
  /**
   * The ChatGPT conversation this call was proven to come from, and the only identity any
   * agent has.
   *
   * Only ever set from evidence gathered for the call being handled: ChatGPT's own message
   * model naming this exact tool request, in exactly one conversation. Never from anything
   * the model wrote, and never from "the chat that has been active lately".
   */
  conversationId?: string | null;
}

function requireEnabled(): void {
  if (!getConfig().multiAgent.enabled) {
    throw new AgentError('Multi-agent mode is switched off in ChatGPT Local Files. Ask the user to enable it.');
  }
}

/** The live agent bound to a conversation, prime included. */
function agentForConversationId(conversationId: string): Agent | null {
  if (!run) return null;
  if (conversationId === run.primeConversationId) return run.agents.get(PRIME_ID) ?? null;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === conversationId && !isOver(agent.info.state)) return agent;
  }
  return null;
}

/**
 * Who is calling, or null.
 *
 * One lookup, because there is one identity: the conversation this call was proven to come
 * from. A call that could not be placed in a conversation belongs to nobody, and saying so
 * is what keeps an unidentified call from being filed under whichever agent was busiest.
 */
function resolve(caller: Caller): Agent | null {
  if (!run || !caller.conversationId) return null;
  return agentForConversationId(caller.conversationId);
}

/** Attribution for an ordinary tool call: only ever a binding, never a claim. */
export function agentForCaller(caller: Caller): string | null {
  if (!getConfig().multiAgent.enabled) return null;
  return resolve(caller)?.info.id ?? null;
}

/**
 * Resolves the caller to a member of the active run, or refuses in the one honest way.
 *
 * Three refusals, deliberately different. A caller with no run at all is told how to start
 * one. A chat that *was* identified and is not in the run learns only `AGENTS_BUSY` — never
 * who the prime is, how many workers there are, or what they are doing. And a call whose
 * conversation could not be established at all is a different failure entirely: it is not a
 * stranger, it is an agent whose identity this app could not read, so it is told that in
 * those words rather than being handed a credential to carry instead.
 */
function requireMember(caller: Caller): Agent {
  requireEnabled();
  if (!run) {
    throw new AgentError(
      'No sub-agent run is active. The chat that calls agents action=spawn becomes the prime agent of a new run.'
    );
  }
  if (!caller.conversationId) throw new IdentityLostError();
  const agent = resolve(caller);
  if (!agent) throw new AgentsBusyError();
  return agent;
}

/** Resolves who is calling, or refuses with something the model can act on. */
export function identify(caller: Caller): AgentInfo {
  return { ...requireMember(caller).info };
}

// -------------------------------------------------------------------- state

function makeWorker(id: string, label: string, task: string): Agent {
  return {
    info: {
      id,
      role: 'worker',
      label,
      task,
      state: 'invited',
      createdAt: Date.now(),
      activatedAt: null,
      finishedAt: null,
      result: null,
      pending: 0,
      awaitingAck: 0,
      delivered: 0,
      conversationId: null
    },
    queue: [],
    joinKeyHash: null
  };
}

function makePrime(conversationId: string): Agent {
  return {
    info: {
      id: PRIME_ID,
      role: 'prime',
      label: 'Prime',
      task: 'Coordinates the workers',
      state: 'active',
      createdAt: Date.now(),
      activatedAt: Date.now(),
      finishedAt: null,
      result: null,
      pending: 0,
      awaitingAck: 0,
      delivered: 0,
      conversationId
    },
    queue: [],
    joinKeyHash: null
  };
}

function recount(agent: Agent): void {
  const live = agent.queue.filter((message) => message.ackedAt === null);
  agent.info.pending = live.length;
  agent.info.awaitingAck = live.filter((message) => message.offeredAt !== null).length;
}

function primeAgent(): Agent {
  const agent = run?.agents.get(PRIME_ID);
  if (!agent) throw new AgentError('No sub-agent run is active.');
  return agent;
}

/**
 * Ends the run: agents, queues, credentials, and — through the end listeners — any worker
 * bootstrap the browser has not opened yet.
 *
 * Half-clearing is what produced the worst observed behaviour, a browser opening tabs for
 * workers of a run that no longer had a prime to report to.
 */
function endRun(reason: string): void {
  if (!run) return;
  const retired: RetiredChat[] = [...run.agents.values()]
    .filter((agent) => agent.info.role === 'worker' && !isOver(agent.info.state) && agent.info.conversationId)
    .map((agent) => ({ id: agent.info.id, conversationId: agent.info.conversationId as string }));
  const what = `${run.runId} (${[...run.agents.keys()].join(', ')})`;
  run = null;
  forgetAgentSecrets();
  logInfo(`multi-agent: ended run ${what} — ${reason}`);
  for (const listener of endListeners) listener(reason, retired);
}

// -------------------------------------------------------------------- spawn

export interface SpawnInput {
  workers: ReadonlyArray<{ label?: string; task: string }>;
  caller: Caller;
}

export interface SpawnResult {
  created: AgentInfo[];
  /** True on the call that established the run, so the caller can say what happened. */
  becamePrime: boolean;
  runId: string;
}

/**
 * Claims the calling conversation as prime and creates its workers, atomically.
 *
 * Every step that can fail happens before the first mutation, in a fixed order:
 *
 *   1. the request itself is valid (all of it, not the prefix that happened to parse);
 *   2. this app has *proven* which conversation is calling;
 *   3. that conversation is not a worker of the active run;
 *   4. no other conversation holds the one swarm;
 *   5. only then is the prime bound and the workers created.
 *
 * So a spawn that fails for any reason leaves zero workers behind, and no conversation ever
 * becomes prime as a by-product of some other outcome.
 */
export function spawn(input: SpawnInput): SpawnResult {
  requireEnabled();
  const max = getConfig().multiAgent.maxWorkers;
  if (input.workers.length === 0) throw new AgentError('At least one worker is required');

  const planned = input.workers.map((worker, index) => {
    const task = worker.task.trim();
    if (!task) throw new AgentError(`Worker ${index + 1} has no task. Every worker needs one.`);
    if (task.length > MAX_TASK_CHARS) throw new AgentError(`Worker ${index + 1}'s task is too long`);
    const label = worker.label?.trim() ?? '';
    if (label.length > MAX_LABEL_CHARS) {
      throw new AgentError(`Worker ${index + 1}'s label is too long (limit ${MAX_LABEL_CHARS} characters)`);
    }
    return { label, task };
  });

  const conversationId = input.caller.conversationId ?? null;
  if (!conversationId) {
    throw new AgentError(
      'UNIDENTIFIED_CALLER: this app could not prove which ChatGPT conversation this call came from, so it will not ' +
        'make this chat the prime agent of a run. No workers were created. The paired browser extension has to be ' +
        'connected and this conversation has to be showing its connector activity; wait a moment and call ' +
        'agents action=spawn again.'
    );
  }

  if (run) {
    const caller = resolve(input.caller);
    if (caller && caller.info.role === 'worker') {
      throw new AgentError(
        `${caller.info.id} is a worker in this run. Workers must not create workers of their own — send the prime ` +
          'agent a message instead and let it decide.'
      );
    }
    if (conversationId !== run.primeConversationId) throw new AgentsBusyError();
  }

  const becamePrime = run === null;
  if (!run) {
    run = {
      runId: randomUUID().slice(0, 8),
      primeConversationId: conversationId,
      startedAt: Date.now(),
      agents: new Map([[PRIME_ID, makePrime(conversationId)]]),
      transfer: null
    };
  }

  const live = [...run.agents.values()].filter((agent) => agent.info.role === 'worker' && !isOver(agent.info.state));

  // The same request arriving twice is one request. A tool result that never reached
  // ChatGPT leaves a model with no idea its workers exist, and the obvious thing for it to
  // do is ask again; creating a second identical set is how a user ends up with four
  // sub-agent chats they asked for twice.
  const repeat = matchExistingRequest(planned, live);
  if (repeat) {
    const stillInvited = repeat.filter((agent) => agent.info.state === 'invited');
    if (spawnRequest && stillInvited.length > 0) {
      spawnRequest(stillInvited.map((agent) => ({ id: agent.info.id, task: agent.info.task })));
    }
    logInfo(`multi-agent: repeated spawn matched ${repeat.length} existing worker(s) in run ${run.runId}`);
    return { created: repeat.map((agent) => ({ ...agent.info })), becamePrime, runId: run.runId };
  }

  if (live.length + planned.length > max) {
    const total = live.length + planned.length;
    if (becamePrime) run = null;
    throw new AgentError(`That would make ${total} live workers; the limit set in the app is ${max}.`);
  }

  const ids: string[] = [];
  for (let n = 1; ids.length < planned.length && n <= 64; n++) {
    const id = `worker-${n}`;
    if (!run.agents.has(id)) ids.push(id);
  }
  if (ids.length < planned.length) {
    if (becamePrime) run = null;
    throw new AgentError('Too many workers have been created in this run');
  }

  const created: AgentInfo[] = [];
  const owed: WorkerSpawn[] = [];
  for (const [index, worker] of planned.entries()) {
    const id = ids[index] as string;
    const agent = makeWorker(id, worker.label || id, worker.task);
    run.agents.set(id, agent);
    // A worker starts in the folder the prime was working in, so its first call can use the
    // same shorthand. It is a copy: a worker sent into another project overwrites its own
    // entry and never the prime's.
    inheritWorkspace(id, run.primeConversationId);
    created.push({ ...agent.info });
    owed.push({ id, task: worker.task });
  }

  if (spawnRequest) spawnRequest(owed);
  else logWarn('multi-agent: no browser extension is paired, so worker chats cannot be opened automatically');
  logInfo(
    becamePrime
      ? `multi-agent: run ${run.runId} started by conversation ${conversationId} with ${created.length} worker(s)`
      : `multi-agent: created ${created.length} worker(s) in run ${run.runId}`
  );
  changed();
  return { created, becamePrime, runId: run.runId };
}

/**
 * Finds the workers a repeated spawn is really asking about.
 *
 * All or nothing, matched on the request as written. A request that asks for anything new is
 * a new request and creates everything it asks for, so a prime that genuinely wants a third
 * worker still gets one; only an exact repetition of work already under way is folded back.
 */
function matchExistingRequest(
  requested: ReadonlyArray<{ label: string; task: string }>,
  live: readonly Agent[]
): Agent[] | null {
  if (requested.length === 0 || live.length === 0) return null;
  // An unambiguous encoding of the (label, task) pair rather than a separator character.
  // Any separator is only as good as the assumption that it cannot occur in the operands, and
  // both of these are free text a model wrote; JSON removes the assumption entirely, so
  // ("a", "b c") and ("a b", "c") can never shape-collide into one match. It also keeps this
  // file plain text: the NUL that used to do this job was a literal byte, which made every
  // text tool treat the source as binary.
  const shape = (label: string, task: string): string => JSON.stringify([label.trim(), task.trim()]);
  const taken = new Set<Agent>();
  const matched: Agent[] = [];
  for (const worker of requested) {
    // The stored label defaults to the worker id, so an unlabelled request has to match the
    // way spawn would have written it.
    const found = live.find(
      (agent) =>
        !taken.has(agent) &&
        (shape(agent.info.label, agent.info.task) === shape(worker.label || agent.info.id, worker.task) ||
          shape(agent.info.label, agent.info.task) === shape(worker.label, worker.task))
    );
    if (!found) return null;
    taken.add(found);
    matched.push(found);
  }
  return matched;
}

// ----------------------------------------------------------------- recovery

/**
 * The over-and-done slot a caller belongs to, if it belongs to one.
 *
 * Terminal agents are invisible to ordinary resolution on purpose — nothing in a run should
 * route to them — but a retried `finish`, and a `join` from a chat whose slot is a tombstone,
 * still have to be answered honestly. This is the one lookup that can see them.
 */
function retiredAgent(caller: Caller): Agent | null {
  if (!run || !caller.conversationId) return null;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === caller.conversationId && isOver(agent.info.state)) return agent;
  }
  return null;
}

/**
 * Recovers a worker slot whose binding never arrived. Emergency and manual, never startup.
 *
 * The normal path does not come through here at all: the extension reports the conversation
 * it opened for a slot and {@link bindConversation} activates it before the model in that chat
 * reads its task. What is left for this is the one failure that path cannot recover from — the
 * report was lost, so the chat doing the work is a stranger to the run and the slot is still
 * `invited`.
 *
 * Both halves are required and neither is negotiable. The calling conversation has to be
 * *proven*, because that is the identity being installed; and the key has to match, because a
 * proven conversation on its own says only "some chat is asking", and picking the one unbound
 * slot for it would be exactly the guess this whole design refuses to make.
 *
 * The key is spent on use, and a slot that already has a conversation is never moved: a key
 * replayed from a duplicated tab would otherwise relabel a live worker and redirect its
 * messages away from the chat doing the work.
 */
export function join(caller: Caller, joinKey?: string | null): AgentInfo {
  requireEnabled();
  if (!run) {
    throw new AgentError(
      'No sub-agent run is active, so there is nothing to recover. If you were opened as a worker, the run ended ' +
        'before you got here; tell the user and stop.'
    );
  }
  if (!caller.conversationId) throw new IdentityLostError();

  // Already a member: this chat's slot was bound the ordinary way and there is nothing to
  // recover. Answered rather than refused, because a model that reached for this has
  // misunderstood its situation and the honest correction is its own identity.
  const known = agentForConversationId(caller.conversationId);
  if (known) {
    if (known.info.role === 'prime') {
      throw new AgentError('This conversation is the prime agent of the run. The prime has nothing to recover.');
    }
    return { ...known.info };
  }
  const over = retiredAgent(caller);
  if (over) {
    throw new AgentError(
      `${over.info.id} has already ${over.info.state === 'failed' ? 'failed' : 'finished'}. Do not carry on working: ` +
        'tell the user this chat is over.'
    );
  }

  if (!joinKey) {
    throw new AgentError(
      'This conversation is not part of the active run. Worker chats are bound to their slot by the extension that ' +
        'opens them, so there is no ordinary reason to call this. If a worker chat really did lose its binding, the ' +
        'user can recover it by passing the recovery key from the ChatGPT Local Files log as join_key.'
    );
  }
  const hash = sha256(joinKey);
  const agent = [...run.agents.values()].find((entry) => entry.joinKeyHash === hash && !isOver(entry.info.state)) ?? null;
  if (!agent) {
    throw new AgentError('That recovery key does not match any worker slot waiting to be recovered.');
  }
  if (agent.info.conversationId) {
    throw new AgentError(
      `${agent.info.id} is already running in another conversation. A recovery key cannot move a worker that is ` +
        'already bound.'
    );
  }
  if (!activateWorker(agent, caller.conversationId)) {
    throw new AgentError(
      `This conversation is already part of the run as ${agentForConversation(caller.conversationId) ?? 'another agent'}, ` +
        'so it cannot also take over a worker slot. Tell the user the worker chats got crossed.'
    );
  }
  // Spent on use: a second conversation replaying the same key cannot take the worker over.
  agent.joinKeyHash = null;
  logInfo(`multi-agent: ${agent.info.id} recovered its binding by key in run ${run.runId}`);
  changed();
  return { ...agent.info };
}

/**
 * Mints the one-time recovery key for a worker whose chat is being opened now.
 *
 * Called by whoever hands the bootstrap to the browser, so a key is never created for a
 * bootstrap that is only queued. The plaintext is returned once, to be written where the
 * *user* can find it; it is never given to a model, and the ordinary worker never needs it.
 */
export function mintWorkerJoinKey(id: string): string | null {
  const agent = run?.agents.get(id);
  if (!agent || agent.info.role !== 'worker' || isOver(agent.info.state)) return null;
  const key = mintKey();
  registerAgentSecret(key);
  agent.joinKeyHash = sha256(key);
  return key;
}

// ------------------------------------------------------------------ routing

/**
 * Star topology, enforced.
 *
 * Two workers talking directly is the thing this mode must not allow: it is how a swarm
 * silently negotiates a plan the user never sees and the prime cannot report.
 */
function assertRoute(from: Agent, to: Agent): void {
  if (from.info.id === to.info.id) throw new AgentError('An agent cannot message itself');
  if (from.info.role === 'worker' && to.info.role !== 'prime') {
    throw new AgentError('Workers may only message the prime agent. Send it there and let the prime decide.');
  }
  if (from.info.role === 'prime' && to.info.role !== 'worker') {
    throw new AgentError('The prime agent can only message workers');
  }
}

/**
 * Adds a message to a recipient's queue, or refuses.
 *
 * Refusing is the point. Dropping the oldest waiting message to make room would throw away a
 * task or a result while still telling the sender it was sent.
 */
function enqueue(to: Agent, message: AgentMessage): void {
  const waiting = to.queue.filter((item) => item.ackedAt === null).length;
  if (waiting >= MAX_QUEUE) {
    throw new AgentError(
      `QUEUE_FULL: ${to.info.id} already has ${waiting} unacknowledged messages, which is the limit. Nothing was sent ` +
        'and nothing was discarded. A queue this deep normally means that agent has stopped calling tools.'
    );
  }
  to.queue.push(message);
  if (to.queue.length > MAX_QUEUE * 2) {
    const settled = to.queue.filter((item) => item.ackedAt !== null).slice(-MAX_QUEUE);
    to.queue = [...settled, ...to.queue.filter((item) => item.ackedAt === null)];
  }
  recount(to);
}

function newMessage(from: string, to: string, text: string): AgentMessage {
  return {
    id: randomUUID().slice(0, 8),
    from,
    to,
    time: Date.now(),
    text,
    offeredAt: null,
    offers: 0,
    offeredOnFinish: false,
    ackedAt: null
  };
}

/**
 * Sends a message from the caller — whoever the broker says that is — to `toId`.
 *
 * There is deliberately no "from" parameter. The sender is derived from the caller's
 * binding, so the star topology cannot be sidestepped by writing someone else's id.
 */
export function sendMessage(caller: Caller, toId: string, text: string): AgentMessage {
  const trimmed = text.trim();
  if (!trimmed) throw new AgentError('The message is empty');
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new AgentError(`Message is too long (limit ${MAX_MESSAGE_CHARS} characters)`);
  }
  const from = requireMember(caller);
  const to = run?.agents.get(toId);
  if (!to) throw new AgentError(`Unknown agent "${toId}". Call agents action=status to see who exists.`);
  // A finished worker keeps its code so a lost finish result can be recognised as a retry.
  // Without this guard that same code let it go on queueing work for the prime after it had
  // reported and stopped.
  if (isOver(from.info.state)) {
    throw new AgentError(
      `${from.info.id} has ${from.info.state === 'failed' ? 'failed' : 'finished'} and cannot send messages.`
    );
  }
  assertRoute(from, to);
  if (isOver(to.info.state)) {
    throw new AgentError(`${toId} has ${to.info.state === 'failed' ? 'failed' : 'finished'} and is no longer listening`);
  }
  const message = newMessage(from.info.id, toId, trimmed);
  enqueue(to, message);
  changed();
  return { ...message };
}

/**
 * Messages to put in this agent's next tool result, including anything already offered but
 * not yet acknowledged.
 *
 * That is the deliberate at-least-once trade: if the previous result never reached ChatGPT —
 * the connector dropping mid-turn is a failure this project has reproduced — the message
 * comes round again instead of vanishing. `offers > 1` lets the caller label a repeat.
 *
 * `onFinish` records that this offer rode on a `finish` result, the one result whose loss is
 * answered by an identical retry and whose acknowledgement therefore proves nothing.
 */
export function offerMessages(id: string, onFinish = false): AgentMessage[] {
  const agent = run?.agents.get(id);
  if (!agent) return [];
  const waiting = agent.queue.filter((message) => message.ackedAt === null);
  if (waiting.length === 0) return [];
  const now = Date.now();
  for (const message of waiting) {
    message.offeredAt = now;
    message.offers += 1;
    message.offeredOnFinish = onFinish;
  }
  recount(agent);
  changed();
  return waiting.map((message) => ({ ...message }));
}

/**
 * Retires everything previously offered to this agent, except what this call cannot honestly
 * be said to have proven.
 *
 * Called at the start of that agent's next authenticated call, because that call is the best
 * evidence available that the previous tool result made it back into the conversation.
 * Evidence, not proof — so a message offered on a `finish` result is not retired by another
 * `finish`, which would otherwise let a worker's own retry count an unread message as
 * delivered and then terminalise it.
 */
export function acknowledgeOffers(id: string, byFinish = false): AgentMessage[] {
  const agent = run?.agents.get(id);
  if (!agent) return [];
  const offered = agent.queue.filter(
    (message) => message.ackedAt === null && message.offeredAt !== null && !(byFinish && message.offeredOnFinish)
  );
  if (offered.length === 0) return [];
  const now = Date.now();
  for (const message of offered) message.ackedAt = now;
  agent.info.delivered += offered.length;
  recount(agent);
  changed();
  return offered.map((message) => ({ ...message }));
}

export function pendingCount(id: string): number {
  return run?.agents.get(id)?.info.pending ?? 0;
}

// ------------------------------------------------------------------- finish

export interface FinishResult {
  info: AgentInfo;
  /** The report queued for the prime, so the caller can record it durably. */
  report: AgentMessage | null;
  /** This call found the agent already terminal and changed nothing. */
  repeat: boolean;
}

/**
 * Finishes the calling worker. An agent can only ever finish itself.
 *
 * Finishing twice is one finish. This connector loses tool results, so a worker whose result
 * never came back simply calls again, usually with slightly different wording. Taking the
 * second call literally rewrote `finishedAt` and queued a *second* final report, so the
 * prime was told the same thing twice with no way to tell that from two genuine reports.
 */
export function finishAgent(caller: Caller, result: string): FinishResult {
  requireEnabled();
  if (!run) throw new AgentError('No sub-agent run is active.');
  if (!caller.conversationId) throw new IdentityLostError();
  // The one call that also answers from a conversation whose slot has already ended: this
  // connector loses tool results, so a retry of *this* call is exactly what that looks like,
  // and telling the chat that had genuinely finished that it was a stranger was worse than
  // useless.
  const agent = resolve(caller) ?? retiredAgent(caller);
  if (!agent) throw new AgentsBusyError();
  if (agent.info.role !== 'worker') {
    throw new AgentError(
      'The prime agent does not finish: the run ends when its workers have reported and the user is done with it.'
    );
  }
  if (isOver(agent.info.state)) {
    logInfo(`multi-agent: ${agent.info.id} called finish again after it had already ${agent.info.state}`);
    return { info: { ...agent.info }, report: null, repeat: true };
  }

  // What the prime told this worker and cannot be shown to have reached it. Taken before
  // the state changes and said out loud, because this app cannot prove a tool result
  // arrived — the guarantee it can keep is "either the worker got it or you are told it
  // may not have", and only the prime can act on the second case.
  const unconfirmed = agent.queue.filter((message) => message.ackedAt === null).map((message) => message.id);

  agent.info.state = 'finished';
  agent.info.finishedAt = Date.now();
  agent.info.result = result.slice(0, MAX_MESSAGE_CHARS);
  // What survives is the tombstone: the identity, the task, the result and the conversation,
  // none of which can authorise anything. The conversation is deliberately kept — it is what
  // lets a retried finish from that same chat be recognised as the retry it is.
  agent.joinKeyHash = null;

  const caveat =
    unconfirmed.length > 0
      ? `\n(${agent.info.id} ended without ever confirming ${unconfirmed.length} message(s) you sent it — ` +
        `${unconfirmed.slice(0, 5).join(', ')}${unconfirmed.length > 5 ? ', …' : ''}. ` +
        'Assume it may not have read them and check the result against what you asked for.)'
      : '';
  const report = newMessage(agent.info.id, PRIME_ID, `[${agent.info.id} finished] ${agent.info.result}${caveat}`);
  // Over the queue limit on purpose: the worker is about to stop existing and has no way to
  // retry its final report.
  const prime = primeAgent();
  prime.queue.push(report);
  recount(prime);
  logInfo(`multi-agent: ${agent.info.id} finished`);
  changed();
  return { info: { ...agent.info }, report: { ...report }, repeat: false };
}

/**
 * Ends a worker that never got off the ground, definitively.
 *
 * Called by whoever owns the bootstrap once it has run out of retries or time. Before this
 * existed, giving up only deleted the queued command: the worker stayed `invited`, still
 * counted towards the worker limit, still blocked the next bootstrap, and still promised the
 * prime a report that could never arrive.
 */
export function failAgent(id: string, reason: string, note?: string): FinishResult | null {
  const agent = run?.agents.get(id);
  if (!run || !agent || agent.info.role !== 'worker' || isOver(agent.info.state)) return null;
  agent.info.state = 'failed';
  agent.info.finishedAt = Date.now();
  agent.info.result = reason.slice(0, MAX_MESSAGE_CHARS);
  agent.joinKeyHash = null;
  agent.queue = [];
  recount(agent);

  const report = newMessage(
    id,
    PRIME_ID,
    note ??
      `[${id} failed] Its ChatGPT tab never came up: ${agent.info.result}. It will not report. Do that part of the ` +
        'work yourself or spawn a replacement worker.'
  );
  const prime = primeAgent();
  prime.queue.push(report);
  recount(prime);
  logWarn(`multi-agent: ${id} failed — ${reason}`);
  changed();
  return { info: { ...agent.info }, report: { ...report }, repeat: false };
}

// -------------------------------------------------------- prime lifecycle

/** Whether a run exists at all. */
export function swarmRunning(): boolean {
  return run !== null;
}

/** The conversation the prime is bound to, or null when there is no run. */
export function primeConversation(): string | null {
  return run?.primeConversationId ?? null;
}

/** The run identifier, or null. Used only for logging and for transfer bookkeeping. */
export function currentRunId(): string | null {
  return run?.runId ?? null;
}

/**
 * The prime chat has gone: end the run.
 *
 * Called by the bridge when the prime's tab reports that it closed or navigated away with no
 * transfer open. Deliberately owned by the extension rather than inferred from silence, and
 * deliberately not asked of the model: a swarm whose coordinator is gone has nobody to
 * report to, and workers that keep going are tabs writing files for a run nobody is reading.
 */
export function primeConversationGone(conversationId: string): boolean {
  if (!run || run.primeConversationId !== conversationId) return false;
  // A handover in flight is the one case where the prime chat is *supposed* to go away.
  if (run.transfer && !transferExpired(run.transfer)) return false;
  endRun('the prime conversation was closed');
  changed();
  return true;
}

/** A frozen handover never expires: it is mid-commit, and the commit must be able to finish. */
const transferExpired = (transfer: { at: number; frozen: boolean }): boolean =>
  !transfer.frozen && Date.now() - transfer.at > TRANSFER_TTL_MS;

/**
 * Notes that the app's own Compact & Resume is moving this session to a new chat.
 *
 * Deliberately *not* a second one-time-token system. The single continuation transaction
 * lives in the session layer, which owns the durable local session and its one-time token;
 * the swarm binding is one of the things that transaction moves, alongside the workspace and
 * the recorded history. All this flag does is stop {@link primeConversationGone} from
 * killing the run while chat A is being replaced, which is the one moment the prime chat is
 * *supposed* to disappear.
 */
export function beginPrimeTransfer(conversationId: string): boolean {
  if (!run || run.primeConversationId !== conversationId) return false;
  run.transfer = { from: conversationId, at: Date.now(), frozen: false };
  return true;
}

/** Abandons an open handover, so the prime stays where it is. */
export function cancelPrimeTransfer(conversationId: string): void {
  if (run?.transfer?.from === conversationId) run.transfer = null;
}

/**
 * What the session layer must know *before* it starts writing, and the point of no expiry.
 *
 * The commit is a fallible durable write followed by moves that have to be total, and the
 * swarm move is the one that used to be neither: it re-checked its own deadline inside the
 * total phase, so a commit that preflighted fine, then spent a second on disk, could leave
 * the durable session in chat B with the swarm still bound to chat A. So the decision is
 * taken here, once, before the write:
 *
 *   `absent`      — this chat is not the prime of any run. There is nothing to move, and the
 *                   session rebind is free to proceed.
 *   `unavailable` — it *is* the prime, but no usable handover is open. The caller must refuse
 *                   the whole commit; a session that moved without its swarm is the split this
 *                   exists to prevent.
 *   `frozen`      — the handover is now pinned and {@link commitPrimeTransfer} will succeed
 *                   for this pair unless the run itself ends in the meantime, which is a
 *                   terminal state rather than a half-commit: there is no prime left in chat A
 *                   to be inconsistent with.
 *
 * A freeze whose commit does not happen is released with {@link thawPrimeTransfer}, which
 * restarts the clock without abandoning the handover, so a retry is still possible.
 */
export function freezePrimeTransfer(fromConversationId: string): 'absent' | 'unavailable' | 'frozen' {
  if (!run || run.primeConversationId !== fromConversationId) return 'absent';
  const transfer = run.transfer;
  if (!transfer || transfer.from !== fromConversationId || transferExpired(transfer)) return 'unavailable';
  if (!run.agents.has(PRIME_ID)) return 'unavailable';
  transfer.frozen = true;
  return 'frozen';
}

/** Undoes a freeze whose commit did not happen, leaving the handover open but expiring again. */
export function thawPrimeTransfer(fromConversationId: string): void {
  if (run?.transfer?.from === fromConversationId) {
    run.transfer.frozen = false;
    run.transfer.at = Date.now();
  }
}

/**
 * Moves the prime binding as part of the session rebind commit.
 *
 * Called only from the commit step of the session continuation transaction, after
 * {@link freezePrimeTransfer} authorised it and after that transaction has proven chat B is
 * real and usable. Deliberately has no deadline of its own — the freeze is the deadline — so
 * the only way this can now decline is that the run ended entirely while the write was in
 * flight, and a run that no longer exists cannot be left behind in chat A.
 *
 * Returns false, changing nothing, when there is no handover open from that exact
 * conversation, which is what stops a stray chat from inheriting a swarm.
 */
export function commitPrimeTransfer(fromConversationId: string, toConversationId: string): boolean {
  if (!run || !run.transfer || !toConversationId) return false;
  if (run.transfer.from !== fromConversationId || run.primeConversationId !== fromConversationId) return false;
  const prime = run.agents.get(PRIME_ID);
  if (!prime) return false;
  run.primeConversationId = toConversationId;
  prime.info.conversationId = toConversationId;
  run.transfer = null;
  logInfo(`multi-agent: prime moved from conversation ${fromConversationId} to ${toConversationId}`);
  changed();
  return true;
}

// -------------------------------------------------------------------- state

export function swarmState(): SwarmState {
  const list = run ? [...run.agents.values()].map((agent) => ({ ...agent.info })) : [];
  list.sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'prime' ? -1 : 1));
  return {
    enabled: getConfig().multiAgent.enabled,
    running: run !== null,
    agents: list
  };
}

export function agentConversation(id: string): string | null {
  return run?.agents.get(id)?.info.conversationId ?? null;
}

/** Reverse lookup used to file a recorded event into the right session. */
export function agentForConversation(conversationId: string): string | null {
  if (!run) return null;
  if (conversationId === run.primeConversationId) return PRIME_ID;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === conversationId) return agent.info.id;
  }
  return null;
}

/**
 * Binds a worker to the ChatGPT conversation it is running in, and starts it.
 *
 * This *is* the worker lifecycle transition. Called by the bridge when the extension
 * acknowledges the tab it opened — the one party that knows the mapping first-hand, and knows
 * it before the model in that tab has said anything — so by the time the worker reads its task
 * it is already an active member of the run and its later calls route by conversation alone.
 * Nothing is asked of the model to make that true.
 *
 * It can never move the prime: that binding is set once by `spawn` and moved only by an
 * authenticated transfer. It can never move a worker either — see
 * {@link bindWorkerConversation} for why one binding per slot and one slot per conversation
 * is an invariant rather than a preference.
 */
export function bindConversation(id: string, conversationId: string): boolean {
  const agent = run?.agents.get(id);
  if (!agent || agent.info.role !== 'worker' || isOver(agent.info.state)) return false;
  return activateWorker(agent, conversationId);
}

/**
 * Binds a worker to its conversation and makes it active, in one indivisible step.
 *
 * One step on purpose. A slot that is bound but not yet active is a state nothing can act
 * on and everything has to special-case: the bridge cannot tell whether its bootstrap
 * succeeded, `pendingWorkerSpawns` still owes it a tab, and the prime waits on a worker that
 * is, in every sense that matters, already running. Activation on binding is what makes
 * "the app opened this chat for this slot" and "this worker is running" the same fact.
 */
function activateWorker(agent: Agent, conversationId: string): boolean {
  if (!bindWorkerConversation(agent, conversationId)) return false;
  if (agent.info.state === 'invited') {
    agent.info.state = 'active';
    agent.info.activatedAt = Date.now();
    logInfo(`multi-agent: ${agent.info.id} is active in conversation ${conversationId}`);
    changed();
  }
  return true;
}

/**
 * The one place a worker's conversation is ever set. Exactly once, and to a free chat.
 *
 * Two invariants, both load-bearing for identity:
 *
 *   *One binding per slot.* A worker already running in a conversation stays there. Every
 *   later report of a different chat is either a mistake or someone else's tab, and honouring
 *   it would point the worker's messages, its recorded events and its workspace at a chat
 *   that is not doing the work — while the chat that *is* doing it stops being recognised at
 *   all. A binding is only re-set to the identical value, which is a no-op.
 *
 *   *One slot per conversation.* A conversation already holding the prime or another live
 *   worker cannot be bound again, or one chat would answer to two identities and
 *   {@link agentForConversation} would file its work under whichever it found first.
 *
 * The second check counts finished workers too. Their chats are tombstones: still readable,
 * never re-usable, and a new worker inheriting one would make the transcript of a worker that
 * is over look like the transcript of the one that replaced it.
 */
function bindWorkerConversation(agent: Agent, conversationId: string): boolean {
  if (!conversationId) return false;
  if (agent.info.conversationId === conversationId) return true;
  if (agent.info.conversationId) {
    logWarn(
      `multi-agent: refused to move ${agent.info.id} from conversation ${agent.info.conversationId} to ${conversationId}`
    );
    return false;
  }
  const taken = run ? agentForConversation(conversationId) : null;
  if (taken && taken !== agent.info.id) {
    logWarn(`multi-agent: refused to bind ${agent.info.id} to conversation ${conversationId}, already held by ${taken}`);
    return false;
  }
  agent.info.conversationId = conversationId;
  changed();
  return true;
}

/** Ends the run. Called when the user turns the mode off or clears the swarm. */
export function resetSwarm(): void {
  endRun('the run was cleared in the app');
  changed();
}

/** What a clear actually did, so the UI can say it rather than guess. */
export interface ClearResult {
  cleared: 'run' | 'worker' | 'none';
  report: AgentMessage | null;
  reason: string;
}

/**
 * The user clearing one row in the app.
 *
 * The prime *is* the run, so clearing it ends everything — there is no such thing as a run
 * whose prime was removed but whose workers continue. A worker is one slot: it is
 * terminalised, never deleted, so the row stays visible and honestly labelled as over while
 * its queued bootstrap is retired and the slot frees up.
 */
export function clearAgent(id: string): ClearResult {
  if (id === PRIME_ID) {
    if (!run) return { cleared: 'none', report: null, reason: 'there is no run to clear' };
    resetSwarm();
    return { cleared: 'run', report: null, reason: 'the run was cleared in the app' };
  }
  const agent = run?.agents.get(id);
  if (!agent) return { cleared: 'none', report: null, reason: `${id} is not part of this run` };
  if (isOver(agent.info.state)) return { cleared: 'none', report: null, reason: `${id} has already ended` };
  const reason = 'the user cleared this worker in the app';
  const outcome = failAgent(
    id,
    reason,
    `[${id} cleared] The user ended this worker from the app. It will not report and cannot be messaged. Carry on ` +
      'without it, or spawn a replacement worker if the work still needs doing.'
  );
  return { cleared: 'worker', report: outcome?.report ?? null, reason };
}

// -------------------------------------------------------------- persistence

/**
 * What survives a restart.
 *
 * Agent state and unacknowledged messages are the parts that cannot be reconstructed: the
 * session log is the audit trail, but it does not know which messages were still in flight.
 * Credentials cross this boundary as hashes only.
 */
export interface SwarmSnapshot {
  /**
   * 4 = agents identified by conversation alone, with no routing codes. Earlier shapes are
   * discarded rather than migrated: a version-3 run's workers were identified by codes their
   * chats still hold and this build cannot honour, so restoring one would produce a run whose
   * workers can never be recognised again.
   */
  version: 4;
  savedAt: number;
  runId: string;
  primeConversationId: string;
  startedAt: number;
  agents: Array<{
    info: AgentInfo;
    queue: AgentMessage[];
    joinKeyHash: string | null;
  }>;
}

export function snapshotSwarm(): SwarmSnapshot | null {
  if (!run) return null;
  return {
    version: 4,
    savedAt: Date.now(),
    runId: run.runId,
    primeConversationId: run.primeConversationId,
    startedAt: run.startedAt,
    agents: [...run.agents.values()].map((agent) => ({
      info: { ...agent.info },
      // Acknowledged messages are already durable session events; what has to survive here
      // is the in-flight tail.
      queue: agent.queue.filter((message) => message.ackedAt === null).map((message) => ({ ...message })),
      joinKeyHash: agent.joinKeyHash
    }))
  };
}

/**
 * Restores a run from disk.
 *
 * Messages that were in flight come back unoffered rather than delivered: the app cannot
 * know whether the result carrying them ever arrived, and offering one twice is the
 * recoverable half of that uncertainty. An open transfer is deliberately not restored — a
 * handover interrupted by a restart is abandoned, and the prime stays where it was.
 */
export function restoreSwarm(snapshot: SwarmSnapshot | null): void {
  run = null;
  if (!snapshot || !Array.isArray(snapshot.agents)) return;
  if (snapshot.version !== 4 || typeof snapshot.primeConversationId !== 'string' || !snapshot.primeConversationId) {
    logInfo('multi-agent: discarded a run saved by an older build — spawn again to start a new one.');
    return;
  }
  const agents = new Map<string, Agent>();
  for (const entry of snapshot.agents) {
    if (!entry?.info?.id) continue;
    const agent: Agent = {
      info: { ...entry.info },
      queue: (Array.isArray(entry.queue) ? entry.queue : []).map((message) => ({
        ...message,
        offeredAt: null,
        offeredOnFinish: message.offeredOnFinish ?? false
      })),
      joinKeyHash: entry.joinKeyHash ?? null
    };
    recount(agent);
    agents.set(entry.info.id, agent);
  }
  if (!agents.has(PRIME_ID)) {
    logInfo('multi-agent: discarded a saved run with no prime agent');
    return;
  }
  run = {
    runId: snapshot.runId || randomUUID().slice(0, 8),
    primeConversationId: snapshot.primeConversationId,
    startedAt: snapshot.startedAt || snapshot.savedAt || Date.now(),
    agents,
    transfer: null
  };

  // A worker that was invited but whose chat was never bound needs it opened again. If the
  // bridge is not registered yet — at startup it is not, because the run is restored first —
  // this is replayed by onSpawnRequest the moment it registers.
  const stranded = pendingWorkerSpawns();
  if (stranded.length > 0 && spawnRequest) {
    spawnRequest(stranded);
    logInfo(`multi-agent: re-requested ${stranded.length} worker chat(s) that were unbound at the restart`);
  }
  const pending = [...agents.values()].reduce((sum, agent) => sum + agent.info.pending, 0);
  logInfo(`multi-agent: restored run ${run.runId} with ${agents.size} agent(s) and ${pending} undelivered message(s)`);
}

/** Test seam: forgets everything without touching disk. */
export function resetAgentsForTests(): void {
  run = null;
  forgetAgentSecrets();
  spawnRequest = null;
  persist = null;
  listeners.clear();
  endListeners.clear();
}
