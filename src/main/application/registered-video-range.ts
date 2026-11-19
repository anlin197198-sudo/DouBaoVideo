export type LocalVideoRange =
  | { kind: "full"; start: 0; end: number; length: number }
  | { kind: "partial"; start: number; end: number; length: number; contentRange: string }
  | { kind: "unsatisfiable"; contentRange: string }
  | { kind: "invalid-file" };

/** Single-range policy for a future byte stream of a registered local film.
 * No filesystem or URL access: caller supplies an already-verified file size.
 * Unsupported/malformed ranges fail closed instead of streaming the entire film. */
export function registeredVideoRange(header: string | null, bytes: number): LocalVideoRange {
  if (!Number.isSafeInteger(bytes) || bytes < 1) return { kind: "invalid-file" };
  if (header === null) return { kind: "full", start: 0, end: bytes - 1, length: bytes };
  const unsatisfiable = { kind: "unsatisfiable", contentRange: `bytes */${bytes}` } as const;
  if (header.length > 80) return unsatisfiable;
  const match = /^bytes=(\d{0,24})-(\d{0,24})$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return unsatisfiable;
  // BigInt avoids precision loss for otherwise valid end or suffix values extending past EOF.
  const size = BigInt(bytes);
  let start: bigint;
  let end: bigint;
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (suffix === 0n) return unsatisfiable;
    start = suffix >= size ? 0n : size - suffix;
    end = size - 1n;
  } else {
    start = BigInt(match[1]);
    end = match[2] ? BigInt(match[2]) : size - 1n;
    if (start >= size || end < start) return unsatisfiable;
    if (end >= size) end = size - 1n;
  }
  return {
    kind: "partial", start: Number(start), end: Number(end), length: Number(end - start + 1n),
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}
