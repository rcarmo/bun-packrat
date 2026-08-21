import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.js';

const original = process.env.PACKRAT_HTML_COMPRESSION;
afterEach(() => {
  if (original == null) delete process.env.PACKRAT_HTML_COMPRESSION;
  else process.env.PACKRAT_HTML_COMPRESSION = original;
});

describe('capture body compression configuration', () => {
  test('defaults new bodies to automatic advantageous zstd', () => {
    delete process.env.PACKRAT_HTML_COMPRESSION;
    expect(loadConfig().htmlCompression).toBe('auto');
  });

  test('accepts none and auto but rejects legacy write-only gzip policy', () => {
    process.env.PACKRAT_HTML_COMPRESSION = 'none';
    expect(loadConfig().htmlCompression).toBe('none');
    process.env.PACKRAT_HTML_COMPRESSION = 'auto';
    expect(loadConfig().htmlCompression).toBe('auto');
    process.env.PACKRAT_HTML_COMPRESSION = 'gzip';
    expect(() => loadConfig()).toThrow('must be "none" or "auto"');
  });
});
