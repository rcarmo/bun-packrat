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

  test('records the largest srcset candidate as Markdown image provenance', async () => {
    const result = await inlineAssets('<html><body><img src="data:image/png;base64,AA==" srcset="small.jpg 320w, /large.jpg 1400w" alt="Diagram" title="Large"></body></html>', {
      baseUrl: 'https://example.com/articles/current',
    });
    expect(result.imageSources).toEqual([{
      order: 0, originalUrl: 'https://example.com/large.jpg', alt: 'Diagram', title: 'Large', width: null, height: null,
    }]);
  });

  test('records a descriptorless srcset URL when src is absent', async () => {
    const result = await inlineAssets('<html><body><img srcset="/original.jpg" alt="Original"></body></html>', {
      baseUrl: 'https://example.com/articles/current',
      assetTimeoutMs: 1,
    });
    expect(result.imageSources[0]?.originalUrl).toBe('https://example.com/original.jpg');
  });

  test('does not split commas inside described CDN candidate URLs', async () => {
    const result = await inlineAssets('<html><body><img src="data:image/png;base64,AA==" srcset="https://cdn.example/fetch/w_320,q_auto/image.jpg 320w, https://cdn.example/fetch/w_1400,q_auto/image.jpg 1400w"></body></html>', {
      baseUrl: 'https://example.com/',
      assetTimeoutMs: 1,
    });
    expect(result.imageSources[0]?.originalUrl).toBe('https://cdn.example/fetch/w_1400,q_auto/image.jpg');
  });
});
