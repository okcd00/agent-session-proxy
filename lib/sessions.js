import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Session, STATUS } from './session.js';
import { loadState, saveState } from './config.js';
import { backendClass, DEFAULT_PROVIDER } from './backends/index.js';

/**
 * Owns the set of shared conversations and the on-disk registry that lets a
 * session be picked back up after a proxy restart — for qodercli via
 * `-r <session-id>`, for codex via `codex exec resume <thread-id>`.
 */
export class SessionManager extends EventEmitter {
  constructor({ config }) {
    super();
    this.setMaxListeners(0);
    this.config = config;
    this.sessions = new Map();
    this.persistTimer = null;
  }

  async restore() {
    for (const meta of loadState()) {
      if (!meta?.id || this.sessions.has(meta.id)) continue;
      const provider = meta.provider ?? meta.opts?.provider ?? DEFAULT_PROVIDER;
      const session = this._attach(new Session({
        id: meta.id,
        name: meta.name,
        opts: meta.opts ?? {},
        config: this.config,
        provider,
        agentSessionId: meta.agentSessionId ?? meta.qoderSessionId ?? null,
        detached: true,
      }));
      session.createdAt = meta.createdAt ?? session.createdAt;
      session.lastActiveAt = meta.lastActiveAt ?? session.lastActiveAt;
      session.turnCount = meta.turnCount ?? 0;
      session.cwd = meta.cwd ?? meta.opts?.cwd ?? null;
      session.observedModel = meta.model ?? meta.opts?.model ?? null;
    }
    await Promise.all([...this.sessions.values()].map((session) => this.hydrate(session)));
    this.persist();
    return this;
  }

  /** Reload a stopped session's transcript from the CLI's own on-disk history. */
  async hydrate(session) {
    if (!session.agentSessionId || session.transcript.length) return false;
    const Backend = backendClass(session.provider);
    const stored = await Backend.rehydrate({
      cwdCandidates: [session.cwd, session.opts?.cwd],
      sessionId: session.agentSessionId,
      createdAt: session.createdAt,
    }).catch(() => null);
    if (!stored) return false;

    session.transcript = stored.items;
    session.hydratedFrom = stored.file;
    if (stored.cwd) session.cwd = stored.cwd;
    if (stored.model) session.observedModel = stored.model;
    if (stored.title && !session.name?.trim()) session.name = stored.title;
    session.turnCount = stored.items.reduce((n, item) => n + (item.kind === 'user' ? 1 : 0), 0);
    return true;
  }

  _attach(session) {
    this.sessions.set(session.id, session);
    session.on('event', (event) => this.emit('event', event));
    session.on('event', () => this.schedulePersist());
    return session;
  }

  create({ opts = {}, name = '', provider = DEFAULT_PROVIDER, start = true } = {}) {
    if (this.sessions.size >= this.config.maxSessions) {
      throw Object.assign(
        new Error(`session limit reached (${this.config.maxSessions}); close one first`),
        { status: 429 },
      );
    }
    const session = this._attach(new Session({
      id: randomUUID(),
      name,
      opts,
      config: this.config,
      provider,
    }));
    if (start) session.start();
    else session.setStatus(STATUS.IDLE);
    this.emit('changed');
    this.schedulePersist();
    return session;
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  require(id) {
    const session = this.get(id);
    if (!session) throw Object.assign(new Error(`unknown session: ${id}`), { status: 404 });
    return session;
  }

  list() {
    return [...this.sessions.values()]
      .map((session) => session.snapshot({ includeTranscript: false }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  stop(id) {
    const session = this.require(id);
    session.close({ reason: 'stopped from web UI' });
    session.detached = true;
    this.emit('changed');
    this.schedulePersist();
    return session;
  }

  resume(id) {
    const session = this.require(id);
    if (session.persistent && !session.agentSessionId) {
      throw Object.assign(new Error(`session has no ${session.provider} session id to resume`), { status: 409 });
    }
    session.start();
    this.emit('changed');
    return session;
  }

  remove(id) {
    const session = this.require(id);
    session.removeAllListeners('event');
    session.close({ reason: 'removed from web UI' });
    this.sessions.delete(id);
    this.emit('changed');
    this.persist();
    return true;
  }

  closeAll() {
    for (const session of this.sessions.values()) session.close({ reason: 'server shutdown' });
    this.persist();
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 1_000);
    this.persistTimer.unref?.();
  }

  persist() {
    const entries = [...this.sessions.values()].map((session) => ({
      id: session.id,
      name: session.name,
      provider: session.provider,
      agentSessionId: session.agentSessionId,
      // The resolved cwd matters for rehydration: a CLI can report a different
      // real path than the one requested (macOS /tmp → /private/tmp).
      cwd: session.cwd ?? session.opts?.cwd ?? null,
      model: session.observedModel ?? session.opts?.model ?? null,
      opts: session.opts,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      turnCount: session.turnCount,
    }));
    try {
      saveState(entries);
    } catch {
      // A read-only install should not take the proxy down.
    }
  }
}
