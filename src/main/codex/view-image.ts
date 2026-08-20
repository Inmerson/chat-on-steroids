/**
 * Port of `codex-rs/core/src/tools/handlers/view_image.rs` and its spec in
 * `view_image_spec.rs`.
 *
 * Two adaptations, both forced by the transport:
 *
 * - Codex's `image_url` keeps its exact `application/octet-stream` MIME. An MCP `image` content
 *   block additionally requires a concrete `mimeType`, so the sniffed format is carried alongside
 *   that upstream data URL for transport. The accepted formats are PNG, JPEG, GIF and WebP, which
 *   matches the format features enabled for Codex's `image` dependency in the current workspace.
 * - `image::load_from_memory` fully decodes the file to prove it is an image. PNG gets that exact
 *   guarantee here: its pixel data is a zlib stream, so `decodesAsPng` inflates it and checks the
 *   result against the header's geometry, which is a real decode rather than a resemblance test.
 *   JPEG, GIF and WebP have no decoder in the standard library and still rely on structural plus
 *   payload validation, which catches framed-only inputs but not a deeply malformed entropy or
 *   VP8 bitstream. Those three remain an explicit transport/runtime gap against upstream.
 *
 * Getting this wrong is not cosmetic. An `image` content block the consumer cannot decode breaks
 * the ChatGPT message stream and kills the whole turn, so anything short of proof is a rejection.
 *
 * `MAX_VIEW_IMAGE_BYTES` has no counterpart in Codex, whose only limit is the 512 MiB
 * `read_file` cap. A base64 content block of that size would take the connector down, so the
 * existing 8 MiB ceiling stays as a transport limit.
 */

import { inflateSync as zlibInflate } from 'node:zlib';

import { getMetadata, readFile } from './filesystem.js';
import { imageMime, validateImageStructure, formatBytes, MAX_IMAGE_BYTES, type SupportedImageMime } from '../fsops.js';

export const VIEW_IMAGE_TOOL_NAME = 'view_image';

export const VIEW_IMAGE_DESCRIPTION =
  'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.';

export const VIEW_IMAGE_PATH_DESCRIPTION = 'Local filesystem path to an image file.';

export const VIEW_IMAGE_DETAIL_DESCRIPTION =
  'Image detail level. Defaults to `high`; use `original` to preserve exact resolution.';

export const VIEW_IMAGE_UNSUPPORTED_MESSAGE =
  'view_image is not allowed because you do not support image inputs';

export const VIEW_IMAGE_INVALID_MESSAGE = 'unable to process image: invalid or unsupported image data';

/** The connector's transport limit; see the module comment. */
export const MAX_VIEW_IMAGE_BYTES = MAX_IMAGE_BYTES;

/** `ImageDetail`, restricted to the two variants `view_image` can return. */
export type ImageDetail = 'high' | 'original';

/** `DEFAULT_IMAGE_DETAIL`. */
export const DEFAULT_IMAGE_DETAIL: ImageDetail = 'high';

/** `FunctionCallError::RespondToModel`: the message goes to the model verbatim. */
export class ViewImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewImageError';
  }
}

/** `ViewImageOutput`, plus the pieces an MCP `image` content block needs. */
export interface ViewImageResult {
  /** `image_url`: Codex's `data:application/octet-stream;base64,{encoded}`. */
  imageUrl: string;
  /** `detail`. */
  detail: ImageDetail;
  mimeType: SupportedImageMime;
  base64: string;
  bytes: number;
}

/** `ViewImageToolOptions`. `unified_image_budget` covers a history path that has no analogue here. */
export interface ViewImageOptions {
  canRequestOriginalImageDetail: boolean;
}

/** `ViewImageToolOptions::default`. */
export const DEFAULT_VIEW_IMAGE_OPTIONS: ViewImageOptions = {
  canRequestOriginalImageDetail: false
};

/**
 * The handler's detail parsing. Codex keeps accepting `high` and `original` after they disappear
 * from the advertised schema, and rejects anything else.
 */
export function parseViewImageDetail(detail: string | undefined | null): ImageDetail | null {
  if (detail === undefined || detail === null) return null;
  if (detail === 'high') return 'high';
  if (detail === 'original') return 'original';
  throw new ViewImageError(
    `view_image.detail only supports \`high\` or \`original\`; omit \`detail\` for default high resized behavior, got \`${detail}\``
  );
}

/** `data_url_from_bytes`. */
export function dataUrlFromBytes(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** Decoder-required payload checks that the shared framing validator intentionally does not perform. */
function hasImagePayload(data: Buffer, mimeType: SupportedImageMime): boolean {
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset < data.length - 2) {
      while (offset < data.length && data[offset] === 0xff) offset++;
      if (offset >= data.length) return false;
      const marker = data[offset++]!;
      if (marker === 0xda) {
        if (offset + 2 > data.length - 2) return false;
        const length = data.readUInt16BE(offset);
        // SOS has a variable header followed by entropy-coded bytes before EOI. A scan header
        // immediately followed by EOI is structurally framed but cannot decode to pixels.
        return length >= 6 && offset + length < data.length - 2;
      }
      if (marker === 0xd9) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) return false;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return false;
      offset += length;
    }
    return false;
  }

  if (mimeType === 'image/gif') {
    let offset = 13;
    const logicalScreenPacked = data[10]!;
    if ((logicalScreenPacked & 0x80) !== 0) offset += 3 * (1 << ((logicalScreenPacked & 0x07) + 1));
    while (offset < data.length - 1) {
      const block = data[offset]!;
      if (block === 0x21) {
        // Extension introducer + label, followed by data sub-blocks.
        offset += 2;
        while (offset < data.length) {
          const length = data[offset++]!;
          if (length === 0) break;
          if (offset + length > data.length) return false;
          offset += length;
        }
        continue;
      }
      if (block !== 0x2c) return false;
      if (offset + 10 > data.length) return false;
      const imagePacked = data[offset + 9]!;
      offset += 10;
      if ((imagePacked & 0x80) !== 0) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
      if (offset >= data.length - 1) return false;
      const minimumCodeSize = data[offset++]!;
      if (minimumCodeSize < 2 || minimumCodeSize > 8) return false;
      let sawLzwBytes = false;
      while (offset < data.length) {
        const length = data[offset++]!;
        if (length === 0) return sawLzwBytes;
        if (offset + length > data.length) return false;
        sawLzwBytes = true;
        offset += length;
      }
      return false;
    }
    return false;
  }

  if (mimeType === 'image/webp') {
    const validVp8Payload = (start: number, length: number): boolean => {
      if (length < 10 || start + length > data.length) return false;
      // A WebP simple lossy image contains one VP8 key frame. The three-byte frame tag is
      // followed by the mandatory key-frame start code and two 14-bit non-zero dimensions.
      // Merely checking the chunk length lets arbitrary bytes through, unlike Codex's
      // `image::load_from_memory` decode gate.
      if ((data[start]! & 0x01) !== 0) return false;
      if (data[start + 3] !== 0x9d || data[start + 4] !== 0x01 || data[start + 5] !== 0x2a) return false;
      const width = data.readUInt16LE(start + 6) & 0x3fff;
      const height = data.readUInt16LE(start + 8) & 0x3fff;
      return width !== 0 && height !== 0;
    };
    const validVp8lPayload = (start: number, length: number): boolean => {
      if (length < 5 || start + length > data.length || data[start] !== 0x2f) return false;
      const bits = data.readUInt32LE(start + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return width > 0 && height > 0;
    };

    let offset = 12;
    while (offset + 8 <= data.length) {
      const type = data.subarray(offset, offset + 4).toString('ascii');
      const length = data.readUInt32LE(offset + 4);
      const payloadStart = offset + 8;
      const payloadEnd = payloadStart + length;
      if (payloadEnd > data.length) return false;
      if (type === 'VP8 ' && validVp8Payload(payloadStart, length)) return true;
      if (type === 'VP8L' && validVp8lPayload(payloadStart, length)) return true;
      if (type === 'ANMF' && length >= 24) {
        let frameOffset = payloadStart + 16;
        while (frameOffset + 8 <= payloadEnd) {
          const frameType = data.subarray(frameOffset, frameOffset + 4).toString('ascii');
          const frameLength = data.readUInt32LE(frameOffset + 4);
          const frameEnd = frameOffset + 8 + frameLength;
          if (frameEnd > payloadEnd) return false;
          if (frameType === 'VP8 ' && validVp8Payload(frameOffset + 8, frameLength)) return true;
          if (frameType === 'VP8L' && validVp8lPayload(frameOffset + 8, frameLength)) return true;
          frameOffset = frameEnd + (frameLength & 1);
        }
      }
      offset += 8 + length + (length & 1);
    }
    return false;
  }

  return decodesAsPng(data);
}

/** Channels per pixel for each PNG colour type; `undefined` marks a colour type that is not one. */
const PNG_CHANNELS: Record<number, number | undefined> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Bit depths PNG permits for each colour type. */
const PNG_DEPTHS: Record<number, number[] | undefined> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16]
};

/** Adam7: `[xStart, yStart, xStep, yStep]` for each interlace pass. */
const ADAM7: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2]
];

/**
 * Whether this PNG's image data actually decompresses into the pixels its header promises.
 *
 * This is the real decode Codex gets from `image::load_from_memory`, for the one format Node
 * can do it for without a decoder dependency: PNG's pixels are a zlib stream, `zlib` is in the
 * standard library, and everything after inflation — un-filtering scanlines — is arithmetic that
 * cannot fail once the byte count and the filter codes are right.
 *
 * The gap it closes was not theoretical. A PNG framed correctly, with valid chunk CRCs and a
 * valid two-byte zlib header over a corrupt DEFLATE stream, passed every structural check here
 * and was returned as a successful `image` content block. ChatGPT could not decode it, rendered
 * "This image is unavailable because it is of an unsupported file type", and the turn died with
 * `Error in message stream` — four times across one recorded run, each one immediately after a
 * `view_image`/`read` call on that file. Bytes that cannot be decoded must never reach the model.
 */
function decodesAsPng(data: Buffer): boolean {
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawHeader = false;
  let sawPalette = false;
  const parts: Buffer[] = [];

  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const payloadStart = offset + 8;
    const end = payloadStart + length + 4;
    if (end > data.length) return false;
    if (type === 'IHDR') {
      if (length !== 13) return false;
      width = data.readUInt32BE(payloadStart);
      height = data.readUInt32BE(payloadStart + 4);
      bitDepth = data[payloadStart + 8]!;
      colorType = data[payloadStart + 9]!;
      // Compression 0 and filter 0 are the only methods PNG defines; a decoder rejects the rest.
      if (data[payloadStart + 10] !== 0 || data[payloadStart + 11] !== 0) return false;
      interlace = data[payloadStart + 12]!;
      if (interlace !== 0 && interlace !== 1) return false;
      sawHeader = true;
    } else if (type === 'PLTE') {
      sawPalette = true;
    } else if (type === 'IDAT') {
      parts.push(data.subarray(payloadStart, payloadStart + length));
    }
    offset = end;
  }

  if (!sawHeader || width === 0 || height === 0 || parts.length === 0) return false;
  const channels = PNG_CHANNELS[colorType];
  const depths = PNG_DEPTHS[colorType];
  if (channels === undefined || depths === undefined || !depths.includes(bitDepth)) return false;
  // An indexed image without its palette has no pixels, however well-formed the rest is.
  if (colorType === 3 && !sawPalette) return false;

  let raw: Buffer;
  try {
    raw = zlibInflate(Buffer.concat(parts));
  } catch {
    return false;
  }

  const bitsPerPixel = channels * bitDepth;
  const passes: Array<[number, number]> =
    interlace === 0
      ? [[width, height]]
      : ADAM7.map(([xStart, yStart, xStep, yStep]) => [
          Math.ceil(Math.max(0, width - xStart) / xStep),
          Math.ceil(Math.max(0, height - yStart) / yStep)
        ]);

  let at = 0;
  for (const [passWidth, passHeight] of passes) {
    if (passWidth === 0 || passHeight === 0) continue;
    const stride = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let row = 0; row < passHeight; row++) {
      // Every scanline is one filter code plus `stride` bytes. Running out of them, or a filter
      // code outside the five PNG defines, is exactly what a decoder refuses to reconstruct.
      if (at + 1 + stride > raw.length) return false;
      if (raw[at]! > 4) return false;
      at += 1 + stride;
    }
  }
  return true;
}

/**
 * `ViewImageHandler::handle_call`, minus the parts that belong to systems out of scope: the
 * input-modality gate, environment resolution, the sandbox context and the turn-item events.
 *
 * `path` must already be absolute; Codex joins the relative path onto the environment cwd before
 * this point, and the connector resolves it against the approved roots instead.
 */
export async function viewImage(
  path: string,
  detail: ImageDetail | null,
  options: ViewImageOptions = DEFAULT_VIEW_IMAGE_OPTIONS,
  modelVisiblePath: string = path
): Promise<ViewImageResult> {
  let metadata;
  try {
    metadata = await getMetadata(path);
  } catch (error) {
    throw new ViewImageError(`unable to locate image at \`${modelVisiblePath}\`: ${describe(error, path, modelVisiblePath)}`);
  }

  if (!metadata.isFile) {
    throw new ViewImageError(`image path \`${modelVisiblePath}\` is not a file`);
  }

  if (metadata.size > MAX_VIEW_IMAGE_BYTES) {
    throw new ViewImageError(
      `unable to read image at \`${modelVisiblePath}\`: image is too large to return (${formatBytes(metadata.size)}; limit ${formatBytes(MAX_VIEW_IMAGE_BYTES)})`
    );
  }

  let fileBytes: Buffer;
  try {
    fileBytes = await readFile(path);
  } catch (error) {
    throw new ViewImageError(`unable to read image at \`${modelVisiblePath}\`: ${describe(error, path, modelVisiblePath)}`);
  }

  // Reject non-images before their bytes can reach the model.
  const mimeType = imageMime(fileBytes);
  if (mimeType === null) throw new ViewImageError(VIEW_IMAGE_INVALID_MESSAGE);
  try {
    validateImageStructure(fileBytes, mimeType);
    if (!hasImagePayload(fileBytes, mimeType)) throw new Error('image payload is missing');
  } catch {
    throw new ViewImageError(VIEW_IMAGE_INVALID_MESSAGE);
  }

  const useOriginalDetail = options.canRequestOriginalImageDetail && detail === 'original';
  const imageDetail: ImageDetail = useOriginalDetail ? 'original' : DEFAULT_IMAGE_DETAIL;

  const base64 = fileBytes.toString('base64');
  return {
    imageUrl: dataUrlFromBytes('application/octet-stream', base64),
    detail: imageDetail,
    mimeType,
    base64,
    bytes: fileBytes.length
  };
}

/** anyhow's `Display`, which prints the outermost context only. */
function describe(error: unknown, realPath: string, modelVisiblePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // Native fs errors commonly repeat the host path. Preserve Codex's message shape without
  // exposing the connector's sandbox-internal Windows path to the model.
  return realPath === modelVisiblePath ? message : message.split(realPath).join(modelVisiblePath);
}
