/* Unlocking a checkpoint on the phone, with no signal.

   The server sends every not-yet-revealed point as a blob encrypted with
   the code of the point before it (AES-GCM under a PBKDF2 key). The marshal
   at that point shows its code; typing or scanning it here decrypts the
   next point. Parameters must match functions/api/[[route]].js exactly. */

const KDF_ITERATIONS = 30000;
export const CODE_LEN = 6;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Upper-case, drop anything outside the alphabet, keep the first six. */
export const normCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN) : '');

/** A code from whatever a QR carried: our own URL (?kod=…) or the bare code. */
export function codeFromText(text) {
  if (typeof text !== 'string') return '';
  try {
    const url = new URL(text);
    const kod = url.searchParams.get('kod');
    if (kod) return normCode(kod);
  } catch { /* not a URL */ }
  const code = normCode(text);
  return code.length === CODE_LEN ? code : '';
}

const enc = new TextEncoder();

/** The point inside `blob` if `code` is the right one, otherwise null. */
export async function unlockPoint(blob, code, pointId) {
  if (!window.isSecureContext || !crypto.subtle) return null;
  try {
    const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('jalan-lasak:' + pointId), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const point = JSON.parse(new TextDecoder().decode(plain));
    return point && point.id === pointId ? point : null;
  } catch {
    return null;   // wrong code, or a blob from another program
  }
}
