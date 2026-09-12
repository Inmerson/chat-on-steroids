export interface HandoffClipboardResult {
  copied: boolean;
  error: string | null;
}

/** Best-effort recovery copy. The continuation WAL remains the authority. */
export async function copyHandoffBootstrapToClipboard(text: string): Promise<HandoffClipboardResult> {
  try {
    const { clipboard } = await import('electron');
    clipboard.writeText(text);
    return { copied: true, error: null };
  } catch (error) {
    return {
      copied: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
