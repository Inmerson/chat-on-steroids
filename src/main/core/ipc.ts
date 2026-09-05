import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CoreStatusEnvelope } from '../../shared/core-protocol.js';

/**
 * User-scoped rendezvous endpoint for the persistent Core Host.
 *
 * Windows named pipes do not need a filesystem cleanup path. Hashing userData keeps the pipe
 * deterministic for one installation profile without leaking the user's home path into process
 * listings. Unix sockets live beneath userData so normal directory permissions scope access.
 */
export function coreEndpointForUserData(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const digest = createHash('sha256').update(path.resolve(userDataDir)).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\chat-on-steroids-core-${digest}`;
  }
  return path.join(userDataDir, 'core', 'core.sock');
}

/** Async status/report traffic from a replaced Core generation must never repaint a newer one. */
export function shouldAcceptCoreEnvelope(currentGeneration: number, envelope: CoreStatusEnvelope): boolean {
  return envelope.generation >= currentGeneration;
}
