/**
 * The multi-agent broker.
 *
 * Experimental and disabled by default. When it is on, one ChatGPT conversation acts
 * as the prime agent and creates workers; each worker is a separate ChatGPT tab the
 * extension opens and bootstraps. All state lives here, in this app: the browser only
 * opens tabs and types the first message.
 *
 * The hierarchy is strict and enforced by routing, not by asking nicely. A worker may
 * message the prime; the prime may message any worker; worker-to-worker is refused.
 * That keeps the topology a star, which is the only shape where the prime can still
 * describe what is going on.
 *
 * Identity is never taken from the caller's word for it. Every agent is one ChatGPT
 * conversation and all of them reach this app through the same connector URL, so an
 * agent id in a tool argument proves nothing: a worker could type "prime" as easily as
 * its own id and then message its siblings, finish somebody else, or recruit workers.
 * Two bindings replace that:
 *
 *   · the MCP transport session, when the transport provides one. Nothing the model
 *     writes can change it, so it wins whenever it exists. It is not assumed to exist:
 *     ChatGPT's connector transport is stateless today and supplies no session id, so
 *     in practice this stays null. See mcp/server.ts for the live measurement.
 *   · otherwise a per-agent secret minted at join time and known only to that agent's
 *     own conversation. This is the binding that actually carries a run.
 *
 * Both are capabilities, not claims. A worker cannot produce another agent's secret,
 * and the prime's is issued to whoever first creates workers — at which moment no
 * other agent exists to steal it. Secrets are held as hashes so a run survives a
 * restart without this app ever keeping the plaintext, and every one of them is
 * registered with agent-secrets.ts so it is scrubbed out of anything durable.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AgentInfo, AgentMessage, AgentRole, SwarmState } from '../shared/session.js';
import { forgetAgentSecrets, registerAgentSecret } from './agent-secrets.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';

export const PRIME_ID = 'prime';
/**
 * Unacknowledged messages held per agent before the broker pushes back.
 *
 * Reached only if an agent stops calling tools entirely while the other side keeps
 * talking. The old behaviour — splice the oldest away — quietly destroyed exactly the
 * messages most likely to matter (the first instruction, the first result) while still
 * telling the sender "Sent", so the limit is now a refusal instead.
 */
const MAX_QUEUE = 200;
export const MAX_MESSAGE_CHARS = 4000;
const MAX_TASK_CHARS = 4000;

export class AgentError extends Error {}

interface Agent {
  info: AgentInfo;
  queue: AgentMessage[];
  /**
   * sha256 of the agent's secret — never the secret itself once it has been handed
   * out, and never in AgentInfo, which crosses into the renderer.
   */
  secretHash: string;
  /** sha256 of the one-time join code, cleared the moment it is spent. */
  joinKeyHash: string | null;
  /** MCP transport session id, when the transport has one. */
  transportKey: string | null;
}

const agents = new Map<string, Agent>();
/**
 * sha256(secret) → agent id.
 *
 * Hashed so the same lookup works after a restart, when the run is restored from disk
 * and the plaintext lives only in the model's chats. It is a map lookup either way, so
 * an unknown secret costs exactly what a known one costs.
 */
const bySecret = new Map<string, string>();
const byTransport = new Map<string, string>();
let spawnRequest: ((workers: WorkerSpawn[]) => void) | null = null;
const listeners = new Set<() => void>();
let persist: (() => void) | null = null;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const mintKey = (): string => randomBytes(24).toString('base64url');

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
 * A worker whose chat still has to be opened. Carries no credential.
 *
 * The join key is deliberately not minted here. Whoever opens the chat mints it at the
 * moment it is actually handed to the browser (see mintWorkerJoinKey), so a key is
 * never created for a bootstrap that is only queued — and a retry cannot leave two
 * valid keys for the same slot.
 */
export interface WorkerSpawn {
  id: string;
  task: string;
}

/** Workers that have been created but have not joined: their chat is still owed. */
export function pendingWorkerSpawns(): WorkerSpawn[] {
  return [...agents.values()]
    .filter((agent) => agent.info.role === 'worker' && agent.info.state === 'invited')
    .map((agent) => ({ id: agent.info.id, task: agent.info.task }));
}

/**
 * The bridge registers here, so the broker never has to know about HTTP or tabs.
 *
 * Registration replays whatever is already owed. Startup restores the run before the
 * bridge exists — it has to, so a restored worker and a fresh one go through the same
 * queue — which means the restore itself has nobody to ask for a tab. Without this
 * replay a worker that was invited before the restart, and whose bootstrap had already
 * been acknowledged, would sit `invited` forever with no command to reopen it.
 */
export function onSpawnRequest(handler: (workers: WorkerSpawn[]) => void): void {
  spawnRequest = handler;
  const owed = pendingWorkerSpawns();
  if (owed.length > 0) {
    handler(owed);
    logInfo(`multi-agent: ${owed.length} worker chat(s) still owed a tab`);
  }
}

/**
 * Mints a credential: registers it for scrubbing, and returns the plaintext once.
 *
 * The plaintext is returned to exactly one caller and never stored. What is kept is
 * the hash, plus a registration in agent-secrets.ts so that if the model ever echoes
 * the credential back through a tool call, the recorder strips it before disk.
 */
function mintFor(agent: Agent, what: 'secret' | 'join'): string {
  const value = mintKey();
  registerAgentSecret(value);
  if (what === 'secret') {
    bySecret.delete(agent.secretHash);
    agent.secretHash = sha256(value);
    bySecret.set(agent.secretHash, agent.info.id);
  } else {
    agent.joinKeyHash = sha256(value);
  }
  return value;
}

function makeAgent(id: string, role: AgentRole, label: string, task: string): Agent {
  return {
    info: {
      id,
      role,
      label,
      task,
      state: role === 'prime' ? 'active' : 'invited',
      createdAt: Date.now(),
      joinedAt: role === 'prime' ? Date.now() : null,
      finishedAt: null,
      result: null,
      pending: 0,
      awaitingAck: 0,
      delivered: 0,
      conversationId: null,
      claims: []
    },
    queue: [],
    secretHash: '',
    joinKeyHash: null,
    transportKey: null
  };
}

function requireEnabled(): void {
  if (!getConfig().multiAgent.enabled) {
    throw new AgentError('Multi-agent mode is switched off in ChatGPT Local Files. Ask the user to enable it.');
  }
}

function get(id: string): Agent {
  const agent = agents.get(id);
  if (!agent) throw new AgentError(`Unknown agent "${id}". Call agent_status to see who exists.`);
  return agent;
}

function recount(agent: Agent): void {
  const live = agent.queue.filter((message) => message.ackedAt === null);
  agent.info.pending = live.length;
  agent.info.awaitingAck = live.filter((message) => message.offeredAt !== null).length;
}

// ---------------------------------------------------------------- identity

/** What a caller can offer as proof of who it is. Neither field is an agent id. */
export interface Caller {
  /** MCP transport session, when the transport provides one. */
  transportKey?: string | null;
  /** The key this agent was given when it joined. */
  secret?: string | null;
}

function bind(agent: Agent, transportKey: string | null | undefined): void {
  if (!transportKey) return;
  if (agent.transportKey && agent.transportKey !== transportKey) byTransport.delete(agent.transportKey);
  agent.transportKey = transportKey;
  byTransport.set(transportKey, agent.info.id);
}

function unbind(agent: Agent): void {
  if (agent.transportKey) byTransport.delete(agent.transportKey);
  agent.transportKey = null;
}

/** The caller's agent record, or null when nothing identifies it. Never throws. */
function resolve(caller: Caller): Agent | null {
  const byKey = caller.transportKey ? byTransport.get(caller.transportKey) : undefined;
  const bySec = caller.secret ? bySecret.get(sha256(caller.secret)) : undefined;
  // A key naming a different agent than the transport does is not a mix-up worth
  // resolving in the caller's favour: it is the shape of one worker borrowing another's
  // identity, so neither is accepted.
  if (byKey && bySec && byKey !== bySec) return null;
  const id = byKey ?? bySec;
  return id ? (agents.get(id) ?? null) : null;
}

/** Resolves who is calling, or refuses with something the model can act on. */
export function identify(caller: Caller): AgentInfo {
  requireEnabled();
  const agent = resolve(caller);
  if (!agent) {
    throw new AgentError(
      'This conversation is not registered as an agent in this run, or the key it presented is not valid. ' +
        'A worker calls join_agent with the key from the message that opened its chat; after that it passes ' +
        'that agent_key on every call. The prime agent uses the key it was given when it created the workers.'
    );
  }
  return { ...agent.info };
}

/** Attribution for an ordinary tool call: only ever a binding, never a claim. */
export function agentForCaller(caller: Caller): string | null {
  if (!getConfig().multiAgent.enabled) return null;
  return resolve(caller)?.info.id ?? null;
}

// ------------------------------------------------------------------ create

export interface CreateAgentsInput {
  workers: ReadonlyArray<{ label?: string; task: string }>;
  caller: Caller;
}

export interface CreateAgentsResult {
  created: AgentInfo[];
  /** Issued only on the call that established the prime, and only to that caller. */
  primeSecret: string | null;
}

/**
 * Creates workers on behalf of the prime.
 *
 * The first caller becomes the prime and is handed the prime key: at that instant it
 * is the only agent in the run, so there is nobody to impersonate and nothing to
 * steal. Every later call must present that key, or arrive on the prime's bound
 * transport — which is what stops a worker from quietly recruiting workers of its own.
 */
export function createAgents(input: CreateAgentsInput): CreateAgentsResult {
  requireEnabled();
  const max = getConfig().multiAgent.maxWorkers;
  const live = [...agents.values()].filter((a) => a.info.role === 'worker' && a.info.state !== 'finished');
  if (input.workers.length === 0) throw new AgentError('At least one worker is required');
  if (live.length + input.workers.length > max) {
    throw new AgentError(
      `That would make ${live.length + input.workers.length} live workers; the limit set in the app is ${max}.`
    );
  }

  let primeSecret: string | null = null;
  let prime = agents.get(PRIME_ID);
  if (!prime) {
    prime = makeAgent(PRIME_ID, 'prime', 'Prime', 'Coordinates the workers');
    agents.set(PRIME_ID, prime);
    primeSecret = mintFor(prime, 'secret');
  } else if (resolve(input.caller)?.info.id !== PRIME_ID) {
    throw new AgentError(
      'Only the prime agent can create workers, and this call did not present the prime agent key. ' +
        'Workers must not create workers of their own.'
    );
  }
  bind(prime, input.caller.transportKey);

  const created: AgentInfo[] = [];
  const spawn: WorkerSpawn[] = [];
  for (const [index, worker] of input.workers.entries()) {
    const task = worker.task.trim();
    if (!task) throw new AgentError(`Worker ${index + 1} has no task. Every worker needs one.`);
    if (task.length > MAX_TASK_CHARS) throw new AgentError(`Worker ${index + 1}'s task is too long`);
    const id = nextWorkerId();
    const agent = makeAgent(id, 'worker', worker.label?.trim() || id, task);
    agents.set(id, agent);
    mintFor(agent, 'secret');
    created.push({ ...agent.info });
    spawn.push({ id, task });
  }

  if (spawnRequest) {
    spawnRequest(spawn);
  } else {
    logWarn('multi-agent: no browser extension is paired, so worker chats cannot be opened automatically');
  }
  logInfo(`multi-agent: created ${created.length} worker(s)`);
  changed();
  return { created, primeSecret };
}

function nextWorkerId(): string {
  for (let n = 1; n <= 64; n++) {
    const id = `worker-${n}`;
    if (!agents.has(id)) return id;
  }
  throw new AgentError('Too many workers have been created in this run');
}

// -------------------------------------------------------------------- join

export interface JoinResult {
  info: AgentInfo;
  /**
   * The agent's key for the rest of the run, returned once to the joiner only. Empty
   * when an already-joined agent re-sent its bootstrap and keeps the key it has.
   */
  secret: string;
}

/**
 * Redeems a one-time key and takes on that agent's identity.
 *
 * Used by a worker joining the run, and by a fresh prime chat after Compact & Resume.
 * Either way the key is spent on use and the agent's key is rotated, so a second
 * conversation replaying the same opening message cannot take over a live agent, and
 * the chat that held the previous key stops being able to act as that agent.
 */
export function joinAgent(joinKey: string, caller: Caller = {}): JoinResult {
  requireEnabled();
  const key = joinKey.trim();
  if (!key) throw new AgentError('A join key is required. It is in the message that opened this chat.');
  const hash = sha256(key);
  const agent = [...agents.values()].find((entry) => entry.joinKeyHash === hash);
  if (!agent) {
    const already = resolve(caller);
    // A worker that re-sends its opening message is not an error worth failing: if it
    // is already bound, hand back what it already is rather than inventing a new slot.
    if (already) return { info: { ...already.info }, secret: '' };
    throw new AgentError('That join key is not valid. It may already have been used, or the run may have ended.');
  }
  if (agent.info.state === 'finished') throw new AgentError(`${agent.info.id} has already finished`);
  agent.joinKeyHash = null;
  agent.info.state = 'active';
  agent.info.joinedAt = agent.info.joinedAt ?? Date.now();
  unbind(agent);
  bind(agent, caller.transportKey);
  const secret = mintFor(agent, 'secret');
  logInfo(`multi-agent: ${agent.info.id} joined`);
  changed();
  return { info: { ...agent.info }, secret };
}

/**
 * A fresh one-time join key for a worker that has not joined yet.
 *
 * The bridge asks for this when it is about to hand a bootstrap command to the
 * extension, which is what keeps the key out of the durable command queue: nothing on
 * disk carries a usable credential, and the key is created at the moment the browser is
 * actually going to type it. Re-issuing invalidates the previous one, so a retry after
 * a failed insertion cannot leave two valid keys for the same slot.
 *
 * Returns null when the worker is gone or has already joined — there is nothing left to
 * bootstrap, and minting would only reopen a door that is correctly shut.
 */
export function mintWorkerJoinKey(id: string): string | null {
  const agent = agents.get(id);
  if (!agent || agent.info.role !== 'worker' || agent.info.state !== 'invited') return null;
  const key = mintFor(agent, 'join');
  changed();
  return key;
}

/**
 * Mints a one-time key that lets a fresh chat take over as prime.
 *
 * Compact & Resume moves the prime to a new conversation while the workers keep
 * running, and the old prime key is deliberately unrecoverable — it is scrubbed out of
 * the recorded history and the handoff, which is the whole point. So the resume
 * bootstrap carries this instead: a single-use capability, valid only until it is
 * redeemed, which rotates the prime key and rebinds the role to the new chat. Nothing
 * reusable is ever written into a handoff.
 */
export function mintPrimeHandover(): string | null {
  if (!getConfig().multiAgent.enabled) return null;
  const prime = agents.get(PRIME_ID);
  if (!prime) return null;
  const key = mintFor(prime, 'join');
  logInfo('multi-agent: minted a one-time prime handover key for the resumed chat');
  changed();
  return key;
}

// ----------------------------------------------------------------- routing

/**
 * Star topology, enforced.
 *
 * Two workers talking directly is the thing this mode must not allow: it is how a
 * swarm silently negotiates a plan the user never sees and the prime cannot report.
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
 * Refusing is the point. Dropping the oldest waiting message to make room would throw
 * away a task or a result while still telling the sender it was sent, and there is no
 * way for anyone to notice that later.
 */
function enqueue(to: Agent, message: AgentMessage): void {
  const waiting = to.queue.filter((item) => item.ackedAt === null).length;
  if (waiting >= MAX_QUEUE) {
    throw new AgentError(
      `QUEUE_FULL: ${to.info.id} already has ${waiting} unacknowledged messages, which is the limit. ` +
        'Nothing was sent and nothing was discarded. Check agent_status — a queue this deep normally means ' +
        'that agent has stopped calling tools.'
    );
  }
  to.queue.push(message);
  // Acknowledged messages are durable session events by then, so trimming the settled
  // tail loses nothing; only the unacknowledged ones are load-bearing.
  if (to.queue.length > MAX_QUEUE * 2) {
    const settled = to.queue.filter((item) => item.ackedAt !== null).slice(-MAX_QUEUE);
    to.queue = [...settled, ...to.queue.filter((item) => item.ackedAt === null)];
  }
  recount(to);
}

/**
 * Sends a message from the caller — whoever the broker says that is — to `toId`.
 *
 * There is deliberately no "from" parameter. The sender is derived from the caller's
 * binding, so the star topology cannot be sidestepped by writing someone else's id.
 */
export function sendMessage(caller: Caller, toId: string, text: string): AgentMessage {
  requireEnabled();
  const trimmed = text.trim();
  if (!trimmed) throw new AgentError('The message is empty');
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new AgentError(`Message is too long (limit ${MAX_MESSAGE_CHARS} characters)`);
  }
  const from = get(identify(caller).id);
  const to = get(toId);
  assertRoute(from, to);
  if (to.info.state === 'finished') throw new AgentError(`${toId} has finished and is no longer listening`);

  const message: AgentMessage = {
    id: randomUUID().slice(0, 8),
    from: from.info.id,
    to: toId,
    time: Date.now(),
    text: trimmed,
    offeredAt: null,
    offers: 0,
    ackedAt: null
  };
  enqueue(to, message);
  changed();
  return { ...message };
}

/**
 * Messages to put in this agent's next tool result.
 *
 * Includes anything already offered but not yet acknowledged. That is the deliberate
 * at-least-once trade: if the previous result never reached ChatGPT — the connector
 * dropping mid-turn is a failure this project has actually reproduced — the message
 * comes round again instead of vanishing. `offers > 1` lets the caller label a repeat
 * so the model can recognise one it has already acted on.
 */
export function offerMessages(id: string): AgentMessage[] {
  const agent = agents.get(id);
  if (!agent) return [];
  const waiting = agent.queue.filter((message) => message.ackedAt === null);
  if (waiting.length === 0) return [];
  const now = Date.now();
  for (const message of waiting) {
    message.offeredAt = now;
    message.offers += 1;
  }
  recount(agent);
  changed();
  return waiting.map((message) => ({ ...message }));
}

/**
 * Retires everything previously offered to this agent.
 *
 * Called at the start of that agent's *next* authenticated call, because that call is
 * the only real evidence the previous tool result made it back into the conversation.
 * Returns what was retired, so the caller can write the durable delivery record once.
 */
export function acknowledgeOffers(id: string): AgentMessage[] {
  const agent = agents.get(id);
  if (!agent) return [];
  const offered = agent.queue.filter((message) => message.ackedAt === null && message.offeredAt !== null);
  if (offered.length === 0) return [];
  const now = Date.now();
  for (const message of offered) message.ackedAt = now;
  agent.info.delivered += offered.length;
  recount(agent);
  changed();
  return offered.map((message) => ({ ...message }));
}

export function pendingCount(id: string): number {
  return agents.get(id)?.info.pending ?? 0;
}

// ------------------------------------------------------------------ finish

export interface FinishResult {
  info: AgentInfo;
  /** The report queued for the prime, so the caller can record it durably. */
  report: AgentMessage | null;
}

/** Finishes the caller. An agent can only ever finish itself. */
export function finishAgent(caller: Caller, result: string): FinishResult {
  requireEnabled();
  const agent = get(identify(caller).id);
  const id = agent.info.id;
  agent.info.state = 'finished';
  agent.info.finishedAt = Date.now();
  agent.info.result = result.slice(0, MAX_MESSAGE_CHARS);
  let report: AgentMessage | null = null;
  if (agent.info.role === 'worker' && agents.has(PRIME_ID)) {
    report = {
      id: randomUUID().slice(0, 8),
      from: id,
      to: PRIME_ID,
      time: Date.now(),
      text: `[${id} finished] ${agent.info.result}`,
      offeredAt: null,
      offers: 0,
      ackedAt: null
    };
    // A full prime queue must not swallow a worker's final report: the worker is about
    // to stop existing and has no way to retry it. It goes in over the limit, and the
    // depth shows up in agent_status instead.
    const prime = get(PRIME_ID);
    prime.queue.push(report);
    recount(prime);
  }
  logInfo(`multi-agent: ${id} finished`);
  changed();
  return { info: { ...agent.info }, report: report ? { ...report } : null };
}

// ------------------------------------------------------------------- state

export function swarmState(): SwarmState {
  const list = [...agents.values()].map((agent) => ({ ...agent.info }));
  list.sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'prime' ? -1 : 1));
  return {
    enabled: getConfig().multiAgent.enabled,
    running: list.some((info) => info.role === 'worker' && info.state !== 'finished'),
    agents: list
  };
}

export function agentConversation(id: string): string | null {
  return agents.get(id)?.info.conversationId ?? null;
}

/** Reverse lookup used to file a recorded event into the right session. */
export function agentForConversation(conversationId: string): string | null {
  for (const agent of agents.values()) {
    if (agent.info.conversationId === conversationId) return agent.info.id;
  }
  return null;
}

/**
 * Records which ChatGPT conversation an agent is running in.
 *
 * Called by the bridge when the extension acknowledges the tab it opened, which is the
 * one place that knows the mapping first-hand. It is not proof of identity for broker
 * calls — the extension is not the agent — only a way to file the agent's recorded
 * history in the right session and show it in the UI.
 */
export function bindConversation(id: string, conversationId: string): void {
  const agent = agents.get(id);
  if (agent && agent.info.conversationId !== conversationId) {
    agent.info.conversationId = conversationId;
    changed();
  }
}

/**
 * Files an agent says it is working on.
 *
 * Advisory only: this app cannot lock a file that the user's own editor may also be
 * writing. It exists so the prime and the user can see an overlap coming instead of
 * discovering it in a mangled file.
 */
export function claimFiles(id: string, paths: readonly string[]): string[] {
  const agent = agents.get(id);
  if (!agent) return [];
  const clashes: string[] = [];
  for (const other of agents.values()) {
    if (other.info.id === id || other.info.state === 'finished') continue;
    for (const path of paths) {
      if (other.info.claims.includes(path)) clashes.push(`${path} (also claimed by ${other.info.id})`);
    }
  }
  agent.info.claims = [...new Set([...agent.info.claims, ...paths])].slice(0, 64);
  changed();
  return clashes;
}

/** Ends the run. Called when the user turns the mode off or clears the swarm. */
export function resetSwarm(): void {
  agents.clear();
  bySecret.clear();
  byTransport.clear();
  forgetAgentSecrets();
  changed();
}

export function swarmRunning(): boolean {
  return [...agents.values()].some((agent) => agent.info.role === 'worker' && agent.info.state !== 'finished');
}

// ------------------------------------------------------------- persistence

/**
 * What survives a restart.
 *
 * Agent state and unacknowledged messages are the parts that cannot be reconstructed:
 * the raw session log is the audit trail, but it does not know which messages were
 * still in flight. Credentials cross this boundary as hashes only — enough to keep
 * recognising an agent that still holds its key, never enough for this file to hand
 * one out.
 */
export interface SwarmSnapshot {
  version: 1;
  savedAt: number;
  agents: Array<{
    info: AgentInfo;
    queue: AgentMessage[];
    secretHash: string;
    joinKeyHash: string | null;
  }>;
}

export function snapshotSwarm(): SwarmSnapshot | null {
  if (agents.size === 0) return null;
  return {
    version: 1,
    savedAt: Date.now(),
    agents: [...agents.values()].map((agent) => ({
      info: { ...agent.info },
      // Acknowledged messages are already durable session events; what has to survive
      // here is the in-flight tail.
      queue: agent.queue.filter((message) => message.ackedAt === null).map((message) => ({ ...message })),
      secretHash: agent.secretHash,
      joinKeyHash: agent.joinKeyHash
    }))
  };
}

/**
 * Restores a run from disk.
 *
 * Transport bindings are deliberately not restored: a transport session does not
 * survive this process, so carrying the old ids over would bind an identity to a
 * handle that now belongs to nobody. Keys are recognised by hash, so an agent whose
 * chat is still open simply keeps working.
 *
 * Messages that were in flight come back unoffered rather than delivered — the app
 * cannot know whether the result carrying them ever arrived, and offering one twice is
 * the recoverable half of that uncertainty.
 *
 * A worker that had been invited but never joined is a special case: its join key was
 * only ever delivered by a bootstrap message that may never have been typed, and the
 * plaintext is gone. Those get a fresh key and a fresh spawn request, so recovery is a
 * retry rather than a worker that can never join.
 */
export function restoreSwarm(snapshot: SwarmSnapshot | null): void {
  agents.clear();
  bySecret.clear();
  byTransport.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.agents)) return;
  for (const entry of snapshot.agents) {
    if (!entry?.info?.id) continue;
    const agent: Agent = {
      info: { ...entry.info, claims: entry.info.claims ?? [] },
      queue: (Array.isArray(entry.queue) ? entry.queue : []).map((message) => ({ ...message, offeredAt: null })),
      secretHash: entry.secretHash,
      joinKeyHash: entry.joinKeyHash,
      transportKey: null
    };
    recount(agent);
    agents.set(entry.info.id, agent);
    if (entry.secretHash) bySecret.set(entry.secretHash, entry.info.id);
  }

  // A worker that had been invited but never joined needs its chat opened again: the
  // key it was originally offered is gone with the process. If the bridge is not
  // registered yet — at startup it is not, because the run is restored first — this is
  // replayed by onSpawnRequest the moment it registers.
  const stranded = pendingWorkerSpawns();
  if (stranded.length > 0 && spawnRequest) {
    spawnRequest(stranded);
    logInfo(`multi-agent: re-requested ${stranded.length} worker chat(s) that had not joined before the restart`);
  }
  const pending = [...agents.values()].reduce((sum, agent) => sum + agent.info.pending, 0);
  if (agents.size > 0) {
    logInfo(`multi-agent: restored ${agents.size} agent(s) with ${pending} undelivered message(s)`);
  }
}

/** Test seam: forgets everything without touching disk. */
export function resetAgentsForTests(): void {
  agents.clear();
  bySecret.clear();
  byTransport.clear();
  forgetAgentSecrets();
  spawnRequest = null;
  persist = null;
  listeners.clear();
}
