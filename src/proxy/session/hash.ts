/**
 * 64-bit xxHash → 16-char hex string.
 *
 * Backed by Bun's built-in `Bun.hash.xxHash64`, which implements the
 * standard XXH64 algorithm with default seed=0 — bit-for-bit identical
 * to the previous `@node-rs/xxhash` `xxh64` output. Bun-only runtime.
 */
export function xxh64(data: string): string {
  return Bun.hash.xxHash64(data).toString(16).padStart(16, "0")
}
