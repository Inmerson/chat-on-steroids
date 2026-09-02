import { randomUUID } from 'node:crypto';

import {
  AgentError,
  IdentityLostError,
  PRIME_ID,
  agentConversation,
  statusForCaller,
  type Caller
} from '../agents.js';
import { readDurable, writeDurableNow } from '../durable.js';

const MANAGER_AUTHORITY_STATE = 'manager-authority';
const MANAGER_AUTHORITY_VERSION = 1 as const;

interface ManagerAuthorityEntry {
  orchestrationRunId: string;
  ownerPrimeConversationId: string;
  managerAgentId: string;
  managerConversationId: string | null;
}

interface ManagerAuthorityState {
  version: typeof MANAGER_AUTHORITY_VERSION;
  entries: ManagerAuthorityEntry[];
}

export interface ManagerAuthority {
  runId: string;
  agentId: string;
}

/** Kernel-private extension of Manager authority. ownerPrimeConversationId is never model input/output. */
export interface ManagerRuntime extends ManagerAuthority {
  ownerPrimeConversationId: string;
}

let authorityWrites: Promise<void> = Promise.resolve();

function enqueueAuthority<T>(work: () => Promise<T>): Promise<T> {
  const queued = authorityWrites.then(work);
  authorityWrites = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseAuthorityState(value: unknown): ManagerAuthorityState {
  if (value === null) return { version: MANAGER_AUTHORITY_VERSION, entries: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError('MANAGER_AUTHORITY_CORRUPT: Manager authority state is not an object.');
  }
  const candidate = value as { version?: unknown; entries?: unknown };
  if (candidate.version !== MANAGER_AUTHORITY_VERSION || !Array.isArray(candidate.entries)) {
    throw new AgentError('MANAGER_AUTHORITY_CORRUPT: Manager authority state has an unsupported shape.');
  }

  const entries: ManagerAuthorityEntry[] = [];
  const owners = new Set<string>();
  const claimedConversations = new Set<string>();
  for (const raw of candidate.entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AgentError('MANAGER_AUTHORITY_CORRUPT: Manager authority entry is malformed.');
    }
    const entry = raw as Partial<ManagerAuthorityEntry>;
    if (
      !validNonEmptyString(entry.orchestrationRunId) ||
      !validNonEmptyString(entry.ownerPrimeConversationId) ||
      !validNonEmptyString(entry.managerAgentId) ||
      (entry.managerConversationId !== null && !validNonEmptyString(entry.managerConversationId))
    ) {
      throw new AgentError('MANAGER_AUTHORITY_CORRUPT: Manager authority entry is incomplete.');
    }
    if (owners.has(entry.ownerPrimeConversationId)) {
      throw new AgentError('MANAGER_AUTHORITY_CORRUPT: one Prime history has multiple Manager authority rows.');
    }
    owners.add(entry.ownerPrimeConversationId);
    if (entry.managerConversationId !== null) {
      if (claimedConversations.has(entry.managerConversationId)) {
        throw new AgentError('MANAGER_AUTHORITY_CORRUPT: one Manager conversation is claimed by multiple histories.');
      }
      claimedConversations.add(entry.managerConversationId);
    }
    entries.push({
      orchestrationRunId: entry.orchestrationRunId,
      ownerPrimeConversationId: entry.ownerPrimeConversationId,
      managerAgentId: entry.managerAgentId,
      managerConversationId: entry.managerConversationId
    });
  }
  return { version: MANAGER_AUTHORITY_VERSION, entries };
}

async function readAuthorityState(): Promise<ManagerAuthorityState> {
  return parseAuthorityState(await readDurable<unknown>(MANAGER_AUTHORITY_STATE));
}

async function writeAuthorityState(state: ManagerAuthorityState): Promise<void> {
  await writeDurableNow(MANAGER_AUTHORITY_STATE, state);
}

function authorityOf(entry: ManagerAuthorityEntry): ManagerAuthority {
  return { runId: entry.orchestrationRunId, agentId: entry.managerAgentId };
}

export function assignManagerForPrime(caller: Caller, managerAgentId: string): Promise<ManagerAuthority> {
  return enqueueAuthority(async () => {
    if (!caller.conversationId) throw new IdentityLostError();
    const status = statusForCaller(caller);
    if (status.self.id !== PRIME_ID) {
      throw new AgentError('MANAGER_ASSIGNMENT_DENIED: only the proven Prime conversation may designate a Manager.');
    }
    const target = status.state.agents.find((agent) => agent.id === managerAgentId);
    if (!target || target.role !== 'worker') {
      throw new AgentError(`MANAGER_ASSIGNMENT_DENIED: ${managerAgentId} is not a worker owned by this Prime history.`);
    }

    const state = await readAuthorityState();
    const existing = state.entries.find((entry) => entry.ownerPrimeConversationId === caller.conversationId);
    if (existing) {
      if (existing.managerAgentId !== managerAgentId) {
        throw new AgentError(
          `MANAGER_ALREADY_ASSIGNED: this Prime history already designated ${existing.managerAgentId}; it cannot silently replace its Manager.`
        );
      }
      return authorityOf(existing);
    }

    const entry: ManagerAuthorityEntry = {
      orchestrationRunId: randomUUID(),
      ownerPrimeConversationId: caller.conversationId,
      managerAgentId,
      managerConversationId: target.conversationId ?? null
    };
    const next: ManagerAuthorityState = { version: MANAGER_AUTHORITY_VERSION, entries: [...state.entries, entry] };
    await writeAuthorityState(next);
    return authorityOf(entry);
  });
}

export function managerForCaller(caller: Caller): Promise<ManagerAuthority> {
  return enqueueAuthority(async () => {
    if (!caller.conversationId) throw new IdentityLostError();
    const status = statusForCaller(caller);
    if (status.self.role !== 'worker') {
      throw new AgentError('MANAGER_AUTHORITY_DENIED: the proven caller is not the designated Manager worker.');
    }

    const state = await readAuthorityState();
    const claimed = state.entries.find((entry) => entry.managerConversationId === caller.conversationId);
    if (claimed) {
      if (claimed.managerAgentId !== status.self.id) {
        throw new AgentError('MANAGER_AUTHORITY_CORRUPT: the claimed Manager conversation resolves to a different worker.');
      }
      return authorityOf(claimed);
    }

    const currentPrimeConversationId = agentConversation(PRIME_ID);
    const pending = state.entries.find(
      (entry) =>
        entry.managerConversationId === null &&
        entry.managerAgentId === status.self.id &&
        entry.ownerPrimeConversationId === currentPrimeConversationId
    );
    if (!pending) {
      throw new AgentError('MANAGER_AUTHORITY_DENIED: this worker was not designated as Manager by its proven Prime.');
    }

    const claimedEntry: ManagerAuthorityEntry = { ...pending, managerConversationId: caller.conversationId };
    const next: ManagerAuthorityState = {
      version: MANAGER_AUTHORITY_VERSION,
      entries: state.entries.map((entry) => (entry === pending ? claimedEntry : entry))
    };
    await writeAuthorityState(next);
    return authorityOf(claimedEntry);
  });
}

export async function managerRuntimeForCaller(caller: Caller): Promise<ManagerRuntime> {
  const authority = await managerForCaller(caller);
  return enqueueAuthority(async () => {
    if (!caller.conversationId) throw new IdentityLostError();
    const state = await readAuthorityState();
    const entry = state.entries.find(
      (candidate) =>
        candidate.orchestrationRunId === authority.runId &&
        candidate.managerAgentId === authority.agentId &&
        candidate.managerConversationId === caller.conversationId
    );
    if (!entry) throw new AgentError('MANAGER_AUTHORITY_CORRUPT: claimed Manager runtime row disappeared.');
    return {
      runId: entry.orchestrationRunId,
      agentId: entry.managerAgentId,
      ownerPrimeConversationId: entry.ownerPrimeConversationId
    };
  });
}

export function resetManagerAuthorityForTests(): Promise<void> {
  return enqueueAuthority(async () => {
    await writeDurableNow(MANAGER_AUTHORITY_STATE, null);
  });
}
