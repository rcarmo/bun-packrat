type RasterContentType = 'image/jpeg' | 'image/png' | 'image/webp';
export type RecompressionPass = 'none' | 'colour' | 'greyscale';

export interface RasterEncodeOptions {
  contentType: RasterContentType;
  quality: 75;
  greyscale: boolean;
}

export type RasterEncoder = (bytes: Buffer, options: RasterEncodeOptions) => Promise<Buffer>;

export interface RewrittenMhtml {
  bytes: Buffer;
  eligibleImages: number;
  replacedImages: number;
  skippedImages: number;
}

export interface FittedMhtml extends RewrittenMhtml {
  pass: RecompressionPass;
  warning: string | null;
}

interface RawPart {
  boundaryLine: string;
  raw: string;
}

interface ParsedMultipart {
  prefix: string;
  parts: RawPart[];
  closingBoundary: string;
}

const ELIGIBLE_TYPES = new Set<RasterContentType>(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_PIXELS = 40_000_000;

/** Keep ordinary snapshots byte-exact; rewrite oversized MHTML through the two
 * fixed image passes and return only the first candidate that fits. */
export async function fitOversizedMhtml(
  raw: Uint8Array,
  maxBytes: number,
  options: { encode?: RasterEncoder } = {},
): Promise<FittedMhtml> {
  const original = Buffer.from(raw);
  if (original.byteLength <= maxBytes) {
    return { bytes: original, pass: 'none', warning: null, eligibleImages: 0, replacedImages: 0, skippedImages: 0 };
  }

  const encode = options.encode ?? encodeRasterAsWebp;
  let colourBytes = 0;
  {
    const colour = await rewriteMhtmlRasterImages(original, 'colour', encode);
    colourBytes = colour.bytes.byteLength;
    if (colourBytes <= maxBytes) {
      return {
        ...colour,
        pass: 'colour',
        warning: fallbackWarning('colour', colour.replacedImages),
      };
    }
  }

  const greyscale = await rewriteMhtmlRasterImages(original, 'greyscale', encode);
  if (greyscale.bytes.byteLength <= maxBytes) {
    return {
      ...greyscale,
      pass: 'greyscale',
      warning: fallbackWarning('greyscale', greyscale.replacedImages),
    };
  }

  throw new Error(
    `Captured MHTML exceeds max size after image recompression (${original.byteLength} bytes original, ${colourBytes} bytes colour, ${greyscale.bytes.byteLength} bytes greyscale > ${maxBytes} bytes)`,
  );
}

/** Rewrite only eligible raster MIME parts. Unchanged parts are copied exactly;
 * accepted replacements retain all headers except content type and transfer
 * encoding, which become image/webp and base64. */
export async function rewriteMhtmlRasterImages(
  raw: Uint8Array,
  pass: Exclude<RecompressionPass, 'none'>,
  encode: RasterEncoder = encodeRasterAsWebp,
): Promise<RewrittenMhtml> {
  // latin1 provides a reversible one-code-unit-per-byte view. MIME headers and
  // boundaries are ASCII, while untouched binary/non-UTF8 bodies round-trip
  // without UTF-8 replacement or normalisation.
  const parsed = parseMultipart(Buffer.from(raw).toString('latin1'));
  const output: string[] = [parsed.prefix];
  let eligibleImages = 0;
  let replacedImages = 0;
  let skippedImages = 0;

  for (const part of parsed.parts) {
    output.push(part.boundaryLine);
    const headerEnd = findHeaderEnd(part.raw);
    if (headerEnd < 0) {
      output.push(part.raw);
      continue;
    }
    const separatorLength = part.raw.startsWith('\r\n\r\n', headerEnd) ? 4 : 2;
    const headers = part.raw.slice(0, headerEnd);
    const contentType = headerValue(headers, 'content-type')?.split(';', 1)[0].trim().toLowerCase() as RasterContentType | undefined;
    if (!contentType || !ELIGIBLE_TYPES.has(contentType)) {
      output.push(part.raw);
      continue;
    }

    eligibleImages++;
    const bodyWithTail = part.raw.slice(headerEnd + separatorLength);
    const { body, tail } = splitBodyTail(bodyWithTail);
    const transferEncoding = headerValue(headers, 'content-transfer-encoding')?.trim().toLowerCase() ?? '8bit';
    let source: Buffer;
    try {
      source = decodeTransfer(body, transferEncoding);
    } catch {
      skippedImages++;
      output.push(part.raw);
      continue;
    }

    let candidate: Buffer;
    try {
      candidate = await encode(source, {
        contentType,
        quality: 75,
        greyscale: pass === 'greyscale',
      });
    } catch {
      skippedImages++;
      output.push(part.raw);
      continue;
    }
    if (candidate.byteLength >= source.byteLength) {
      skippedImages++;
      output.push(part.raw);
      continue;
    }

    const lineEnding = headers.includes('\r\n') ? '\r\n' : '\n';
    const rewrittenHeaders = replaceMimeHeader(
      replaceMimeHeader(headers, 'content-type', 'Content-Type: image/webp', lineEnding),
      'content-transfer-encoding',
      'Content-Transfer-Encoding: base64',
      lineEnding,
    );
    const rewrittenPart = rewrittenHeaders + lineEnding + lineEnding
      + wrapBase64(candidate.toString('base64'), lineEnding) + tail;
    // Compare the complete serialized part as well as decoded payloads: a
    // smaller WebP can still lose after base64/header overhead.
    if (Buffer.byteLength(rewrittenPart, 'latin1') >= Buffer.byteLength(part.raw, 'latin1')) {
      skippedImages++;
      output.push(part.raw);
      continue;
    }
    output.push(rewrittenPart);
    replacedImages++;
  }
  output.push(parsed.closingBoundary);
  return { bytes: Buffer.from(output.join(''), 'latin1'), eligibleImages, replacedImages, skippedImages };
}

async function encodeRasterAsWebp(bytes: Buffer, options: RasterEncodeOptions): Promise<Buffer> {
  let image = new Bun.Image(bytes, { maxPixels: MAX_IMAGE_PIXELS, autoOrient: true });
  if (options.greyscale) image = image.modulate({ saturation: 0 });
  return image.webp({ quality: options.quality }).buffer();
}

function parseMultipart(raw: string): ParsedMultipart {
  const topHeaderEnd = findHeaderEnd(raw);
  if (topHeaderEnd < 0) throw new Error('MHTML header is incomplete');
  const topHeaders = raw.slice(0, topHeaderEnd);
  const contentType = headerValue(topHeaders, 'content-type') ?? '';
  const boundary = headerParameter(contentType, 'boundary');
  if (!/^multipart\/related\b/i.test(contentType) || !boundary) throw new Error('MHTML multipart boundary is missing');

  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryPattern = new RegExp(`^--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, 'gm');
  const matches = Array.from(raw.matchAll(boundaryPattern));
  if (!matches.length) throw new Error('MHTML multipart boundary is missing');
  const closingIndex = matches.findIndex((match) => match[1] === '--');
  if (closingIndex < 0) throw new Error('MHTML closing boundary is missing');

  const parts: RawPart[] = [];
  for (let index = 0; index < closingIndex; index++) {
    const current = matches[index];
    const next = matches[index + 1];
    const start = current.index! + current[0].length;
    parts.push({ boundaryLine: current[0], raw: raw.slice(start, next.index!) });
  }
  const closing = matches[closingIndex];
  return {
    prefix: raw.slice(0, matches[0].index!),
    parts,
    closingBoundary: raw.slice(closing.index!),
  };
}

function replaceMimeHeader(headers: string, name: string, replacement: string, lineEnding: string): string {
  const pattern = new RegExp(`^${name}:[^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*`, 'im');
  if (pattern.test(headers)) return headers.replace(pattern, replacement);
  return `${headers}${lineEnding}${replacement}`;
}

function splitBodyTail(value: string): { body: string; tail: string } {
  const match = value.match(/(\r?\n)$/);
  return match ? { body: value.slice(0, -match[1].length), tail: match[1] } : { body: value, tail: '' };
}

function decodeTransfer(body: string, encoding: string): Buffer {
  if (encoding === 'base64') {
    const compact = body.replace(/\s+/g, '');
    if (!compact || compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      throw new Error('Invalid base64 image part');
    }
    return Buffer.from(compact, 'base64');
  }
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  if (encoding === '8bit' || encoding === 'binary' || encoding === '7bit') return Buffer.from(body, 'latin1');
  throw new Error(`Unsupported image transfer encoding: ${encoding}`);
}

function decodeQuotedPrintable(value: string): Buffer {
  const source = value.replace(/=\r?\n/g, '');
  const chunks: Buffer[] = [];
  let plain = '';
  const flush = () => { if (plain) { chunks.push(Buffer.from(plain, 'latin1')); plain = ''; } };
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '=' && /^[0-9a-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
      flush();
      chunks.push(Buffer.from([Number.parseInt(source.slice(index + 1, index + 3), 16)]));
      index += 2;
    } else plain += source[index];
  }
  flush();
  return Buffer.concat(chunks);
}

function wrapBase64(value: string, lineEnding: string): string {
  return value.match(/.{1,76}/g)?.join(lineEnding) ?? '';
}

function headerValue(raw: string, name: string): string | null {
  const unfolded = raw.replace(/\r?\n[\t ]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim();
  }
  return null;
}

function headerParameter(value: string, name: string): string | null {
  const match = value.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? null;
}

function findHeaderEnd(value: string): number {
  const crlf = value.indexOf('\r\n\r\n');
  const lf = value.indexOf('\n\n');
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}

function fallbackWarning(pass: Exclude<RecompressionPass, 'none'>, images: number): string {
  return `Oversized MHTML fitted after ${pass} WebP quality 75 recompression (${images} image${images === 1 ? '' : 's'} replaced)`;
}
