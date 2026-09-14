import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCapture, truncate, flattenToolResult } from './shared.js';
import { workspaceEnv } from '../workspace.js';

const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_ROLLOUT_DIRS_SCANNED = 200;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Minimal top-level `key = "value"` extraction; a full TOML parser is overkill here. */
function tomlString(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

function commandToString(command) {
  if (Array.isArray(command)) return command.join(' ');
  return typeof command === 'string' ? command : JSON.stringify(command ?? '');
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens ?? 0,
    reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
  };
}

/**
 * `codex exec` is one-shot: each turn spawns a fresh process and continuity comes
 * from `codex exec resume <thread-id>`, which replays the stored thread. There is
 * no stdin channel and no token-level streaming, so turns surface as whole items
 * plus `activity` hints for whatever is currently running.
 */
export class CodexBackend {
  static id = 'codex';
  static label = 'Codex CLI';
  static persistent = false;
  static streamsText = false;
  static supportsPermissionPrompts = false;
  static binaryKey = 'codexPath';
  static defaultBinary = 'codex';
  static defaultPermissionMode = 'auto_approve';
  static permissionModes = [
    { value: 'auto_approve', label: 'auto_approve — 工作区可写，沙箱内自动批准', risky: true },
    { value: 'full_access', label: 'full_access — 不用沙箱、不批准（最危险）', risky: true },
    { value: 'workspace_write', label: 'workspace_write — 工作区可写，需批准（无人值守会被拒）', risky: false },
    { value: 'read_only', label: 'read_only — 只读沙箱，不能写文件', risky: false },
  ];

  constructor(session) {
    this.s = session;
    this.activity = null;
  }

  env(tmpDir) {
    return workspaceEnv({ ...process.env }, tmpDir);
  }

  // `exec resume` rejects -s and --approve-for-me, so express every mode as -c
  // overrides, which both `exec` and `exec resume` accept.
  permissionArgs(mode) {
    switch (mode) {
      case 'full_access': return ['--dangerously-bypass-approvals-and-sandbox'];
      case 'read_only':
        return ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
      case 'workspace_write':
        return ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"'];
      case 'auto_approve':
      default:
        return [
          '-c', 'sandbox_mode="workspace-write"',
          '-c', 'approval_policy="on-request"',
          '-c', 'approvals_reviewer="auto_review"',
        ];
    }
  }

  /** `exec resume` accepts a narrower flag set than `exec`: no -C or --add-dir. */
  buildArgs({ resume, prompt, attachments }) {
    const opts = this.s.opts;
    const files = attachments ?? [];
    const args = resume ? ['exec', 'resume', resume] : ['exec'];
    args.push('--json', '--skip-git-repo-check');
    args.push(...this.permissionArgs(opts.permissionMode));
    if (opts.model) args.push('-m', opts.model);
    if (!resume) {
      if (opts.cwd) args.push('-C', opts.cwd);
      for (const dir of opts.addDirs ?? []) {
        if (typeof dir === 'string' && dir) args.push('--add-dir', dir);
      }
    }
    // Repeated -i pairs: valid for both the variadic and single-value forms.
    for (const file of files) {
      if (file.isImage && file.path) args.push('-i', file.path);
    }
    for (const arg of opts.extraArgs ?? []) {
      if (typeof arg === 'string' && arg) args.push(arg);
    }
    // `-i` is variadic, so it would swallow the trailing prompt as another
    // image path; `--` ends option parsing and keeps the prompt positional.
    args.push('--', this._promptText(prompt, files));
    return args;
  }

  /** -i only carries images, so paths go in the prompt for everything else. */
  _promptText(prompt, files) {
    const text = String(prompt ?? '');
    if (!files.length) return text;
    const lines = files.map((f) => `- ${f.path}${f.isImage ? '（图片，已随消息附上）' : ''}`);
    return `${text}${text ? '\n\n' : ''}[用户附上了 ${files.length} 个文件，已保存在工作目录]\n${lines.join('\n')}`;
  }

  spawnSpec({ resume, prompt, attachments } = {}) {
    return {
      args: this.buildArgs({ resume, prompt, attachments }),
      cwd: this.s.opts.cwd || process.cwd(),
    };
  }

  resetTurnState() {
    this.activity = null;
  }

  /** Nothing to write: the prompt travelled in argv when the process spawned. */
  beginTurn() {}

  interrupt() {
    const child = this.s.child;
    if (!child) return false;
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3_000).unref?.();
    return true;
  }

  /** codex exec has no interactive approval channel; the sandbox policy decides. */
  resolvePermission() {
    return false;
  }

  live() {
    return this.activity ? { activity: this.activity } : null;
  }

  setActivity(text) {
    this.activity = text;
    this.s.emitEvent({ type: 'activity', text });
  }

  // ------------------------------------------------------------- event stream

  handleEvent(event) {
    const s = this.s;
    switch (event?.type) {
      case 'thread.started':
        if (event.thread_id) s.agentSessionId = event.thread_id;
        s.emitEvent({
          type: 'init',
          agentSessionId: event.thread_id ?? null,
          cwd: s.opts.cwd ?? null,
          model: s.observedModel,
          cliVersion: s.cliVersion,
          tools: [],
        });
        break;

      case 'turn.started':
        this.setActivity('codex 正在处理…');
        break;

      case 'item.started':
      case 'item.updated':
        this.handleProgress(event.item, event.type === 'item.updated');
        break;

      case 'item.completed':
        this.handleCompletedItem(event.item);
        break;

      case 'turn.completed':
        this.setActivity('');
        s.pushItem({
          kind: 'turn',
          subtype: 'success',
          isError: false,
          result: this.lastAgentMessage ?? '',
          usage: normalizeUsage(event.usage),
          ts: Date.now(),
        });
        this.lastAgentMessage = '';
        s.finishTurn();
        break;

      case 'turn.failed':
      case 'thread.failed': {
        const message = event.error ?? event.message ?? event.reason ?? 'codex turn failed';
        this.setActivity('');
        s.log('error', `${event.type}: ${JSON.stringify(event).slice(0, 400)}`);
        s.pushItem({
          kind: 'turn', subtype: event.type, isError: true, result: '', note: String(message), ts: Date.now(),
        });
        s.finishTurn();
        break;
      }

      case 'error':
        // Transport-level noise such as "Reconnecting... waiting for network".
        s.log('warn', String(event.message ?? ''));
        s.emitEvent({ type: 'notice', message: String(event.message ?? '') });
        break;

      default:
        break;
    }
  }

  handleProgress(item, isUpdate) {
    if (!item) return;
    if (item.type === 'command_execution') {
      const output = item.aggregated_output ?? '';
      this.setActivity(`执行命令：${commandToString(item.command)}`);
      if (isUpdate && output) this.s.emitEvent({ type: 'activity_output', text: truncate(output, 8_000) });
    }
  }

  handleCompletedItem(item) {
    if (!item) return;
    const s = this.s;
    switch (item.type) {
      case 'agent_message': {
        const text = item.text ?? '';
        this.lastAgentMessage = text;
        s.pushItem({ kind: 'assistant', id: item.id, model: s.observedModel, blocks: [{ type: 'text', text }], ts: Date.now() });
        break;
      }
      case 'agent_reasoning': {
        const text = item.text ?? flattenToolResult(item.summary ?? '') ?? '';
        if (!text.trim()) break;
        s.pushItem({ kind: 'assistant', id: item.id, model: s.observedModel, blocks: [{ type: 'thinking', text }], ts: Date.now() });
        break;
      }
      case 'command_execution': {
        // Keep a spinner up: the turn is still running while the model reasons.
        this.setActivity('codex 正在处理…');
        const command = commandToString(item.command);
        s.pushItem({
          kind: 'assistant',
          id: item.id,
          model: s.observedModel,
          blocks: [{ type: 'tool_use', id: item.id, name: 'shell', input: { command } }],
          ts: Date.now(),
        });
        const exitCode = item.exit_code;
        s.pushItem({
          kind: 'tool_result',
          toolUseId: item.id,
          isError: exitCode != null && exitCode !== 0,
          content: truncate(item.aggregated_output ?? item.stdout ?? '', MAX_TOOL_RESULT_CHARS),
          ts: Date.now(),
        });
        break;
      }
      case 'error':
        s.log('warn', String(item.message ?? ''));
        break;
      default: {
        // file_change / mcp_tool_call / web_search / todo_list / …
        const { type, id, ...rest } = item;
        s.pushItem({
          kind: 'assistant',
          id,
          model: s.observedModel,
          blocks: [{ type: 'tool_use', id, name: type, input: rest }],
          ts: Date.now(),
        });
        break;
      }
    }
  }

  // ---------------------------------------------------------------- discovery

  static async checkBinary(binPath) {
    const res = await runCapture(binPath, ['--version'], { timeoutMs: 30_000 });
    return {
      ok: res.ok,
      version: res.stdout.trim().split('\n').pop() ?? '',
      error: res.ok ? '' : (res.stderr || res.stdout || `exit ${res.code}`).trim(),
    };
  }

  static caches = new Map();

  /**
   * codex has no --list-models. Models come from the catalog referenced by
   * `model_catalog_json` in $CODEX_HOME/config.toml (provider proxies such as
   * cc-switch write it), falling back to the configured `model`.
   */
  static async listModels(binPath, { refresh = false } = {}) {
    const cached = CodexBackend.caches.get('models');
    if (cached && !refresh) return cached;

    const home = codexHome();
    const configText = await readFile(path.join(home, 'config.toml'), 'utf8').catch(() => '');
    const models = [{ label: '（使用 config.toml 默认模型）', name: '', value: '' }];
    const seen = new Set();

    const catalogRel = tomlString(configText, 'model_catalog_json');
    if (catalogRel) {
      const catalogFile = path.isAbsolute(catalogRel) ? catalogRel : path.join(home, catalogRel);
      const catalog = await readFile(catalogFile, 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => null);
      for (const entry of catalog?.models ?? []) {
        const value = entry.slug ?? entry.id ?? entry.model;
        if (!value || seen.has(value)) continue;
        seen.add(value);
        const name = entry.display_name ?? entry.description ?? value;
        models.push({ label: name === value ? value : `${name} (${value})`, name, value });
      }
    }

    const configured = tomlString(configText, 'model');
    if (configured && !seen.has(configured)) {
      models.push({ label: `${configured}（config.toml）`, name: configured, value: configured });
    }

    CodexBackend.caches.set('models', models);
    return models;
  }

  /** Rebuild the transcript from codex's rollout JSONL for this thread. */
  static async rehydrate({ sessionId, createdAt }) {
    if (!sessionId) return null;
    const file = await locateRollout(path.join(codexHome(), 'sessions'), sessionId, createdAt);
    if (!file) return null;

    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null;
    }

    const items = [];
    let cwd = null;
    let model = null;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = record.payload ?? {};
      const ts = Date.parse(record.timestamp ?? '') || Date.now();

      if (record.type === 'session_meta') {
        cwd = payload.cwd ?? cwd;
        continue;
      }
      if (record.type === 'turn_context') {
        cwd = payload.cwd ?? cwd;
        model = payload.model ?? model;
        continue;
      }
      if (record.type !== 'event_msg' || payload.type !== 'item_completed') continue;

      const item = payload.item ?? {};
      switch (item.type) {
        case 'UserMessage': {
          const text = (item.content ?? [])
            .filter((c) => c?.type === 'text')
            .map((c) => c.text ?? '')
            .filter(Boolean)
            .join('\n');
          if (text) items.push({ kind: 'user', id: item.id, text, state: 'sent', ts });
          break;
        }
        case 'AgentMessage': {
          const text = (item.content ?? [])
            .filter((c) => c?.type === 'Text' || c?.type === 'text')
            .map((c) => c.text ?? '')
            .filter(Boolean)
            .join('\n');
          if (text) {
            items.push({
              kind: 'assistant', id: item.id, model, blocks: [{ type: 'text', text }], ts,
            });
          }
          break;
        }
        case 'Reasoning': {
          const text = [...(item.summary_text ?? []), ...(item.raw_content ?? [])]
            .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
            .filter(Boolean)
            .join('\n');
          if (text.trim()) {
            items.push({
              kind: 'assistant', id: item.id, model, blocks: [{ type: 'thinking', text }], ts,
            });
          }
          break;
        }
        case 'CommandExecution': {
          const command = commandToString(item.command);
          items.push({
            kind: 'assistant',
            id: item.id,
            model,
            blocks: [{ type: 'tool_use', id: item.id, name: 'shell', input: { command } }],
            ts,
          });
          items.push({
            kind: 'tool_result',
            toolUseId: item.id,
            isError: item.exit_code != null && item.exit_code !== 0,
            content: truncate(item.aggregated_output ?? item.stdout ?? '', MAX_TOOL_RESULT_CHARS),
            ts,
          });
          break;
        }
        default:
          break;
      }
    }

    return { file, title: null, model, cwd, items };
  }
}

function dateDirs(moment) {
  const d = new Date(moment);
  const pad = (n) => String(n).padStart(2, '0');
  return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
}

async function findInDir(dir, sessionId) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  return names.find((name) => name.endsWith(`${sessionId}.jsonl`)) ?? null;
}

/**
 * Rollouts live at sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl. The
 * recorded creation date is tried first; otherwise walk the date tree newest
 * first, bounded so a huge history cannot stall startup.
 */
async function locateRollout(root, sessionId, createdAt) {
  const candidates = [createdAt, Date.now()].filter(Boolean);
  for (const moment of candidates) {
    const hit = await findInDir(path.join(root, ...dateDirs(moment)), sessionId);
    if (hit) return path.join(root, ...dateDirs(moment), hit);
  }

  let years;
  try {
    years = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }

  let scanned = 0;
  for (const year of years) {
    const months = (await readdir(path.join(root, year), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const month of months) {
      const days = (await readdir(path.join(root, year, month), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
      for (const day of days) {
        if (scanned++ > MAX_ROLLOUT_DIRS_SCANNED) return null;
        const dir = path.join(root, year, month, day);
        const hit = await findInDir(dir, sessionId);
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}
