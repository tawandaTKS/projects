import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Offline licence keys: a one-time purchase with a dated update entitlement.
 *
 *   PADA1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>
 *
 * A key unlocks every app build released on or before `updatesUntil` — forever. Builds released later
 * need a renewed key ("paid updates"). Verification is entirely offline against the embedded public key.
 */
export interface LicensePayload {
  v: 1;
  id: string;
  name: string;
  email: string;
  edition: 'standard' | 'pro' | 'team';
  seats: number;
  issued: string; // YYYY-MM-DD
  updatesUntil: string; // YYYY-MM-DD
}

export type LicenseState =
  | { status: 'licensed'; payload: LicensePayload }
  | { status: 'updates-expired'; payload: LicensePayload; message: string }
  | { status: 'trial'; daysLeft: number }
  | { status: 'trial-expired' }
  | { status: 'invalid'; message: string }
  | { status: 'developer' };

const PREFIX = 'PADA1';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2) throw new Error('Invalid hex');
  return Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function signLicense(payload: LicensePayload, privateKeyHex: string): string {
  const body = enc.encode(JSON.stringify(payload));
  const sig = ed25519.sign(body, hexToBytes(privateKeyHex));
  return `${PREFIX}.${b64urlEncode(body)}.${b64urlEncode(sig)}`;
}

export function generateKeyPair(): { privateKeyHex: string; publicKeyHex: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { privateKeyHex: bytesToHex(secretKey), publicKeyHex: bytesToHex(publicKey) };
}

export function parseLicense(key: string, publicKeyHex: string): { ok: true; payload: LicensePayload } | { ok: false; message: string } {
  const parts = key.trim().replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, message: 'This does not look like a licence key.' };
  let body: Uint8Array;
  let sig: Uint8Array;
  try {
    body = b64urlDecode(parts[1]);
    sig = b64urlDecode(parts[2]);
  } catch {
    return { ok: false, message: 'The licence key is damaged. Copy it again from your purchase email.' };
  }
  let valid = false;
  try {
    valid = ed25519.verify(sig, body, hexToBytes(publicKeyHex));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, message: 'The licence key is not valid.' };
  try {
    const payload = JSON.parse(dec.decode(body)) as LicensePayload;
    if (payload.v !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(payload.updatesUntil)) throw new Error();
    return { ok: true, payload };
  } catch {
    return { ok: false, message: 'The licence key format is not supported by this version.' };
  }
}

export interface LicenseContext {
  publicKeyHex: string;
  /** YYYY-MM-DD release date of this build. */
  buildDate: string;
  /** ISO timestamp of first launch, for the trial. */
  firstRun: string;
  now?: Date;
  trialDays?: number;
}

export function evaluateLicense(key: string | null | undefined, ctx: LicenseContext): LicenseState {
  if (!ctx.publicKeyHex) return { status: 'developer' };
  if (key) {
    const parsed = parseLicense(key, ctx.publicKeyHex);
    if (!parsed.ok) return { status: 'invalid', message: parsed.message };
    if (ctx.buildDate > parsed.payload.updatesUntil) {
      return {
        status: 'updates-expired',
        payload: parsed.payload,
        message: `Your licence covers versions released until ${parsed.payload.updatesUntil}, but this version was released on ${ctx.buildDate}. Renew updates, or keep using any earlier version.`,
      };
    }
    return { status: 'licensed', payload: parsed.payload };
  }
  const days = ctx.trialDays ?? 14;
  const elapsed = ((ctx.now ?? new Date()).getTime() - new Date(ctx.firstRun).getTime()) / 86_400_000;
  const left = Math.ceil(days - elapsed);
  return left > 0 ? { status: 'trial', daysLeft: Math.min(left, days) } : { status: 'trial-expired' };
}

/** Whether the user may ask new questions in this state. */
export const canAsk = (s: LicenseState): boolean => s.status === 'licensed' || s.status === 'trial' || s.status === 'developer';
