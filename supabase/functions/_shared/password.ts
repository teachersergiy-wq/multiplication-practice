/** Generate a password without ambiguous characters 0/O/1/l/I. */
const ALPHABET =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";

/**
 * Rejection sampling so each alphabet index is equally likely
 * (avoids bias from `byte % alphabet.length`).
 */
export function generateSecurePassword(length = 14): string {
  if (length < 12) length = 12;
  const n = ALPHABET.length;
  const maxUnbiased = 256 - (256 % n);
  let out = "";
  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length + 8);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      const b = bytes[i]!;
      if (b < maxUnbiased) out += ALPHABET[b % n]!;
    }
  }
  return out;
}
