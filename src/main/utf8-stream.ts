import { StringDecoder } from 'node:string_decoder';

/**
 * Incremental UTF-8 decoder for arbitrary child-process stream chunks.
 *
 * Node stream `data` boundaries are byte boundaries, not character boundaries. Keeping one
 * StringDecoder per stream carries an incomplete multibyte sequence into the next chunk instead
 * of materialising U+FFFD and permanently corrupting the text before line parsing sees it.
 */
export class Utf8ChunkDecoder {
  private readonly decoder = new StringDecoder('utf8');

  write(chunk: Buffer): string {
    return this.decoder.write(chunk);
  }

  end(chunk?: Buffer): string {
    return chunk === undefined ? this.decoder.end() : this.decoder.end(chunk);
  }
}
