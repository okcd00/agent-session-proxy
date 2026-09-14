import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(ROOT, 'sessions.json');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8787,
  token: '',
  /** Separate secret for the control console: guests must not be able to stop the service. */
  adminToken: '',
  qodercliPath: 'qodercli',
  codexPath: 'codex',
  defaultProvider: 'qodercli',
  /** Empty means "sibling of the repo", resolved at startup. */
  sharedWorkspace: '',
  maxSessions: 8,
  sessionDefaults: {
    provider: 'qodercli',
    /** Empty means "use the CLI's own configured model". */
    model: '',
    /** Empty means "use the shared workspace". */
    cwd: '',
    /** Empty means "use the provider default". */
    permissionMode: '',
    agent: '',
    appendSystemPrompt: '',
    addDirs: [],
    extraArgs: [],
  },
};

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    if (value && !Array.isArray(value) && typeof value === 'object' && typeof out[key] === 'object') {
      out[key] = merge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig(overrides = {}) {
  return merge(merge(DEFAULTS, readJson(CONFIG_FILE)), overrides);
}

export function saveConfig(config) {
  // Runtime-resolved fields are derived at startup, not user settings.
  const { workspace, ...persisted } = config;
  writeJson(CONFIG_FILE, persisted);
  return config;
}

export function loadState() {
  const state = readJson(STATE_FILE);
  return Array.isArray(state?.sessions) ? state.sessions : [];
}

export function saveState(sessions) {
  writeJson(STATE_FILE, { sessions });
}

/**
 * A LAN-reachable agent can write files and run commands, so the proxy never
 * starts without a token. An unset secret is generated once and persisted, which
 * keeps it stable across restarts instead of silently rotating.
 */
export function ensureSecret(config, key, bytes = 12) {
  if (config[key]) return { config, generated: false };
  const next = { ...config, [key]: randomBytes(bytes).toString('base64url') };
  saveConfig(next);
  return { config: next, generated: true };
}
