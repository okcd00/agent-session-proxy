import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createBackend, backendClass } from './backends/index.js';

export const STATUS = {
  STARTING: 'starting',
  IDLE: 'idle',
  BUSY: 'busy',
  CLOSED: 'closed',
  ERROR: 'error',
};

const MAX_TRANSCRIPT = 2000;
const MAX_LOG_LINES = 400;

/**
 * One browser-visible conversation. This class owns everything that is the same
 * regardless of which CLI backs it — the transcript, the turn queue, status,
 * logs, SSE fan-out — and delegates the protocol (argv, event shapes, how a turn
 * starts and ends) to a backend.
 *
 * qodercli keeps one long-lived process and streams tokens; codex spawns a fresh
 * `codex exec` per turn and emits whole items. Both look identical to the UI.
 */
export class Session extends EventEmitter {
  constructor({
    id, name, opts, config, provider, agentSessionId = null, detached = false,
  }) {
    super();
    this.setMaxListeners(0);
    this.id = id;
    this.name = name || `session-${id.slice(0, 8)}`;
    this.opts = opts;
    this.config = config;
    this.provider = provider;
    this.backend = createBackend(provider, this);
    this.agentSessionId = agentSessionId;

    const Backend = backendClass(provider);
    this.binPath = config[Backend.binaryKey] || Backend.defaultBinary;
    this.tmpDir = config.workspace?.ok ? config.workspace.tmp : null;

    this.child = null;
    this.dyingChild = null;
    this.wantRunning = false;
    this.detached = detached;
    this.status = detached ? STATUS.CLOSED : STATUS.STARTING;
    this.error = null;

    this.transcript = [];
    this.queue = [];
    this.logs = [];
    this.permissionRequests = new Map();

    this.busy = false;
    this.exiting = false;
    this.interrupted = false;
    this.turnReported = false;
    this.turnCount = 0;
    this.observedModel = opts.model || null;
    this.cwd = opts.cwd ?? null;
    this.cliVersion = null;

    this.stdoutBuffer = '';
    this.interruptTimer = null;

    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    this.startedAt = null;
    this.closedAt = null;
  }

  get persistent() {
    return this.backend.constructor.persistent;
  }

  get resumable() {
    if (this.persistent) return !this.child && Boolean(this.agentSessionId);
    return Boolean(this.agentSessionId);
  }

  get alive() {
    return Boolean(this.child);
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.persistent) {
      if (!this.child) this._spawn({});
      if (this.child) this.setStatus(STATUS.IDLE);
    } else {
      this.detached = false;
      this.error = null;
      this.closedAt = null;
      this.setStatus(STATUS.IDLE);
    }
    this._pump();
    return this;
  }

  _spawn({ resume = null, prompt = null, attachments = null } = {}) {
    if (this.child) return this.child;
    if (this.dyingChild) {
      // The previous process is still shutting down; respawn once it is gone so
      // two CLI processes never share the same session state.
      this.wantRunning = true;
      return null;
    }

    const spec = this.backend.spawnSpec({ resume, prompt, attachments });
    this.error = null;
    this.detached = false;
    this.closedAt = null;
    this.stdoutBuffer = '';
    this.backend.resetTurnState();
    this.startedAt = Date.now();

    let child;
    try {
      child = spawn(this.binPath, spec.args, {
        cwd: spec.cwd || process.cwd(),
        env: this.backend.env(this.tmpDir),
        stdio: [this.persistent ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._fail(`failed to spawn ${this.provider}: ${err.message}`);
      return null;
    }

    this.child = child;
    this.wantRunning = false;
    this.log('info', `spawned: ${formatArgv(this.binPath, spec.args)}`);

    const current = () => this.child === child;
    if (this.persistent) {
      child.stdin.on('error', (err) => { if (current()) this.log('warn', `stdin: ${err.message}`); });
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (current()) this._onStdout(chunk); });
    child.stderr.on('data', (chunk) => { if (current()) this._onStderr(chunk); });
    child.on('error', (err) => { if (current()) this._fail(`${this.provider} error: ${err.message}`); });
    child.on('exit', (code, signal) => this._onChildExit(child, code, signal));
    return child;
  }

  /**
   * A stopped process exits asynchronously, often after a replacement has
   * already been spawned. Only the current child may mutate session state.
   */
  _onChildExit(child, code, signal) {
    if (this.child === child) {
      this._onExit(code, signal);
      return;
    }
    if (this.dyingChild !== child) return;
    this.dyingChild = null;
    this.log('info', `stopped process exited (${signal ?? `code ${code}`})`);
    if (this.wantRunning) {
      this.wantRunning = false;
      this._pump();
    }
  }

  close({ reason = 'closed by server' } = {}) {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    for (const requestId of [...this.permissionRequests.keys()]) {
      this.backend.resolvePermission(requestId, false);
    }
    const child = this.child;
    this.child = null;
    this.busy = false;
    this.queue = [];
    this.wantRunning = false;
    this.backend.resetTurnState();
    this.closedAt = Date.now();
    this.detached = false;
    this.setStatus(this.status === STATUS.ERROR ? STATUS.ERROR : STATUS.CLOSED);
    this.log('info', reason);
    if (child && child.exitCode === null) {
      this.dyingChild = child;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3_000).unref?.();
    }
    this.emitEvent({ type: 'session_closed', reason });
  }

  _fail(message) {
    this.error = message;
    this.child = null;
    this.busy = false;
    this.setStatus(STATUS.ERROR);
    this.log('error', message);
    this.emitEvent({ type: 'error', message });
  }

  _onExit(code, signal) {
    const wasBusy = this.busy;
    const interrupted = this.interrupted;
    const wantedRunning = this.wantRunning;
    this.child = null;
    this.busy = false;
    this.interrupted = false;
    this.wantRunning = false;
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    // Flush the tail so a trailing result still reaches the transcript, but keep
    // the queue from being pumped while this process is being torn down.
    this.exiting = true;
    if (this.stdoutBuffer.trim()) this._onStdout(`${this.stdoutBuffer}\n`);
    this.exiting = false;

    if (wasBusy) {
      this.pushItem({
        kind: 'turn',
        subtype: 'aborted',
        isError: true,
        result: '',
        ts: Date.now(),
        note: `${this.provider} exited mid-turn (${signal ?? `code ${code}`})`,
      });
    }

    // A turn that already reported its own outcome (including a failure) is not
    // made worse by the process exiting non-zero afterwards.
    const clean = code === 0 || code === null || interrupted || (!this.persistent && this.turnReported);
    this.closedAt = Date.now();
    this.detached = false;

    if (!this.persistent && clean && !wasBusy) {
      // For codex a per-turn process exiting is just the normal end of a turn,
      // so the queue survives and the session goes back to idle.
      this.error = null;
      this.setStatus(STATUS.IDLE);
    } else {
      this._dropQueue();
      if (!clean) {
        this.error = `${this.provider} exited with ${signal ?? `code ${code}`}`;
        this.setStatus(STATUS.ERROR);
        this.emitEvent({ type: 'error', message: this.error });
      } else {
        this.setStatus(this.persistent ? STATUS.CLOSED : STATUS.IDLE);
      }
      this.log('info', `exited (${signal ?? `code ${code}`})${this.resumable ? ' — resumable' : ''}`);
      if (this.persistent) {
        this.emitEvent({ type: 'session_closed', reason: this.error ?? `exit ${signal ?? code}` });
      }
    }

    if (!this.persistent && (wantedRunning || this.queue.length)) this._pump();
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emitEvent({ type: 'status', status });
  }

  // ------------------------------------------------------------------- turns

  send(text, attachments = []) {
    const trimmed = String(text ?? '').trim();
    const files = Array.isArray(attachments) ? attachments : [];
    if (!trimmed && !files.length) {
      throw Object.assign(new Error('message is empty'), { status: 400 });
    }
    if (this.status === STATUS.ERROR && !this.resumable) {
      throw Object.assign(new Error(`session is in error state: ${this.error}`), { status: 409 });
    }
    if (this.persistent && this.status === STATUS.CLOSED && !this.resumable && this.transcript.length) {
      throw Object.assign(new Error('session is closed'), { status: 409 });
    }

    const item = {
      kind: 'user', id: randomUUID(), text: trimmed, state: 'queued', ts: Date.now(),
    };
    if (files.length) item.attachments = files;
    this.pushItem(item);
    this.queue.push(item);
    this._pump();

    if (item.state !== 'sent') {
      this.emitEvent({ type: 'queued', id: item.id, position: this.queue.length });
      if (this.status === STATUS.ERROR) {
        throw Object.assign(new Error(this.error ?? `failed to start ${this.provider}`), { status: 500 });
      }
    }
    return item;
  }

  /** Start the CLI if needed, then hand it the next queued message. */
  _pump() {
    if (this.busy || this.exiting || !this.queue.length) return;

    if (!this.persistent) {
      // Wait for the previous turn's process to disappear before spawning.
      if (this.child || this.dyingChild) {
        this.wantRunning = true;
        return;
      }
      const next = this.queue[0];
      this._spawn({ resume: this.agentSessionId, prompt: next.text, attachments: next.attachments });
      if (!this.child) return;
      if (this.status === STATUS.ERROR) {
        this._dropQueue();
        return;
      }
      this.queue.shift();
      this._beginTurn(next);
      return;
    }

    if (!this.child) {
      this._spawn({ resume: this.agentSessionId });
      if (!this.child) return;
      if (this.status === STATUS.ERROR) {
        this._dropQueue();
        return;
      }
    }
    const next = this.queue.shift();
    if (next) this._beginTurn(next);
  }

  _beginTurn(item) {
    item.state = 'sent';
    this.busy = true;
    this.turnReported = false;
    this.turnCount += 1;
    this.lastActiveAt = Date.now();
    this.setStatus(STATUS.BUSY);
    this.emitEvent({ type: 'item_update', id: item.id, state: 'sent' });
    this.backend.beginTurn(item);
  }

  /** Called by the backend when the CLI reports the turn is over. */
  finishTurn() {
    this.busy = false;
    this.turnReported = true;
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    if (this.queue.length) this._pump();
    else this.setStatus(STATUS.IDLE);
  }

  _dropQueue() {
    for (const item of this.queue.splice(0)) {
      this.emitEvent({ type: 'item_update', id: item.id, state: 'dropped' });
    }
  }

  interrupt() {
    if (!this.child || !this.busy) {
      this._dropQueue();
      return false;
    }
    this.interrupted = true;
    const accepted = this.backend.interrupt();
    if (accepted) this.emitEvent({ type: 'interrupting' });
    return accepted;
  }

  resolvePermission(requestId, allow, updatedInput) {
    return this.backend.resolvePermission(requestId, allow, updatedInput);
  }

  // ------------------------------------------------------------------ plumbing

  writeLine(payload) {
    if (!this.child?.stdin?.writable) {
      this.log('warn', 'dropped write, stdin not writable');
      return false;
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  pushItem(item) {
    this.transcript.push(item);
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    }
    this.lastActiveAt = Date.now();
    this.emitEvent({ type: 'item', item });
  }

  log(level, text) {
    const entry = { level, text: String(text).slice(0, 4_000), ts: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.emitEvent({ type: 'log', entry });
  }

  _onStderr(chunk) {
    for (const line of chunk.split('\n')) {
      // codex announces "Reading additional input from stdin..." on every run.
      const trimmed = line.trim();
      if (trimmed && !/Reading additional input from stdin/i.test(trimmed)) this.log('warn', trimmed);
    }
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Both CLIs occasionally print human-readable plugin notices on stdout.
        this.log('info', line);
        continue;
      }
      try {
        this.backend.handleEvent(event);
      } catch (err) {
        this.log('error', `event handler: ${err.stack ?? err.message}`);
      }
    }
  }

  // ------------------------------------------------------------------- views

  live() {
    return this.backend.live();
  }

  snapshot({ includeTranscript = true } = {}) {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      providerLabel: this.backend.constructor.label,
      persistent: this.persistent,
      streamsText: this.backend.constructor.streamsText,
      supportsPermissionPrompts: this.backend.constructor.supportsPermissionPrompts,
      status: this.status,
      busy: this.busy,
      alive: this.alive,
      resumable: this.resumable,
      detached: this.detached,
      error: this.error,
      agentSessionId: this.agentSessionId,
      observedModel: this.observedModel,
      cwd: this.cwd,
      cliVersion: this.cliVersion,
      turnCount: this.turnCount,
      queueLength: this.queue.length,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      opts: this.opts,
      live: this.live(),
      pendingPermissions: [...this.permissionRequests.values()].map((entry) => ({
        id: entry.id, toolName: entry.toolName, input: entry.input,
      })),
      ...(includeTranscript ? { transcript: this.transcript } : {}),
    };
  }

  emitEvent(event) {
    this.emit('event', { ...event, sessionId: this.id, at: Date.now() });
  }
}

/** Log line that never leaks a prompt's full text into the process log. */
function formatArgv(bin, args) {
  const shown = args.map((arg) => (arg.length > 60 ? `${arg.slice(0, 57)}…` : arg));
  return `${bin} ${shown.join(' ')}`;
}
