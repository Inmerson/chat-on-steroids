import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const publish = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');

describe('official Windows release signing', () => {
  it('passes publisher credentials only through Actions secrets and verifies the produced installer', () => {
    expect(release).toContain('require_windows_signing:');
    expect(release).toContain('WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}');
    expect(release).toContain('WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}');
    expect(release).toContain('Get-AuthenticodeSignature');
    expect(release).toContain("$signature.Status -ne 'Valid'");
  });

  it('fails cheap when publish has no Windows publisher credentials and requires signing in the candidate', () => {
    expect(publish).toContain('Require Windows publisher signing credentials');
    expect(publish).toContain('WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}');
    expect(publish).toContain('WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}');
    expect(publish).toContain('require_windows_signing: true');
    expect(publish).toContain('secrets: inherit');
  });
});
