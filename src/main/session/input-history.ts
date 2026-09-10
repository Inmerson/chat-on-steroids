import type { InputEntry } from './input.js';
import { getSession, readAsset, readEvents, upsertMessageEvent, writeAsset } from './store.js';
import { validateInputImages } from './input-images.js';

/** Project only a proven delivery boundary into canonical session history. */
export async function recordDeliveredInput(entry: Readonly<InputEntry>): Promise<boolean> {
  const offered = entry.state === 'tool' && !!entry.owner && Number.isFinite(entry.offeredAt);
  const confirmed = entry.state === 'sent' && !!entry.messageId && Number.isFinite(entry.deliveredAt);
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  if ((!offered && !confirmed) || !sessionId) return false;
  const session = await getSession(sessionId);
  if (!session || session.conversationId !== entry.conversationId) return false;
  await validateInputImages(entry.images);
  const assets = [];
  for (const image of entry.images) {
    const comma = image.dataUrl.indexOf(',');
    assets.push(await writeAsset(sessionId, Buffer.from(image.dataUrl.slice(comma + 1), 'base64'), 'image/webp'));
  }
  const messageId = offered ? `input:${entry.id}` : entry.messageId!;
  const time = offered ? entry.offeredAt! : entry.deliveredAt!;
  await upsertMessageEvent(sessionId, {
    time,
    source: 'app',
    kind: 'user_message',
    messageId,
    inputId: entry.id,
    inputDelivery: offered ? 'offered' : 'confirmed',
    authoredText: entry.text,
    attachments: entry.attachments.map(({ name, size, mimeType }) => ({ name, size, mimeType })),
    ...(assets.length ? { assets } : {}),
    message: { text: entry.text, chars: entry.text.length, truncated: false }
  });
  return true;
}

/** Renderer access is capability-free but reference-bound: only a recorded user image is readable. */
export async function recordedInputImage(sessionId: string, assetId: string): Promise<string | null> {
  const events = await readEvents(sessionId);
  const reference = events.find((event) => event.kind === 'user_message' &&
    event.assets?.some((asset) => asset.id === assetId && asset.mimeType === 'image/webp'));
  if (!reference) return null;
  const data = await readAsset(sessionId, assetId);
  if (!data || data.length > 512000) return null;
  const dataUrl = `data:image/webp;base64,${data.toString('base64')}`;
  try {
    await validateInputImages([{ name: 'recorded.webp', dataUrl }]);
    return dataUrl;
  } catch {
    return null;
  }
}
