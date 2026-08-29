/**
 * ULID (https://github.com/ulid/spec): 48-bit ms timestamp + 80 bits of randomness,
 * Crockford base32, 26 chars, lexicographically sortable by time.
 *
 * Own implementation instead of the `ulid` package: ~30 lines, no dependency to audit,
 * and monotonic within a process (same-millisecond ids increment the random part).
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

const MAX_TIME = 2 ** 48 - 1;

export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) throw new RangeError(`ULID time out of range: ${now}`);
  if (now === lastTime) {
    // Increment the 80-bit random part as a big-endian integer of 16 base32 digits.
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      const digit = lastRandom[i] ?? 0;
      if (digit < 31) {
        lastRandom[i] = digit + 1;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    const bytes = randomBytes(16);
    lastRandom = Array.from({ length: 16 }, (_, i) => (bytes[i] ?? 0) % 32);
  }
  return encodeTime(now) + lastRandom.map((d) => ALPHABET[d]).join("");
}
