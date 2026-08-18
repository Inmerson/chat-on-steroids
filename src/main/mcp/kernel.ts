/**
 * The machinery every model-facing tool sits on, independent of which surface it lives on.
 *
 * The tools themselves are split by connector — `tools-core.ts` and `tools-desktop.ts` —
 * because a connector is a discovery boundary and that split is the whole point of the
 * design (see `docs/tool-surface.md` §6.4). None of what is in this file is surface-shaped:
 * error mapping, the call clock, the recording context, the agent key and the result
 * formatters behave identically wherever a tool is registered, and duplicating them per
 * surface is how two connectors would quietly start reporting the same thing differently.
 *
 * A tool first appears when its capability is enabled. For the lifetime of a running MCP
 * endpoint the exposed surface is monotonic: if that permission is later revoked, the tool
 * stays registered so a cached ChatGPT tool snapshot does not break, while the live handler
 * returns TOOL_DISABLED. Read-only mode is applied upstream in effectiveCapabilities, so a
 * fresh endpoint starts with every write tool absent.
 *
 * Annotations matter for real behaviour, not just documentation: ChatGPT treats a tool
 * without readOnlyHint as a write action and asks the user to confirm each call, so every
 * genuinely read-only tool is marked as such.
 */

import { rawPromises as fs } from '../rawfs.js';
import { inboundRequestId, requestIdFromHeader } from './inbound.js';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Capabilities, Root } from '../../shared/types.js';
import { FsOpError, formatBytes, type FileInfo } from '../fsops.js';
import { logInfo, logWarn } from '../logger.js';
import { SandboxError, isAbsoluteVirtualPath, resolvePath, type Resolved } from '../sandbox.js';
import { currentWorkspace, learnWorkspace } from '../workspace.js';
import { ExecError, MAX_ENV_KEY_CHARS, MAX_ENV_VALUE_CHARS, MAX_ENV_VARS } from '../exec.js';
import { ProcessError, type ManagedProcessStatus } from '../process-manager.js';
import { ComputerError } from '../computer/index.js';
import { getConfig } from '../config.js';
import { AgentError, acknowledgeOffers, agentForCaller, offerMessages, swarmRunning } from '../agents.js';
import type { SurfaceId } from './surfaces.js';
import {
  currentCall,
  emptyEvidence,
  noteOutcome,
  runInCallContext,
  trackInFlight,
  type CallContext
} from './call-context.js';
import { freshCallOrigin, recordAgentMessage, recordToolCall } from '../session/recorder.js';
import { readOverflowText } from '../session/store.js';
import type { SessionEvent, StoredText } from '../../shared/session.js';

export interface ToolContext {
  roots: Root[];
  /** Capabilities currently allowed by the live settings. */
  caps: Capabilities;
  /**
   * Capabilities whose tools must remain registered for the lifetime of the local MCP
   * endpoint. This prevents an already-cached ChatGPT tool snapshot from turning into
   * UNKNOWN when the user disables a permission mid-session. Calls are still checked
   * against `caps` and return TOOL_DISABLED instead of executing.
   */
  exposedCaps?: Capabilities;
  readOnly: boolean;
  /** When on, an unspecified screenshot captures only the foreground window. */
  privacyScreenshots?: boolean;
  /** Whether session recording is live right now. Defaults to the live setting. */
  sessionTools?: boolean;
  /** Whether multi-agent mode is live right now. Defaults to the live setting. */
  agentTools?: boolean;
  /**
   * Whether these feature tools must stay registered for the lifetime of the endpoint,
   * for the same reason as `exposedCaps`: ChatGPT caches a tools/list snapshot, and a
   * tool that disappears from under a cached snapshot surfaces as a transport-level
   * failure rather than a tidy error. Default to the live values.
   */
  exposedSessionTools?: boolean;
  exposedAgentTools?: boolean;
  /**
   * Whether `find` must stay registered for the lifetime of the endpoint.
   *
   * `find` and the exec pair are mutually exclusive, and that choice cannot be derived
   * from `exposedCaps.command` on each request: `exposedCaps` only ever widens, so a user
   * switching command execution on mid-run would silently *delete* `find` from under a
   * cached ChatGPT snapshot — the exact stale-snapshot failure the monotonic rule exists
   * to prevent. So the decision is made once, from the live capabilities, and then only
   * ever added to. Defaults to the live answer when the caller does not track it.
   */
  exposedFind?: boolean;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; isError?: boolean };

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Lines in a string, for the "+214" on a newly created file. */
export function countTextLines(text: string): number {
  if (text === '') return 0;
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r\n|\n|\r/).length;
}

/** Prefixes read output with line numbers. Display metadata, never file content. */
export function numberReadLines(text: string, firstLine: number): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line, index) => `${firstLine + index}\t${line}`)
    .join('\n');
}

/** Maps runtime errors to short model-facing text without ever exposing real paths. */
export function friendlyError(err: unknown): string {
  if (err instanceof SandboxError || err instanceof ComputerError) return err.message;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Not found';
  if (code === 'EACCES' || code === 'EPERM') return 'Access denied by Windows';
  if (code === 'EBUSY') return 'The file is in use by another program';
  if (code === 'ENOTEMPTY') return 'Directory is not empty';
  if (code === 'EEXIST') return 'Already exists';
  return err instanceof Error ? err.message : String(err);
}

/**
 * Epoch ms of the last tool ChatGPT actually ran, or null if it never has.
 *
 * Deliberately separate from "a request arrived". ChatGPT connects, initialises and
 * lists tools on every connect even when the model is then forbidden to use them —
 * which is precisely what an account with Developer mode switched off looks like from
 * here. Only a tool that ran proves the whole chain, model included, works.
 *
 * Kept per surface as well as overall. "Has ChatGPT ever run a tool here" is the only
 * honest proof a connector was created and works, and with two connectors the answer for
 * one says nothing about the other — a user whose Core connector is fine and whose
 * Desktop connector was never added would otherwise see setup reported as finished.
 */
let toolCallSeenAt: number | null = null;
const surfaceToolCallAt = new Map<SurfaceId, number>();

export function lastToolCallAt(surface?: SurfaceId): number | null {
  if (surface === undefined) return toolCallSeenAt;
  return surfaceToolCallAt.get(surface) ?? null;
}

/** Cleared with the server, so the answer is always about the current session. */
export function resetToolClock(): void {
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}

/**
 * Turns any thrown error into a tool execution error the model can act on, and keeps
 * unexpected internals out of the response. Error results are logged with only their
 * first line, so Activity stays useful without copying command output or file contents.
 */
export async function guard(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  // Counted before the work, and counted even when the tool is disabled or fails:
  // the question this answers is whether the model may call us at all.
  toolCallSeenAt = started;
  try {
    const result = await fn();
    const elapsed = Date.now() - started;
    if (result.isError) {
      const summary = result.content
        .find((item): item is Extract<ToolContent, { type: 'text' }> => item.type === 'text')
        ?.text.split(/\r?\n/, 1)[0]
        ?.slice(0, 500);
      // A rejected edit, disabled permission, stale cursor, etc. is a normal tool
      // outcome, not evidence that the connector itself is unhealthy.
      noteOutcomeSafely('rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms${summary ? `: ${summary}` : ''}`);
    } else {
      noteOutcomeSafely('ok');
      logInfo(`tool ${name} ok in ${elapsed} ms`);
    }
    return result;
  } catch (err) {
    const message = friendlyError(err);
    const elapsed = Date.now() - started;
    if (
      err instanceof SandboxError ||
      err instanceof ComputerError ||
      err instanceof FsOpError ||
      err instanceof ExecError ||
      err instanceof ProcessError ||
      err instanceof AgentError
    ) {
      noteOutcomeSafely('rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms: ${message}`);
    } else {
      noteOutcomeSafely('error');
      logWarn(`tool ${name} failed in ${elapsed} ms: ${message}`);
    }
    return fail(message);
  }
}

// noteOutcome is only meaningful inside a call context; guard is also used by tests and
// by internal paths that have none, and a missing context must not turn into an error.
function noteOutcomeSafely(outcome: 'ok' | 'rejected' | 'error'): void {
  try {
    noteOutcome(outcome);
  } catch {
    /* no call context: nothing to record against */
  }
}

/**
 * The conversation this call was made from, if this call itself proved it.
 *
 * The only identity any agent has, and the reason no tool here carries a key. It reads one
 * thing: ChatGPT's own message model naming *this* tool request, in exactly one conversation,
 * at or after the moment this call started. Not `provenConversation()` — that reports whichever
 * chat has drawn connector rows lately and keeps answering for a minute after that chat went
 * quiet, which on a machine with one busy chat says the same thing whoever is calling. Not the
 * active chat, not the last chat, not a guess.
 *
 * Deliberately non-blocking, and deliberately after the handler has run. Non-blocking because
 * this is on the path of every ordinary read and exec, and waiting on the browser to answer a
 * question about attribution would make the browser a dependency of reading a file. After the
 * handler because the page reports on its own tick: a call that took a second has had a second
 * for its evidence to arrive, which is exactly the calls whose attribution matters most.
 *
 * A call that cannot be placed simply has no agent. It is not refused — most calls in most
 * installs are an ordinary chat with no swarm anywhere near it, and a phone talking to the same
 * connector is not a worker impersonation attempt. What it does not get is somebody else's
 * inbox, and control of the run: `agents` establishes identity for itself, and refuses without
 * it by name.
 */
function callerConversation(tool: string, startedAt: number, requestId: string | null): string | null {
  // Only while a run exists. Off by default, and nothing else here consults it.
  if (!swarmRunning()) return null;
  return freshCallOrigin(tool, startedAt, requestId);
}

/**
 * What the protocol layer hands a handler, as much of it as this app reads.
 *
 * `http.headers` is where ChatGPT's own request id arrives. Optional throughout, because a
 * different client — the tests, another MCP host — supplies none of it, and identity then
 * falls back to page evidence exactly as before.
 */
interface McpCallContext {
  sessionId?: string;
  http?: { headers?: Record<string, string | string[] | undefined> };
}

/**
 * ChatGPT's id for this request, from `x-request-id`, without the per-attempt suffix.
 *
 * The header arrives as `wfr_<id>/<suffix>` and ChatGPT's own message model holds the
 * `wfr_<id>` half, so the suffix is dropped rather than matched on. Measured live on
 * 2026-08-18: header `wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1`, page evidence
 * `read#wfr_01a014bdd7cd7a15b6b533d3ce2b42f2`.
 *
 * This is what makes caller identity a lookup instead of an inference. Before it, two
 * workers of the same run calling `agents` seconds apart were indistinguishable — both
 * conversations had named an unclaimed `agents` request inside the same window — and both
 * were refused WORKER_IDENTITY_LOST. Nothing about timing needs to be assumed now.
 */
function requestIdOf(mcpCtx: McpCallContext | undefined): string | null {
  // The call context is tried first and is not where it has ever been found: live, the
  // header is on the socket and `mcpCtx.http.headers` is null. The HTTP handler therefore
  // carries it alongside the call, and that is the value that actually arrives here.
  return requestIdFromHeader(mcpCtx?.http?.headers?.['x-request-id']) ?? inboundRequestId();
}

/**
 * Whether the MCP transport ever gave us a session id, once a real call has arrived.
 *
 * Recorded rather than assumed, because it is the one thing that would let this app know
 * which conversation is calling without asking the browser at all. Until it does, identity
 * comes from page evidence. This is what the Activity log reports on the first tool call of
 * each run.
 */
let transportIdentity: { checked: boolean; present: boolean } = { checked: false, present: false };

export function transportIdentityStatus(): { checked: boolean; present: boolean } {
  return { ...transportIdentity };
}

function noteTransportIdentity(transportKey: string | null): void {
  if (transportIdentity.checked) return;
  transportIdentity = { checked: true, present: transportKey !== null };
  logInfo(
    transportKey
      ? 'MCP transport supplied a session id — agent identity could be bound to the transport'
      : 'MCP transport supplied no session id (stateless connector) — agent identity comes from page evidence'
  );
}

/**
 * Appends the messages waiting for this agent to the tool result.
 *
 * This is the push-like delivery: an agent gets whatever has been said to it since its last
 * call, at the end of every result, with no polling loop. It works for a call this app could
 * place in a conversation, which is most of them and never all of them — so nothing is
 * retired here, and a message the page could not confirm is simply offered again next time.
 *
 * Messages are *offered* here, not retired. They are retired when this agent calls
 * again, because that is the first real evidence this result reached ChatGPT.
 */
function withInbox(agent: string | null, result: ToolResult, onFinish = false): ToolResult {
  if (!agent) return result;
  const messages = offerMessages(agent, onFinish);
  if (messages.length === 0) return result;
  const lines = messages
    .map(
      (message) =>
        `• [${message.id}] from ${message.from}${message.offers > 1 ? ' (repeat — you may have seen this)' : ''}: ${message.text}`
    )
    .join('\n');
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: `\n--- ${messages.length} message(s) for ${agent} ---\n${lines}` }
    ]
  };
}

/**
 * Runs one tool call inside a recording context.
 *
 * Registration is wrapped rather than each handler, so the arguments and the result
 * recorded are exactly the ones that crossed the wire — the recorder never has to
 * reconstruct a call from a log line — and so identity is resolved in one place.
 *
 * `finishing` replaces the old `name === 'finish_agent'` test: with the collapsed
 * `agents` tool the terminal call is an *action* rather than a tool name, and the
 * re-offer rule has to follow the action.
 */
async function dispatch(
  name: string,
  args: unknown,
  transportKey: string | null,
  requestId: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  noteTransportIdentity(transportKey);
  // Recorded here rather than in `guard` because only this layer knows which server
  // answered, and "was this connector ever actually used from ChatGPT" is a per-connector
  // question the setup screen has to answer honestly.
  surfaceToolCallAt.set(surface, Date.now());
  const isFinish = isFinishCall(name, args);
  const context: CallContext = {
    transportKey,
    agent: null,
    caller: { transportKey, requestId, conversationId: null },
    outcome: null,
    evidence: emptyEvidence()
  };
  const startedAt = Date.now();
  const result = await trackInFlight(() => runInCallContext(context, run));
  // Identity, once, from this call's own evidence — see callerConversation. `agents` has
  // already established its own inside the call and adopted it, and re-reading here would
  // only be able to disagree with the stronger answer it waited for.
  if (!context.agent) {
    context.caller.conversationId = callerConversation(name, startedAt, requestId);
    context.agent = agentForCaller(context.caller);
  }
  // This call is the best evidence there is that the previous result reached the agent's
  // conversation, so anything offered then can be retired and written to its history —
  // except what was offered on a finish result, which this call may itself be the retry
  // of. The connector supplies no request identity to tell those apart, so the broker
  // re-offers rather than assuming; see acknowledgeOffers.
  if (context.agent) {
    for (const message of acknowledgeOffers(context.agent, isFinish)) await recordAgentMessage(message, 'delivered');
  }
  // This is the MCP call's wall-clock latency. A managed child can outlive the call, and
  // its own lifetime is process evidence; letting that number overwrite ToolCallRecord's
  // duration is what made a 10s yield read like a command that had completed in 10s.
  const durationMs = Date.now() - startedAt;
  // Deliberately not awaited. Attribution may have to wait a moment for the page to
  // report the tool block that shows where this call came from, and ChatGPT must never
  // wait on the browser for that; the recorder queues the write and keeps call order.
  void recordToolCall({
    tool: name,
    args,
    content: result.content,
    outcome: context.outcome ?? (result.isError ? 'rejected' : 'ok'),
    durationMs,
    startedAt,
    evidence: context.evidence,
    agent: context.agent,
    bind: context.bindOnAttribution ?? null,
    requestId: context.caller.requestId
  });
  return withInbox(context.agent, result, isFinish);
}

/**
 * Adopts an identity established *inside* a tool call.
 *
 * The dispatcher can only resolve a caller from what the call carried, which for the prime
 * is nothing at all. The `agents` tool proves who is calling from evidence rendered after
 * that call began, and this is how that answer gets back to the layers that need it: the
 * record this call will be filed under, and the inbox attached to its result. Called only
 * from the one tool that does that work, and only with an id it has just proven.
 */
export async function adoptAgent(agent: string | null): Promise<void> {
  const context = currentCall();
  if (!context || !agent || context.agent === agent) return;
  context.agent = agent;
  // The same at-least-once rule the dispatcher applies: this call is the evidence that
  // the previous result reached that conversation. A finish cannot arrive here — it is a
  // worker action, and a worker is resolved by its code before the call ever runs.
  for (const message of acknowledgeOffers(agent, false)) await recordAgentMessage(message, 'delivered');
}

function isFinishCall(name: string, args: unknown): boolean {
  if (name !== 'agents') return false;
  if (!args || typeof args !== 'object') return false;
  return (args as Record<string, unknown>)['action'] === 'finish';
}

/**
 * A path named by a tool call, resolved against the chat's workspace when it is relative.
 *
 * Every path argument in every tool goes through here rather than calling `resolvePath`
 * directly, for two reasons. Shorthand then means the same thing in `read` as in `exec` as in
 * `apply_patch` — a model that learns it once has learned it everywhere — and the workspace is
 * learned from every absolute path a call has *proved* it can reach, so no tool has to
 * remember to teach it.
 *
 * The sandbox underneath is untouched. `resolvePath` still performs every root, containment,
 * `..` and symlink check it ever did; the workspace only supplies a prefix for a path that
 * arrived without one, before any of that runs. A chat with no workspace gets the same
 * refusal it would have got for a relative path before, which is why ambiguity here costs a
 * retry rather than reaching the wrong file.
 */
export async function resolveIn(
  roots: Parameters<typeof resolvePath>[0],
  requested: string,
  options: { allowMissing?: boolean; base?: string | null } = {}
): Promise<Resolved> {
  // An explicit base — `apply_patch`'s `cwd` — beats the workspace; otherwise the workspace
  // is the base. Either way the joining happens inside `resolvePath`, ahead of validation,
  // so a `..` in the caller's text still meets `checkSegment` instead of being normalised
  // away first. Doing that join here is how a relative patch path could climb out of the
  // workspace: `posix.normalize('/root/a/../../elsewhere')` is a perfectly clean-looking
  // `/elsewhere`, and nothing downstream can tell it apart from a path that was always that.
  const base = options.base !== undefined ? options.base : (currentWorkspace()?.virtual ?? null);
  const resolved = await resolvePath(roots, requested, {
    ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
    base
  });
  // Absolute only: a workspace learned from a relative path would let one loose resolution
  // decide where the next loose resolution points. See workspace.ts.
  if (isAbsoluteVirtualPath(requested)) await learnWorkspace(resolved);
  return resolved;
}

export interface ResolvedCwd {
  real: string;
  virtual: string;
  /** True when the caller named no folder, so the workspace or first root was used instead. */
  defaulted: boolean;
}

/**
 * The working directory a command tool may use, restricted to an approved root.
 *
 * The caller is told which folder this turned out to be, and whether it was a default,
 * because omitting `cwd` while working inside a nested project is a quiet way to run the
 * wrong build: a live run meant for `…/minecraft-web-demo` fell back to the first root and
 * rebuilt the parent Electron app instead, and nothing in the reply said so.
 */
export async function resolveCwd(ctx: ToolContext, virtualPath: string | undefined): Promise<ResolvedCwd> {
  // The chat's own folder before the first root: a command with no `cwd` should run where the
  // chat has been working, which is the whole point of the workspace and is exactly the case
  // the note above describes going wrong.
  const workspace = currentWorkspace();
  const target = virtualPath ?? workspace?.virtual ?? (ctx.roots[0] ? `/${ctx.roots[0].name}` : '');
  if (!target) throw new SandboxError('No folder is approved, so there is nowhere to run');
  const resolved = await resolveIn(ctx.roots, target);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new SandboxError('cwd must be a folder');
  return { real: resolved.real, virtual: resolved.virtual, defaulted: virtualPath === undefined };
}

// ------------------------------------------------------------------ shared args

export const pathArg = z.string().min(1).max(4096);
export const lineNumberArg = z.number().int().min(1).max(100_000_000);
export const windowIdArg = z.number().int().min(1).max(4_294_967_295);
export const imageCoordinateArg = z.number().int().min(-100_000).max(100_000);
export const pointArg = z.object({ x: imageCoordinateArg, y: imageCoordinateArg });
export const cropArg = z.object({
  x: z.number().int().min(0).max(100_000),
  y: z.number().int().min(0).max(100_000),
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000)
});
export const mouseButtonArg = z.enum(['left', 'right', 'middle']);
export const commandEnvArg = z
  .record(
    z.string().min(1).max(MAX_ENV_KEY_CHARS).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string().max(MAX_ENV_VALUE_CHARS)
  )
  .refine((value) => Object.keys(value).length <= MAX_ENV_VARS, {
    message: `At most ${MAX_ENV_VARS} environment variables are allowed`
  })
  .describe(`Environment overrides, at most ${MAX_ENV_VARS}. Values are not logged. CLF_* names are reserved.`);

// ------------------------------------------------------------------ registration

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * What a surface module is handed to register its tools with.
 *
 * Passing a small object rather than the raw `McpServer` is what keeps the two surface
 * modules from being able to diverge on the things that must not differ: every tool goes
 * through `dispatch`, every tool gets the agent key under the same condition, and every
 * capability refusal reads the same. A surface decides *which* tools exist, never how a
 * tool is wired up.
 */
export interface SurfaceRegistrar {
  ctx: ToolContext;
  caps: Capabilities;
  exposedCaps: Capabilities;
  sessionToolsLive: boolean;
  sessionToolsExposed: boolean;
  agentToolsLive: boolean;
  agentToolsExposed: boolean;
  /** Whether `find` is part of this endpoint's surface. See ToolContext.exposedFind. */
  findExposed: boolean;
  register<Schema extends z.ZodType>(
    name: string,
    config: { title: string; description: string; inputSchema: Schema; annotations: ToolAnnotations },
    handler: (args: z.output<Schema>) => Promise<ToolResult>
  ): void;
  /** Runs `fn` only while `cap` is live, and explains the refusal otherwise. */
  guarded(cap: keyof Capabilities, name: string, fn: () => Promise<ToolResult>): Promise<ToolResult>;
  /** Refusal used when a whole feature is off but its tool is still exposed. */
  featureDisabled(feature: string, setting: string): ToolResult;
  /** Names actually registered on this server, in registration order. */
  registered(): string[];
}

export function createRegistrar(server: McpServer, ctx: ToolContext, surface: SurfaceId): SurfaceRegistrar {
  const caps = ctx.caps;
  const exposedCaps = ctx.exposedCaps ?? caps;
  // These two do not follow a capability checkbox: they are whole features the user
  // switches on in the app, and neither touches the filesystem. Like the capability
  // tools they are exposed monotonically and disabled at the handler, so switching a
  // feature off does not delete a tool a cached ChatGPT snapshot still believes in.
  const sessionToolsLive = ctx.sessionTools ?? getConfig().sessions.record;
  const agentToolsLive = ctx.agentTools ?? getConfig().multiAgent.enabled;
  const sessionToolsExposed = ctx.exposedSessionTools ?? sessionToolsLive;
  const agentToolsExposed = ctx.exposedAgentTools ?? agentToolsLive;
  const findExposed = ctx.exposedFind ?? (!exposedCaps.command && exposedCaps.search);
  const names: string[] = [];

  return {
    ctx,
    caps,
    exposedCaps,
    sessionToolsLive,
    sessionToolsExposed,
    agentToolsLive,
    agentToolsExposed,
    findExposed,
    registered: () => [...names],
    register(name, config, handler) {
      names.push(name);
      // No identity field is ever added here. Every tool's schema is exactly what its
      // surface declared: who is calling is a fact about the conversation, established from
      // page evidence in `dispatch`, and never something the model is asked to carry.
      server.registerTool(name, config, ((args: never, mcpCtx?: McpCallContext) =>
        dispatch(name, args, mcpCtx?.sessionId ?? null, requestIdOf(mcpCtx), surface, () =>
          handler(args)
        )) as never);
    },
    guarded(cap, name, fn) {
      return guard(name, async () => {
        if (!caps[cap]) {
          return fail(
            `TOOL_DISABLED: ${name} is disabled by the current ChatGPT Local Files permissions. ` +
              'Ask the user to enable the permission in the app, then retry. If the tool list in this conversation is stale, start a new chat.'
          );
        }
        return fn();
      });
    },
    featureDisabled(feature, setting) {
      return fail(
        `FEATURE_DISABLED: ${feature} is switched off in ChatGPT Local Files. ` +
          `Ask the user to enable "${setting}" in the app, then try again.`
      );
    }
  };
}

// ------------------------------------------------------------------ formatters

/**
 * How much of one expanded recorded tool call comes back in a single result.
 *
 * Deliberately its own number rather than sharing the resume cap. The two are different
 * questions: a handoff is a document written to be read whole and read once, while
 * `history(call_id)` is forensics — the raw arguments and raw output of some earlier call,
 * pulled up to check one detail. Raising the resume cap to fix a five-call handoff should
 * not silently license a single history call to drop 128 KiB of old command output into a
 * conversation, so it does not.
 */
export const MAX_HISTORY_CALL_CHARS = 24 * 1024;

/**
 * Largest brief a handoff save will accept.
 *
 * Generous on purpose. A brief that hits this is a symptom — the compaction of a very
 * long session — and refusing it there would throw away the one artefact the whole flow
 * exists to produce. The bound is only to keep a runaway generation from being written
 * to disk unbounded; at roughly four characters per token this is comfortably past any
 * single ChatGPT answer.
 */
export const MAX_HANDOFF_CHARS = 400_000;

/**
 * How long a prime-role `agents` call waits for the calling chat to show its own block.
 *
 * The prime holds no credential, so this window *is* its identity, and it has to be
 * evidence from this call: a block rendered after the call began, in exactly one
 * conversation. Shorter than a join because a prime calls `agents` repeatedly during a run
 * and a join happens once, but long enough that a page reporting on its own tick lands
 * inside it. Nothing falls back to "the only chat that has been active lately".
 */
export const PRIME_EVIDENCE_MS = 2_500;

/**
 * Recovers the complete text behind a stored field.
 *
 * A long tool argument or result is bounded inline in the log and written whole beside
 * it; this reads the whole one back so recovery means the exact payload rather than
 * its first eight thousand characters. `complete` is false only when even the overflow
 * copy could not be written, and the caller says so instead of implying otherwise.
 */
export async function expandStored(
  sessionId: string,
  stored: StoredText
): Promise<{ text: string; complete: boolean }> {
  if (!stored.truncated) return { text: stored.text, complete: true };
  if (stored.assetId) {
    const full = await readOverflowText(sessionId, stored.assetId);
    if (full !== null) return { text: full, complete: true };
  }
  return { text: stored.text, complete: false };
}

/** Splits on blank lines so a part never ends mid-sentence unless a block is huge. */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = '';
  for (const block of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= size) {
      current = block;
    } else {
      for (let at = 0; at < block.length; at += size) parts.push(block.slice(at, at + size));
      current = '';
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [''];
}

/** One recorded event as a single compact line for session(action='history'). */
export function describeEvent(event: SessionEvent): string {
  const stamp = new Date(event.time).toISOString().slice(11, 19);
  const who = event.agent ? ` [${event.agent}]` : '';
  switch (event.kind) {
    case 'user_message':
      return `#${event.seq} ${stamp}${who} USER: ${oneLine(event.message.text, 400)}`;
    case 'assistant_message':
      return `#${event.seq} ${stamp}${who} ASSISTANT: ${oneLine(event.message.text, 300)}`;
    case 'progress':
      return `#${event.seq} ${stamp}${who} progress: ${oneLine(event.message.text, 200)}`;
    case 'page_tool':
      return `#${event.seq} ${stamp}${who} ChatGPT native tool: ${oneLine(event.label, 300)}`;
    case 'chat_error':
      return `#${event.seq} ${stamp}${who} ERROR: ${oneLine(event.message.text, 300)}`;
    case 'tool_call': {
      const call = event.call;
      const metric = call.summary.metric ? ` ${call.summary.metric}` : '';
      return `#${event.seq} ${stamp}${who} ${call.tool} (${call.outcome}) ${call.summary.title}${metric} · callId ${call.callId}`;
    }
    case 'turn_end':
      return `#${event.seq} ${stamp}${who} turn ended: ${event.outcome}${event.detail ? ` — ${event.detail}` : ''}`;
    case 'turn_start':
      return `#${event.seq} ${stamp}${who} turn started`;
    case 'handoff':
      return `#${event.seq} ${stamp} handoff ${event.handoffId} written (${event.chars} characters)`;
    case 'agent_message':
      return (
        `#${event.seq} ${stamp}${who} ${event.delivery === 'sent' ? 'sent to' : 'received from'} ` +
        `${event.delivery === 'sent' ? event.to : event.from} [${event.messageId}]: ${oneLine(event.message.text, 400)}`
      );
    case 'note':
      return `#${event.seq} ${stamp} note: ${oneLine(event.message.text, 200)}`;
    case 'session_start':
      return `#${event.seq} ${stamp} session started: ${event.title}`;
  }
}

export function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

/** The per-path header `read` prints. This is what `file_info` used to be. */
export function formatFileInfo(info: FileInfo): string {
  const lines = [
    `path: ${info.virtualPath}`,
    `type: ${info.type}`,
    `size: ${formatBytes(info.bytes)}`,
    `modified: ${info.modified}`,
    `created: ${info.created}`
  ];
  if (info.readOnly) lines.push('readonly: true');
  if (info.binary !== null) lines.push(`binary: ${info.binary}`);
  if (info.lines !== null) lines.push(`lines: ${info.lines}`);
  if (info.sha256) lines.push(`sha256: ${info.sha256}`);
  return lines.join('\n');
}

export function formatManagedProcess(result: ManagedProcessStatus, includeOutput = true): string {
  const state = result.running
    ? result.stopping
      ? 'stopping'
      : 'running'
    : `exited ${result.exitCode ?? result.signal ?? 'unknown'}`;
  const console = result.tty ? `  console ${result.cols}x${result.rows}` : '';
  const parts = [`${result.id}  pid ${result.pid}  ${state}${console}  ${result.durationMs} ms  ${result.command}`];
  if (!includeOutput) return parts[0]!;

  const label = result.outputMode === 'delta' ? 'delta' : 'tail';
  // One screen, one stream: on a console there is no separate stderr to print, and the
  // heading says so rather than letting an empty stderr section imply nothing went wrong.
  const outLabel = result.tty ? `terminal ${label} (stdout and stderr interleaved)` : `stdout ${label}`;
  if (result.stdout.trim()) parts.push(`--- ${outLabel} ---\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) parts.push(`--- stderr ${label} ---\n${result.stderr.trimEnd()}`);
  if (result.stdoutCursorLost) parts.push('(stdout cursor fell behind the bounded buffer; oldest unseen stdout was lost)');
  if (result.stderrCursorLost) parts.push('(stderr cursor fell behind the bounded buffer; oldest unseen stderr was lost)');
  if (result.stdoutLinesPending > 0) parts.push(`(${result.stdoutLinesPending} more stdout line(s) waiting; call again with the cursor below to read them)`);
  if (result.stderrLinesPending > 0) parts.push(`(${result.stderrLinesPending} more stderr line(s) waiting; call again with the cursor below to read them)`);
  if (result.outputMode === 'tail' && result.stdoutTruncated) parts.push('(older stdout discarded from bounded buffer)');
  if (result.outputMode === 'tail' && result.stderrTruncated) parts.push('(older stderr discarded from bounded buffer)');
  if (!result.stdout.trim() && !result.stderr.trim()) {
    parts.push(result.outputMode === 'delta' ? '(no new output since cursor)' : '(no captured output yet)');
  }
  if (result.stopMode) parts.push(`stop: ${result.stopMode}`);
  parts.push(`cursor: ${result.cursor}`);
  return parts.join('\n');
}
