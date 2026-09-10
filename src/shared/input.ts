/** Bounded, renderer-safe metadata for explicit user-authored file and image input. */
export interface InputImage {
  /** Presentation-only basename; never interpreted as a filesystem path. */
  name: string;
  /** Normalized WebP payload. Validation is owned by the Core process. */
  dataUrl: string;
}

export interface InputAttachment {
  /** Opaque Core-owned staging identity. */
  id: string;
  /** Presentation-only basename. */
  name: string;
  size: number;
  mimeType: string;
  /** Small, normalized preview. The original bytes remain authoritative. */
  preview?: string;
}
