/** Mirrors contracts/api.ts CREDENTIALS (no imports across package boundary). */
export const ALPHABET = "abcdefghjkmnpqrstuvwxyz";
export const LOGIN_LEN = 4;

function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function randomLetters(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += ALPHABET[randomInt(ALPHABET.length)];
  }
  return s;
}

export function generateLogin(): string {
  return randomLetters(LOGIN_LEN);
}

/** 2 letters + 4 digits, e.g. kd4817 */
export function generatePassword(): string {
  const letters = randomLetters(2);
  let digits = "";
  for (let i = 0; i < 4; i++) digits += String(randomInt(10));
  return letters + digits;
}

export function studentEmail(login: string, domain: string): string {
  return `${login.toLowerCase()}@${domain}`;
}

/** Required env; no production default (review #7). */
export function getStudentEmailDomain(): string {
  const raw = Deno.env.get("STUDENT_EMAIL_DOMAIN");
  if (raw === undefined || raw.trim() === "") {
    throw new Error("STUDENT_EMAIL_DOMAIN not set");
  }
  const d = raw.trim().toLowerCase();
  if (d.includes("@") || d.includes("*")) {
    throw new Error("STUDENT_EMAIL_DOMAIN invalid");
  }
  return d;
}
