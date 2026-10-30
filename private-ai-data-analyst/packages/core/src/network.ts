export type HostClass = 'loopback' | 'private' | 'public' | 'invalid';

/** Classify an Ollama base URL so we can refuse anything that would leave the user's machine or LAN. */
export function classifyHost(url: string): HostClass {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'invalid';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'invalid';
  if (u.username || u.password) return 'invalid';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0') return 'loopback';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
  }
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return 'private';
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || host.endsWith('.internal') || !host.includes('.')) return 'private';
  return 'public';
}

export function hostAllowed(url: string, allowNonPrivate: boolean): { ok: boolean; reason?: string } {
  const c = classifyHost(url);
  if (c === 'invalid') return { ok: false, reason: 'The Ollama URL is not a valid http(s) address.' };
  if (c === 'public' && !allowNonPrivate) {
    return {
      ok: false,
      reason: 'The Ollama URL points outside this computer and your private network. Enable "Allow non-private model server" in Settings if this is intentional.',
    };
  }
  return { ok: true };
}
