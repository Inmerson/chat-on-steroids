/**
 * `ParseError` and `ApplyPatchError` from `codex-rs/apply-patch/src/parser.rs` and
 * `codex-rs/apply-patch/src/lib.rs`.
 *
 * Each `message` is the Rust `Display` rendering, because that is what reaches the model. The
 * pieces Codex formats separately elsewhere (a bare hunk message, an I/O context) stay available
 * as fields: `apply_patch` writes `Invalid patch hunk on line {n}: {message}` to stderr using the
 * inner message, not the `Display` form.
 */

export type ParseErrorKind = 'invalid_patch' | 'invalid_hunk';

/** `ParseError`. */
export class PatchParseError extends Error {
  readonly kind: ParseErrorKind;
  /** The message without the `Display` prefix. */
  readonly detail: string;
  /** 1-based line within the patch; only meaningful for `invalid_hunk`. */
  readonly lineNumber: number;

  private constructor(kind: ParseErrorKind, detail: string, lineNumber: number, message: string) {
    super(message);
    this.name = 'PatchParseError';
    this.kind = kind;
    this.detail = detail;
    this.lineNumber = lineNumber;
  }

  /** `InvalidPatchError(String)`. */
  static invalidPatch(detail: string): PatchParseError {
    return new PatchParseError('invalid_patch', detail, 0, `invalid patch: ${detail}`);
  }

  /** `InvalidHunkError { message, line_number }`. */
  static invalidHunk(detail: string, lineNumber: number): PatchParseError {
    return new PatchParseError(
      'invalid_hunk',
      detail,
      lineNumber,
      `invalid hunk at line ${lineNumber}, ${detail}`
    );
  }
}

export type ApplyPatchErrorKind =
  | 'parse'
  | 'io'
  | 'compute_replacements'
  | 'path'
  | 'implicit_invocation';

/** `ApplyPatchError`. */
export class ApplyPatchError extends Error {
  readonly kind: ApplyPatchErrorKind;
  /** Present for `io`: the `{context}` half of `{context}: {source}`. */
  readonly context: string | undefined;

  private constructor(kind: ApplyPatchErrorKind, message: string, context?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApplyPatchError';
    this.kind = kind;
    this.context = context;
  }

  /** `ParseError(#[from] ParseError)`, rendered transparently. */
  static fromParseError(error: PatchParseError): ApplyPatchError {
    return new ApplyPatchError('parse', error.message, undefined, error);
  }

  /** `IoError(IoError { context, source })`, rendered as `{context}: {source}`. */
  static io(context: string, source: unknown): ApplyPatchError {
    const rendered = source instanceof Error ? source.message : String(source);
    return new ApplyPatchError('io', `${context}: ${rendered}`, context, source);
  }

  /** `ComputeReplacements(String)`. */
  static computeReplacements(message: string): ApplyPatchError {
    return new ApplyPatchError('compute_replacements', message);
  }

  /** `PathUri(#[from] PathUriParseError)`, rendered transparently. */
  static path(message: string, cause?: unknown): ApplyPatchError {
    return new ApplyPatchError('path', message, undefined, cause);
  }

  /** `ImplicitInvocation`. */
  static implicitInvocation(): ApplyPatchError {
    return new ApplyPatchError(
      'implicit_invocation',
      'patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]'
    );
  }
}
