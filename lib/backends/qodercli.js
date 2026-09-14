import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCapture, truncate, parseJson, flattenToolResult } from './shared.js';
import { workspaceEnv } from '../workspace.js';

const MAX_TOOL_RESULT_CHARS = 20_000;
const PERMISSION_TIMEOUT_MS = 120_000;
const INTERRUPT_GRACE_MS = 6_000;
// Bigger images are left as a path: qodercli's own Read tool loads them from
// disk and downscales, which beats stuffing megabytes of base64 down stdin.
const INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Env vars injected when qodercli runs inside the Qoder app's SDK worker. They
 * force the CLI into an SDK entrypoint that rejects normal flags, so a proxy
 * spawned from that context has to strip them to get a usable CLI.
 */
const SDK_ENV_BLOCKLIST = [
  'QODER_AGENT_SDK_ENTRYPOINT',
  'QODER_AGENT_SDK_VERSION',
  'QODERCLI_RUNTIME_PACKAGING',
  'QODER_WORKER_RUNTIME_PATH',
  'QODER_WORKER_RUNTIME_ASSET_ROOT',
  'QW_QODER_WORKER_RUNTIME_PATH',
  'QODER_SDK_AUTH_PAYLOAD_FILE',
  'QODER_WORKER_CWD',
  'QODER_SESSION_TYPE',
];

const PRELOAD_MARKER = /loongsuite|qodercli-token-intercept|qoderwork-runtime-wrapper/;

export function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of SDK_ENV_BLOCKLIST) delete env[key];
  for (const key of ['NODE_OPTIONS', 'BUN_OPTIONS']) {
    if (env[key] && PRELOAD_MARKER.test(env[key])) delete env[key];
  }
  return env;
}

function normalizeContentBlock(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'text') return { type: 'text', text: block.text ?? '' };
  if (block.type === 'thinking') return { type: 'thinking', text: block.thinking ?? block.text ?? '' };
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
  }
  return { type: block.type ?? 'unknown', raw: block };
}

const MODEL_LABEL = /^([A-Za-z0-9][A-Za-z0-9._\- ]*?)(?:\s+\((mode-[0-9a-fA-F]+)\))?$/;
const MODEL_NOISE = /conflicts detected|was renamed|^skipped|^\s*$/i;

function configRoot() {
  return process.env.QODER_CONFIG_DIR
    || process.env.QODERCN_CONFIG_DIR
    || path.join(os.homedir(), '.qoder');
}

function encodeProject(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

async function isFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * One long-lived `qodercli --input-format stream-json` process that keeps its
 * own multi-turn context. Turns are written to stdin as NDJSON; the reply comes
 * back as a stream of partial-message events.
 */
export class QoderBackend {
  static id = 'qodercli';
  static label = 'Qoder CLI';
  static persistent = true;
  static streamsText = true;
  static supportsPermissionPrompts = true;
  static binaryKey = 'qodercliPath';
  static defaultBinary = 'qodercli';
  static defaultPermissionMode = 'bypass_permissions';
  static permissionModes = [
    { value: 'bypass_permissions', label: 'bypass_permissions — 全部放行（无人值守，权限最大）', risky: true },
    { value: 'dont_ask', label: 'dont_ask — 不询问，按策略自动决定', risky: true },
    { value: 'accept_edits', label: 'accept_edits — 自动同意文件编辑，其它仍会询问', risky: false },
    { value: 'auto', label: 'auto — 自动模式', risky: false },
    { value: 'default', label: 'default — 默认，危险操作会在页面上弹出确认', risky: false },
  ];

  constructor(session) {
    this.s = session;
    this.blocks = new Map();
    this.currentMessageId = null;
    this.streamActive = false;
  }

  env(tmpDir) {
    return workspaceEnv(sanitizedEnv(), tmpDir);
  }

  buildArgs({ resume } = {}) {
    const opts = this.s.opts;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];
    if (opts.model) args.push('-m', opts.model);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    if (opts.cwd) args.push('-w', opts.cwd);
    if (opts.agent) args.push('--agent', opts.agent);
    if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.sessionName) args.push('-n', opts.sessionName);
    for (const dir of opts.addDirs ?? []) {
      if (typeof dir === 'string' && dir) args.push('--add-dir', dir);
    }
    if (resume) args.push('-r', resume);
    // argv entries, never a shell string, so these cannot break out into commands.
    for (const arg of opts.extraArgs ?? []) {
      if (typeof arg === 'string' && arg) args.push(arg);
    }
    return args;
  }

  spawnSpec({ resume } = {}) {
    return { args: this.buildArgs({ resume }), cwd: this.s.opts.cwd || process.cwd() };
  }

  resetTurnState() {
    this.blocks = new Map();
    this.currentMessageId = null;
  }

  /**
   * qodercli takes standard Anthropic content blocks, so images can be inlined
   * directly. Paths go in the text block too: that is the only channel for
   * non-image files, and the fallback when an image is too big to inline.
   */
  _contentFor(item) {
    const files = item.attachments ?? [];
    let text = item.text ?? '';
    if (files.length) {
      const lines = files.map((f) => `- ${f.path}${f.isImage ? '（图片）' : ''}`);
      text = `${text}${text ? '\n\n' : ''}[用户附上了 ${files.length} 个文件，已保存在工作目录，可用工具读取]\n${lines.join('\n')}`;
    }
    const blocks = [{ type: 'text', text }];
    for (const file of files) {
      if (!file.isImage) continue;
      try {
        const buffer = readFileSync(file.path);
        if (buffer.length > INLINE_IMAGE_MAX_BYTES) {
          this.s.log('info', `image too large to inline (${buffer.length} bytes), sending path only: ${file.name}`);
          continue;
        }
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: file.mime?.startsWith('image/') ? file.mime : 'image/png',
            data: buffer.toString('base64'),
          },
        });
      } catch (err) {
        this.s.log('warn', `failed to inline image ${file.name}: ${err.message}`);
      }
    }
    return blocks;
  }

  beginTurn(item) {
    this.s.writeLine({
      type: 'user',
      message: { role: 'user', content: this._contentFor(item) },
      parent_tool_use_id: null,
      session_id: this.s.agentSessionId ?? undefined,
    });
  }

  interrupt() {
    this.s.writeLine({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
    // The CLI does not always honour the control request; fall back to a signal
    // so the stop button can never leave a session wedged in "busy".
    const child = this.s.child;
    this.s.interruptTimer = setTimeout(() => {
      if (!this.s.busy || !this.s.child) return;
      this.s.log('warn', 'interrupt not acknowledged, signalling process');
      this.s.child.kill('SIGINT');
      setTimeout(() => { if (this.s.busy && this.s.child) this.s.child.kill('SIGTERM'); }, 2_000).unref?.();
    }, INTERRUPT_GRACE_MS);
    this.s.interruptTimer.unref?.();
    return child != null;
  }

  resolvePermission(requestId, allow, updatedInput) {
    const entry = this.s.permissionRequests.get(requestId);
    if (!entry) return false;
    this.s.permissionRequests.delete(requestId);
    clearTimeout(entry.timer);
    const response = allow
      ? { behavior: 'allow', updatedInput: updatedInput ?? entry.input ?? {} }
      : { behavior: 'deny', message: 'Denied by user in agent-session-proxy' };
    // request_id belongs INSIDE response — qodercli silently drops it otherwise.
    this.s.writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
    this.s.emitEvent({ type: 'permission_resolved', id: requestId, allow });
    return true;
  }

  live() {
    if (!this.blocks.size || !this.currentMessageId) return null;
    return {
      messageId: this.currentMessageId,
      model: this.s.observedModel,
      blocks: [...this.blocks.values()].sort((a, b) => a.index - b.index).map((b) => this.publicBlock(b)),
    };
  }

  publicBlock(block) {
    return {
      index: block.index,
      type: block.type,
      name: block.name,
      toolUseId: block.toolUseId,
      text: block.type === 'tool_use' ? '' : block.text,
    };
  }

  // ------------------------------------------------------------- event stream

  handleEvent(event) {
    const s = this.s;
    if (event?.session_id) s.agentSessionId = event.session_id;
    switch (event?.type) {
      case 'system':
        if (event.subtype === 'init') {
          s.cliVersion = event.qodercli_version ?? s.cliVersion;
          s.cwd = event.cwd ?? s.cwd;
          s.observedModel = event.model ?? s.observedModel;
          s.emitEvent({
            type: 'init',
            agentSessionId: event.session_id ?? null,
            cwd: event.cwd ?? null,
            model: event.model ?? null,
            cliVersion: event.qodercli_version ?? null,
            tools: event.tools ?? [],
          });
        } else if (event.subtype === 'permission_denied') {
          const detail = `qodercli refused ${event.tool_name ?? 'a tool call'}: ${event.message ?? 'no reason given'}`;
          s.log('warn', detail);
          s.emitEvent({ type: 'notice', message: detail });
        } else if (event.subtype === 'api_retry') {
          s.log('warn', `api retry ${event.attempt}/${event.max_retries}: ${event.error ?? ''}`);
        }
        // hook_started / hook_progress / hook_response are local plugin noise.
        break;
      case 'stream_event':
        this.handleStreamEvent(event.event);
        break;
      case 'assistant':
        this.handleAssistant(event);
        break;
      case 'user':
        this.handleToolResults(event);
        break;
      case 'result':
        this.handleResult(event);
        break;
      case 'control_request':
        this.handleControlRequest(event);
        break;
      case 'control_cancel_request':
      case 'control_cancel':
        this.handleControlCancel(event);
        break;
      case 'control_response':
        if (event.response?.subtype && event.response.subtype !== 'success') {
          s.log('warn', `control_response: ${JSON.stringify(event.response).slice(0, 400)}`);
        }
        break;
      default:
        break;
    }
  }

  handleStreamEvent(event) {
    if (!event) return;
    const s = this.s;
    switch (event.type) {
      case 'message_start': {
        this.streamActive = true;
        this.currentMessageId = event.message?.id ?? randomUUID();
        this.blocks = new Map();
        if (event.message?.model) s.observedModel = event.message.model;
        s.emitEvent({ type: 'message_start', messageId: this.currentMessageId, model: s.observedModel });
        break;
      }
      case 'content_block_start': {
        const source = event.content_block ?? {};
        const block = {
          index: event.index,
          type: source.type ?? 'text',
          text: source.text ?? source.thinking ?? '',
          name: source.name ?? null,
          toolUseId: source.id ?? null,
          inputJson: '',
        };
        this.blocks.set(block.index, block);
        s.emitEvent({ type: 'block_start', messageId: this.currentMessageId, block: this.publicBlock(block) });
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta ?? {};
        const block = this.blocks.get(event.index);
        let text = '';
        if (delta.type === 'text_delta') text = delta.text ?? '';
        else if (delta.type === 'thinking_delta') text = delta.thinking ?? '';
        else if (delta.type === 'input_json_delta') text = delta.partial_json ?? '';
        if (!text) break;
        if (block) {
          if (block.type === 'tool_use') block.inputJson += text;
          else block.text += text;
        }
        s.emitEvent({
          type: 'delta',
          messageId: this.currentMessageId,
          index: event.index,
          deltaType: delta.type,
          text,
        });
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks.get(event.index);
        if (block) s.emitEvent({ type: 'block_stop', messageId: this.currentMessageId, block: this.publicBlock(block) });
        break;
      }
      case 'message_stop':
        this.finalizeMessage();
        break;
      default:
        break;
    }
  }

  finalizeMessage() {
    const blocks = [...this.blocks.values()]
      .sort((a, b) => a.index - b.index)
      .map((block) => (block.type === 'tool_use'
        ? { type: 'tool_use', id: block.toolUseId, name: block.name, input: parseJson(block.inputJson, {}) }
        : { type: block.type, text: block.text }));
    this.blocks = new Map();
    const messageId = this.currentMessageId;
    this.currentMessageId = null;
    if (!blocks.length) return;
    this.s.pushItem({ kind: 'assistant', id: messageId, model: this.s.observedModel, blocks, ts: Date.now() });
  }

  /** Only used when the CLI produces no partial-message stream for a reply. */
  handleAssistant(event) {
    const message = event.message;
    if (!message) return;
    if (message.model) this.s.observedModel = message.model;
    if (this.streamActive) return;
    const blocks = (message.content ?? []).map(normalizeContentBlock).filter(Boolean);
    if (!blocks.length) return;
    this.s.pushItem({
      kind: 'assistant', id: message.id ?? randomUUID(), model: message.model, blocks, ts: Date.now(),
    });
  }

  handleToolResults(event) {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part?.type !== 'tool_result') continue;
      this.s.pushItem({
        kind: 'tool_result',
        toolUseId: part.tool_use_id ?? null,
        isError: Boolean(part.is_error),
        content: truncate(flattenToolResult(part.content), MAX_TOOL_RESULT_CHARS),
        ts: Date.now(),
      });
    }
  }

  handleResult(event) {
    const s = this.s;
    if (s.interruptTimer) clearTimeout(s.interruptTimer);
    s.pushItem({
      kind: 'turn',
      subtype: event.subtype ?? 'success',
      isError: Boolean(event.is_error),
      result: truncate(event.result ?? '', MAX_TOOL_RESULT_CHARS),
      durationMs: event.duration_ms ?? null,
      apiDurationMs: event.duration_api_ms ?? null,
      numTurns: event.num_turns ?? null,
      usage: event.usage ?? null,
      totalCostUsd: event.total_cost_usd ?? null,
      ts: Date.now(),
    });
    s.finishTurn();
  }

  handleControlRequest(event) {
    const s = this.s;
    const request = event.request ?? {};
    const requestId = event.request_id;
    if (request.subtype === 'can_use_tool' && requestId) {
      const entry = {
        id: requestId,
        toolName: request.tool_name ?? 'unknown',
        input: request.input ?? {},
        timer: setTimeout(() => {
          if (!s.permissionRequests.has(requestId)) return;
          s.log('warn', `permission request for ${entry.toolName} timed out, denying`);
          this.resolvePermission(requestId, false);
        }, PERMISSION_TIMEOUT_MS),
      };
      s.permissionRequests.set(requestId, entry);
      s.emitEvent({
        type: 'permission_request',
        request: { id: requestId, toolName: entry.toolName, input: entry.input },
      });
      return;
    }
    // Acknowledge anything else so the CLI is never left waiting on us.
    s.writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId },
    });
  }

  handleControlCancel(event) {
    const s = this.s;
    const requestId = event.request_id;
    if (!requestId || !s.permissionRequests.has(requestId)) return;
    s.permissionRequests.delete(requestId);
    s.log('info', `permission request ${requestId} cancelled by qodercli`);
    s.emitEvent({ type: 'permission_cancelled', id: requestId });
  }

  // ---------------------------------------------------------------- discovery

  static async checkBinary(binPath) {
    const res = await runCapture(binPath, ['--version'], { env: sanitizedEnv(), timeoutMs: 30_000 });
    return {
      ok: res.ok,
      version: res.stdout.trim().split('\n').pop() ?? '',
      error: res.ok ? '' : (res.stderr || res.stdout || `exit ${res.code}`).trim(),
    };
  }

  static caches = new Map();

  /**
   * `--list-models` prints a MODEL header then one label per line. Custom models
   * carry a `(mode-…)` id which is what `-m` actually expects for those entries.
   */
  static async listModels(binPath, { refresh = false } = {}) {
    const cached = QoderBackend.caches.get(binPath);
    if (cached && !refresh) return cached;
    const res = await runCapture(binPath, ['--list-models'], { env: sanitizedEnv(), timeoutMs: 60_000 });
    if (!res.ok && !res.stdout.trim()) {
      throw new Error((res.stderr || `qodercli --list-models exited ${res.code}`).trim());
    }
    const lines = res.stdout.split('\n').map((line) => line.trim());
    const start = lines.findIndex((line) => line.toUpperCase() === 'MODEL');
    const models = [{ label: '（使用 CLI 默认模型）', name: '', value: '' }];
    for (const line of lines.slice(start === -1 ? 0 : start + 1)) {
      if (!line || MODEL_NOISE.test(line) || line.startsWith('-')) continue;
      const match = line.match(MODEL_LABEL);
      if (!match) continue;
      models.push({ label: line, name: match[1].trim(), value: match[2] ?? match[1].trim() });
    }
    QoderBackend.caches.set(binPath, models);
    return models;
  }

  /**
   * Rebuild the transcript from the JSONL qodercli keeps per session, so a
   * session restored after a proxy restart shows its history instead of an
   * empty chat. Assistant records are stored as several partial chunks sharing
   * one message id, so blocks are merged and de-duplicated per id.
   */
  static async rehydrate({ cwdCandidates = [], sessionId }) {
    if (!sessionId) return null;
    const root = path.join(configRoot(), 'projects');
    const file = await locateRollout(root, cwdCandidates, sessionId);
    if (!file) return null;

    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null;
    }

    const items = [];
    const assistantById = new Map();
    let title = null;
    let model = null;
    let cwd = null;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && record.cwd) cwd = record.cwd;

      switch (record.type) {
        case 'custom-title':
          if (record.customTitle) title = record.customTitle;
          break;
        case 'runtime-config':
          if (record.model) model = record.model;
          break;
        case 'user': {
          const content = record.message?.content;
          const ts = Date.parse(record.timestamp ?? '') || Date.now();
          if (typeof content === 'string') {
            items.push({ kind: 'user', id: record.uuid, text: content, state: 'sent', ts });
            break;
          }
          if (!Array.isArray(content)) break;
          const text = content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').filter(Boolean).join('\n');
          if (text) items.push({ kind: 'user', id: record.uuid, text, state: 'sent', ts });
          for (const part of content) {
            if (part?.type !== 'tool_result') continue;
            items.push({
              kind: 'tool_result',
              toolUseId: part.tool_use_id ?? null,
              isError: Boolean(part.is_error),
              content: truncate(flattenToolResult(part.content), MAX_TOOL_RESULT_CHARS),
              ts,
            });
          }
          break;
        }
        case 'assistant': {
          const message = record.message;
          if (!message) break;
          const id = message.id ?? record.uuid;
          const ts = Date.parse(record.timestamp ?? '') || Date.now();
          let entry = assistantById.get(id);
          if (!entry) {
            entry = {
              kind: 'assistant', id, model: message.model ?? null, blocks: [], ts, seen: new Set(),
            };
            assistantById.set(id, entry);
            items.push(entry);
          }
          for (const block of message.content ?? []) {
            const normalized = normalizeContentBlock(block);
            if (!normalized) continue;
            const key = normalized.type === 'tool_use'
              ? `tool_use:${normalized.id}`
              : `${normalized.type}:${normalized.text}`;
            if (entry.seen.has(key)) continue;
            entry.seen.add(key);
            entry.blocks.push(normalized);
          }
          break;
        }
        default:
          break;
      }
    }

    for (const entry of assistantById.values()) delete entry.seen;
    return {
      file,
      title,
      model,
      cwd,
      items: items.filter((item) => item.kind !== 'assistant' || item.blocks.length),
    };
  }
}

async function locateRollout(root, cwdCandidates, sessionId) {
  for (const cwd of cwdCandidates.filter(Boolean)) {
    const direct = path.join(root, encodeProject(cwd), `${sessionId}.jsonl`);
    if (await isFile(direct)) return direct;
  }
  // The recorded cwd can differ from the real one (macOS /tmp → /private/tmp),
  // so fall back to a scan. Session ids are UUIDs, so a filename match is unique.
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, `${sessionId}.jsonl`);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}
