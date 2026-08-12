import { describe, test, expect } from 'bun:test';
import { inlineAssets } from '../src/capture/assets.js';

describe('asset and link normalisation', () => {
  test('turns relative navigation into absolute source links', async () => {
    const result = await inlineAssets('<html><body><a href="../next?q=1">Next</a></body></html>', {
      baseUrl: 'https://example.com/articles/current',
    });
    expect(result.html).toContain('href="https://example.com/next?q=1"');
  });

  test('removes explicit tracking pixels without fetching', async () => {
    const result = await inlineAssets('<html><body><img src="https://example.com/pixel.gif" width="1" height="1"></body></html>', {
      baseUrl: 'https://example.com/',
    });
    expect(result.html).not.toContain('pixel.gif');
    expect(result.warnings).toContain('Removed probable tracking pixel');
    expect(result.skipped).toBe(1);
  });
});
