import { randomUUID } from 'node:crypto';

/**
 * Who is connected right now. Deliberately metadata-only: the admin console
 * shows how many people are on and which model they picked, never a single line
 * of what anyone typed.
 */

const DEVICE_RULES = [
  [/\biPhone\b/i, 'iPhone'],
  [/\biPad\b/i, 'iPad'],
  [/\bAndroid\b/i, 'Android'],
  [/\bMac OS X\b|\bMacintosh\b/i, 'Mac'],
  [/\bWindows\b/i, 'Windows'],
  [/\bCrOS\b/i, 'ChromeOS'],
  [/\bLinux\b/i, 'Linux'],
  [/\bcurl\b|\bpython\b|\bnode\b/i, '脚本'],
];

/** Coarse device label: enough for the host to recognise a friend, not a fingerprint. */
export function deviceLabel(userAgent) {
  for (const [pattern, label] of DEVICE_RULES) {
    if (pattern.test(userAgent ?? '')) return label;
  }
  return '未知设备';
}

/** Strip the IPv6-mapped IPv4 prefix Node reports for dual-stack sockets. */
export function normalizeIp(address) {
  const ip = String(address ?? '');
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export class Presence {
  constructor() {
    this.entries = new Map();
  }

  join({ ip, userAgent, admin = false, close }) {
    const id = randomUUID();
    const now = Date.now();
    this.entries.set(id, {
      close,
      meta: {
        id,
        ip: normalizeIp(ip),
        device: deviceLabel(userAgent),
        admin: Boolean(admin),
        connectedAt: now,
        lastSeenAt: now,
        sessionId: null,
      },
    });
    return id;
  }

  leave(id) {
    return this.entries.delete(id);
  }

  /** Called when a viewer switches session, so the console can show what they use. */
  touch(id, { sessionId } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.meta.lastSeenAt = Date.now();
    if (sessionId !== undefined) {
      entry.meta.sessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
    }
    return true;
  }

  /**
   * @param describeSession maps a session id to `{name, provider, model}` —
   * metadata only, so no transcript can slip into the console payload.
   */
  list(describeSession = () => null) {
    return [...this.entries.values()]
      .map(({ meta }) => {
        const info = meta.sessionId ? describeSession(meta.sessionId) : null;
        return {
          ...meta,
          sessionName: info?.name ?? '',
          provider: info?.provider ?? '',
          model: info?.model ?? '',
        };
      })
      .sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /** Guests only: the host's own console tab should not count as a visitor. */
  stats() {
    const guests = [...this.entries.values()].filter(({ meta }) => !meta.admin);
    return {
      viewers: guests.length,
      devices: new Set(guests.map(({ meta }) => meta.ip)).size,
      admins: this.entries.size - guests.length,
    };
  }

  /** Hang up one viewer, or every guest when no id is given. */
  disconnect(id = null) {
    let closed = 0;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (id ? key !== id : entry.meta.admin) continue;
      this.entries.delete(key);
      try {
        entry.close?.();
        closed += 1;
      } catch {
        // The socket was already gone; nothing left to do.
      }
    }
    return closed;
  }
}
