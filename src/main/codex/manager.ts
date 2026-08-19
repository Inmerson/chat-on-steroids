/**
 * The one `UnifiedExecProcessManager` for this app.
 *
 * Codex hangs the manager off `session.services`, so every `exec_command` and `write_stdin` in a
 * conversation shares it and a session id stays meaningful between calls. This connector has one
 * long-lived main process rather than a per-conversation session object, so the manager is a
 * module singleton -- the same lifetime, reached the same way.
 */

import type { TruncationPolicy } from './truncate.js';
import { DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS } from './unified-exec-constants.js';
import { UnifiedExecProcessManager } from './unified-exec.js';

export const unifiedExecManager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);

/**
 * `ModelInfo::truncation_policy`, at its default of `TruncationPolicyConfig::bytes(10_000)`.
 *
 * Codex takes this from the model it is talking to. Nothing here knows which model is on the other
 * end of the connector, so the default stands in; it is the value Codex itself uses whenever the
 * backend has not sent something more specific.
 */
export const DEFAULT_TRUNCATION_POLICY: TruncationPolicy = { kind: 'bytes', bytes: 10_000 };
