/**
 * Deterministic routing policy for the Antigravity Fast Lane.
 *
 * The router must stay cheaper than delegation itself: no model calls, filesystem reads,
 * network access or durable state. It only classifies the narrow task text the Prime planned
 * to send to the read-only investigator.
 */

export interface DelegationDecision {
  delegated: boolean;
  score: number;
  reasons: string[];
  hardBlocked: boolean;
}

const DELEGATION_THRESHOLD = 3;

interface Signal {
  pattern: RegExp;
  score: number;
  reason: string;
}

const POSITIVE_SIGNALS: readonly Signal[] = [
  {
    pattern: /\b(root cause|root-cause|diagnos(?:e|is)|investigat(?:e|ion)|trace|why\b)/i,
    score: 3,
    reason: 'root-cause or execution-trace reconnaissance benefits from a fast second pass'
  },
  {
    pattern: /\b(repo[- ]wide|codebase|across (?:the )?(?:repo|repository|codebase|multiple files)|multiple files|execution path|request path|call graph|dependency graph|lifecycle)\b/i,
    score: 2,
    reason: 'task spans a broad code path or multiple files'
  },
  {
    pattern: /\b(find all|all references|all callers|all implementations|compare .{0,40} across)\b/i,
    score: 2,
    reason: 'task asks for breadth-oriented source discovery'
  },
  {
    pattern: /\b(logs?|dependencies|imports|references|ownership|data flow|control flow)\b/i,
    score: 1,
    reason: 'task benefits from cross-file evidence gathering'
  }
];

const HARD_BLOCKS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(final verification|final review|final gate|release gate|ship decision)\b/i,
    reason: 'final verification stays with Prime'
  },
  {
    pattern: /^\s*(?:please\s+)?(?:implement|modify|edit|write|patch|fix|change|delete|remove|rename|move|create|add|update|migrate|deploy|publish|release|push|commit|merge|install|uninstall|rotate)\b/i,
    reason: 'mutation, release, or deployment work is not delegated to the read-only investigator'
  },
  {
    pattern: /\b(?:and|then)\s+(?:implement|modify|edit|write|patch|fix|change|delete|remove|rename|move|create|add|update|migrate|deploy|publish|release|push|commit|merge|install|uninstall|rotate)\b/i,
    reason: 'mixed investigation plus mutation, release, or deployment must stay under Prime control'
  },
  {
    pattern: /\b(?:run|execute)\s+(?:the\s+)?(?:tests?|build|typecheck|lint|audit)\b/i,
    reason: 'command-based verification stays with Prime'
  }
];

const TRIVIAL_LOOKUP =
  /\b(?:read|show|tell me|what is|what's|does|check whether|check if|find the exact)\b.{0,70}\b(?:package name|version|single line|one line|exists?|package\.json|AGENTS\.md)\b/i;

export function routeAntigravityInvestigation(task: string): DelegationDecision {
  const text = task.trim();
  const reasons: string[] = [];

  for (const block of HARD_BLOCKS) {
    if (!block.pattern.test(text)) continue;
    return {
      delegated: false,
      score: -100,
      reasons: [block.reason],
      hardBlocked: true
    };
  }

  let score = 0;
  for (const signal of POSITIVE_SIGNALS) {
    if (!signal.pattern.test(text)) continue;
    score += signal.score;
    reasons.push(signal.reason);
  }

  if (text.length >= 180) {
    score += 1;
    reasons.push('task is detailed enough that parallel reconnaissance may save wall-clock time');
  }

  if (text.length <= 120 && TRIVIAL_LOOKUP.test(text)) {
    score -= 4;
    reasons.push('small exact lookup is faster for Prime to do directly');
  }

  const delegated = score >= DELEGATION_THRESHOLD;
  if (!delegated && reasons.length === 0) {
    reasons.push('no broad reconnaissance signal strong enough to justify delegation overhead');
  }

  return {
    delegated,
    score,
    reasons: reasons.slice(0, 6),
    hardBlocked: false
  };
}
