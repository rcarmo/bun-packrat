/** Parse one RFC 9110 byte range. Multiple ranges are deliberately unsupported. */
export function parseSingleByteRange(value: string, size: number): [number, number] | null {
  if (!Number.isSafeInteger(size) || size <= 0 || value.includes(',')) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return [start, end];
}
