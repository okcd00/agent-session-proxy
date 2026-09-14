#!/usr/bin/env node
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import {
  ROOT, loadConfig, saveConfig, ensureSecret,
} from './lib/config.js';
import {
  PROVIDER_IDS, DEFAULT_PROVIDER, backendClass, providerMeta, allProviderMeta, validPermissionMode,
} from './lib/backends/index.js';
import { defaultWorkspacePath, ensureWorkspace } from './lib/workspace.js';
import { SessionManager } from './lib/sessions.js';
import { Presence, normalizeIp } from './lib/presence.js';
import {
  storeUpload, normalizeAttachments, MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_MESSAGE,
} from './lib/uploads.js';
import { collectAllowedRoots, resolveDownload, contentTypeFor } from './lib/files.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY_BYTES = 1_000_000;
// Base64 inflates bytes by ~4/3, so the envelope has to be larger than the file.
const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * MAX_UPLOADS_PER_MESSAGE * 1.4) + 65_536;
const VERSION = '0.2.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// --------------------------------------------------------------------- cli args

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[++i];
    switch (token) {
      case '--port': case '-p': args.port = Number(next()); break;
      case '--host': args.host = next(); break;
      case '--token': args.token = next(); break;
      case '--admin-token': args.adminToken = next(); break;
      case '--no-auth': args.noAuth = true; break;
      case '--qodercli': args.qodercliPath = next(); break;
      case '--codex': args.codexPath = next(); break;
      case '--provider': args.provider = next(); break;
      case '--workspace': args.sharedWorkspace = next(); break;
      case '--cwd': args.cwd = next(); break;
      case '--model': case '-m': args.model = next(); break;
      case '--permission-mode': args.permissionMode = next(); break;
      case '--max-sessions': args.maxSessions = Number(next()); break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (token.startsWith('-')) throw new Error(`unknown option: ${token}`);
        args._.push(token);
    }
  }
  return args;
}

const HELP = `agent-session-proxy — share this machine's coding agents as a LAN web chat

Usage: node server.js [options]

  -p, --port <n>            Port to listen on (default 8787)
      --host <addr>         Bind address (default 0.0.0.0 = reachable on LAN)
      --token <secret>      Fixed access passphrase visitors must enter
      --admin-token <s>     Secret for the /admin control console (generated if unset)
      --no-auth             Disable the passphrase (only on a trusted network)
      --provider <id>       Default backend: ${PROVIDER_IDS.join(' | ')}
      --qodercli <path>     qodercli binary (default: qodercli on PATH)
      --codex <path>        codex binary (default: codex on PATH)
      --workspace <dir>     Shared workspace (default: ../shared_workspace)
      --cwd <dir>           Default working directory for new sessions
                            (default: the shared workspace)
  -m, --model <name>        Default model for new sessions
      --permission-mode <m> Per-provider; see the web UI for the valid values
      --max-sessions <n>    Max concurrent sessions (default 8)
  -h, --help                Show this help

The shared workspace is created on startup and is where both CLIs run and write
their temp files. Precedence is: these flags > config.json > built-in defaults.
Settings changed in the web UI are saved to config.json, but a flag passed here
overrides them and is written back.
`;

// ------------------------------------------------------------------- http utils

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('body must be JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function equalsSecret(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Tunnel and virtual interfaces are not reachable from the LAN, so rank physical
// adapters first: the share line must not hand out a dead VPN address.
const VIRTUAL_IFACE = /^(utun|tun|tap|bridge|veth|docker|vmnet|vnic|lo)/;
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '']);

function lanUrls(port, host = '0.0.0.0') {
  // Bound to one address only: every other interface would be a dead link.
  if (!WILDCARD_HOSTS.has(host)) return [`http://${host}:${port}`];
  const physical = [];
  const virtual = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const url = `http://${iface.address}:${port}`;
      (VIRTUAL_IFACE.test(name) ? virtual : physical).push(url);
    }
  }
  return [...physical, ...virtual];
}

async function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    sendJson(res, 404, { error: `not found: ${rel}` });
  }
  return undefined;
}

// ------------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const cliOverrides = {};
  if (args.port) cliOverrides.port = args.port;
  if (args.host) cliOverrides.host = args.host;
  if (args.qodercliPath) cliOverrides.qodercliPath = args.qodercliPath;
  if (args.codexPath) cliOverrides.codexPath = args.codexPath;
  if (args.maxSessions) cliOverrides.maxSessions = args.maxSessions;
  if (args.token) cliOverrides.token = args.token;
  if (args.adminToken) cliOverrides.adminToken = args.adminToken;
  if (args.sharedWorkspace) cliOverrides.sharedWorkspace = args.sharedWorkspace;
  if (args.provider) cliOverrides.defaultProvider = args.provider;

  let config = loadConfig(cliOverrides);
  if (args.noAuth) config.token = '';

  if (!PROVIDER_IDS.includes(config.defaultProvider)) config.defaultProvider = DEFAULT_PROVIDER;
  if (!config.sessionDefaults.provider || !PROVIDER_IDS.includes(config.sessionDefaults.provider)) {
    config.sessionDefaults.provider = config.defaultProvider;
  }

  // The shared workspace is the default working directory for new sessions and
  // the TMPDIR for every CLI process this proxy spawns.
  const workspace = ensureWorkspace(config.sharedWorkspace || defaultWorkspacePath());
  config.workspace = workspace;
  if (!config.sessionDefaults.cwd) config.sessionDefaults.cwd = workspace.workspace;

  if (args.cwd) config.sessionDefaults.cwd = path.resolve(args.cwd);
  if (args.model !== undefined) config.sessionDefaults.model = args.model;
  if (args.permissionMode) config.sessionDefaults.permissionMode = args.permissionMode;

  const defaultsBackend = backendClass(config.sessionDefaults.provider);
  if (!validPermissionMode(config.sessionDefaults.provider, config.sessionDefaults.permissionMode)) {
    config.sessionDefaults.permissionMode = defaultsBackend.defaultPermissionMode;
  }

  let authDisabled = false;
  let tokenGenerated = false;
  if (config.token) {
    saveConfig(config);
  } else if (args.noAuth) {
    authDisabled = true;
  } else {
    const ensured = ensureSecret(config, 'token');
    config = ensured.config;
    config.workspace = workspace;
    tokenGenerated = ensured.generated;
  }

  // The console can stop the service, so it never rides on the share passphrase —
  // not even with --no-auth, where every guest would otherwise hold that power.
  const ensuredAdmin = ensureSecret(config, 'adminToken', 16);
  config = ensuredAdmin.config;
  config.workspace = workspace;

  const manager = new SessionManager({ config });
  await manager.restore();
  const startedAt = Date.now();
  const presence = new Presence();
  /** Reversible "off switch": guests are turned away, sessions keep their state. */
  let sharing = true;
  let requestShutdown = null;

  const isAuthorized = (req, url) => {
    if (authDisabled) return true;
    const header = req.headers.authorization;
    const candidate = (header?.startsWith('Bearer ') && header.slice(7).trim())
      || req.headers['x-proxy-token']
      || url.searchParams.get('token')
      || null;
    return candidate ? equalsSecret(candidate, config.token) : false;
  };

  const isAdmin = (req, url) => {
    const candidate = req.headers['x-admin-token'] || url.searchParams.get('admin') || null;
    return candidate ? equalsSecret(candidate, config.adminToken) : false;
  };

  const binaryPath = (providerId) => {
    const Backend = backendClass(providerId);
    return config[Backend.binaryKey] || Backend.defaultBinary;
  };

  async function providerHealth() {
    const results = {};
    await Promise.all(PROVIDER_IDS.map(async (id) => {
      const Backend = backendClass(id);
      const bin = binaryPath(id);
      const info = await Backend.checkBinary(bin).catch((err) => ({ ok: false, version: '', error: err.message }));
      results[id] = { path: bin, ...info };
    }));
    return results;
  }

  // ------------------------------------------------------------------- routes

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/health$/, async (req, res, url) => {
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      authEnabled: !authDisabled,
      authorized: isAuthorized(req, url),
      sharing,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  route('POST', /^\/api\/auth$/, async (req, res) => {
    const body = await readBody(req);
    if (authDisabled) return sendJson(res, 200, { ok: true });
    if (!body.token || !equalsSecret(body.token, config.token)) {
      return sendJson(res, 401, { error: 'wrong passphrase' });
    }
    return sendJson(res, 200, { ok: true });
  });

  route('GET', /^\/api\/server$/, async (req, res) => {
    const binaries = await providerHealth();
    sendJson(res, 200, {
      version: VERSION,
      node: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      hostname: os.hostname(),
      authEnabled: !authDisabled,
      listen: { host: config.host, port: config.port },
      lanUrls: lanUrls(config.port, config.host),
      maxSessions: config.maxSessions,
      providers: allProviderMeta().map((meta) => ({ ...meta, binary: binaries[meta.id] })),
      workspace: config.workspace,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  route('GET', /^\/api\/models$/, async (req, res, url) => {
    const provider = url.searchParams.get('provider') || config.sessionDefaults.provider;
    if (!PROVIDER_IDS.includes(provider)) {
      return sendJson(res, 400, { error: `unknown provider: ${provider}`, models: [] });
    }
    try {
      const models = await backendClass(provider).listModels(
        binaryPath(provider),
        { refresh: url.searchParams.get('refresh') === '1' },
      );
      return sendJson(res, 200, { provider, models });
    } catch (err) {
      return sendJson(res, 502, { provider, error: err.message, models: [] });
    }
  });

  route('GET', /^\/api\/config$/, async (req, res) => {
    sendJson(res, 200, {
      sessionDefaults: config.sessionDefaults,
      providers: allProviderMeta(),
      defaultProvider: config.defaultProvider,
      qodercliPath: config.qodercliPath,
      codexPath: config.codexPath,
      maxSessions: config.maxSessions,
      listen: { host: config.host, port: config.port },
      authEnabled: !authDisabled,
      workspace: config.workspace,
    });
  });

  route('POST', /^\/api\/config$/, async (req, res) => {
    const body = await readBody(req);
    const defaults = body.sessionDefaults;
    if (defaults && typeof defaults === 'object') {
      const next = { ...config.sessionDefaults };
      if (typeof defaults.provider === 'string') {
        if (!PROVIDER_IDS.includes(defaults.provider)) {
          throw Object.assign(new Error(`unknown provider: ${defaults.provider}`), { status: 400 });
        }
        next.provider = defaults.provider;
      }
      if (typeof defaults.model === 'string') next.model = defaults.model.trim();
      if (typeof defaults.cwd === 'string') {
        next.cwd = defaults.cwd.trim() ? path.resolve(defaults.cwd.trim()) : config.workspace.workspace;
      }
      if (typeof defaults.permissionMode === 'string') {
        const Backend = backendClass(next.provider);
        if (defaults.permissionMode && !validPermissionMode(next.provider, defaults.permissionMode)) {
          throw Object.assign(
            new Error(`invalid permissionMode for ${next.provider}: ${defaults.permissionMode}`),
            { status: 400 },
          );
        }
        next.permissionMode = defaults.permissionMode || Backend.defaultPermissionMode;
      }
      // Provider switches invalidate a permission mode borrowed from the other CLI.
      if (!validPermissionMode(next.provider, next.permissionMode)) {
        next.permissionMode = backendClass(next.provider).defaultPermissionMode;
      }
      if (typeof defaults.agent === 'string') next.agent = defaults.agent.trim();
      if (typeof defaults.appendSystemPrompt === 'string') next.appendSystemPrompt = defaults.appendSystemPrompt;
      if (Array.isArray(defaults.addDirs)) next.addDirs = defaults.addDirs.filter((d) => typeof d === 'string' && d.trim());
      if (Array.isArray(defaults.extraArgs)) next.extraArgs = defaults.extraArgs.filter((a) => typeof a === 'string' && a.trim());
      config.sessionDefaults = next;
    }
    if (typeof body.qodercliPath === 'string' && body.qodercliPath.trim()) {
      config.qodercliPath = body.qodercliPath.trim();
    }
    if (typeof body.codexPath === 'string' && body.codexPath.trim()) {
      config.codexPath = body.codexPath.trim();
    }
    if (typeof body.sharedWorkspace === 'string' && body.sharedWorkspace.trim()) {
      const next = ensureWorkspace(body.sharedWorkspace.trim());
      if (!next.ok) {
        throw Object.assign(new Error(`shared workspace unusable: ${next.error}`), { status: 400 });
      }
      const previous = config.workspace?.workspace;
      config.sharedWorkspace = next.workspace;
      config.workspace = next;
      if (!previous || config.sessionDefaults.cwd === previous) {
        config.sessionDefaults.cwd = next.workspace;
      }
    }
    if (Number.isFinite(body.maxSessions)) {
      config.maxSessions = Math.max(1, Math.min(64, Math.floor(body.maxSessions)));
    }
    if (typeof body.token === 'string' && body.token.trim() && !authDisabled) {
      config.token = body.token.trim();
    }
    saveConfig(config);
    sendJson(res, 200, {
      ok: true,
      sessionDefaults: config.sessionDefaults,
      qodercliPath: config.qodercliPath,
      codexPath: config.codexPath,
      maxSessions: config.maxSessions,
    });
  });

  route('GET', /^\/api\/fs$/, async (req, res, url) => {
    const requested = url.searchParams.get('path') || config.workspace.workspace;
    const target = path.resolve(requested);
    try {
      const info = await stat(target);
      if (!info.isDirectory()) throw new Error('not a directory');
      const entries = await readdir(target, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: path.join(target, entry.name), hidden: entry.name.startsWith('.') }))
        .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
      sendJson(res, 200, {
        path: target,
        parent: path.dirname(target),
        home: os.homedir(),
        workspace: config.workspace.workspace,
        dirs,
      });
    } catch (err) {
      sendJson(res, 404, { error: `${target}: ${err.message}`, path: target, dirs: [] });
    }
  });

  route('GET', /^\/api\/sessions$/, async (req, res) => {
    sendJson(res, 200, { sessions: manager.list() });
  });

  route('POST', /^\/api\/sessions$/, async (req, res) => {
    const body = await readBody(req);
    const base = config.sessionDefaults;
    const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : base.provider;
    if (!PROVIDER_IDS.includes(provider)) {
      throw Object.assign(new Error(`unknown provider: ${provider}`), { status: 400 });
    }
    const Backend = backendClass(provider);

    const cwd = typeof body.cwd === 'string' && body.cwd.trim()
      ? path.resolve(body.cwd.trim())
      : (base.cwd || config.workspace.workspace);
    try {
      const info = await stat(cwd);
      if (!info.isDirectory()) throw new Error('not a directory');
    } catch (err) {
      throw Object.assign(new Error(`working directory unusable (${cwd}): ${err.message}`), { status: 400 });
    }

    const permissionMode = typeof body.permissionMode === 'string' && body.permissionMode.trim()
      ? body.permissionMode.trim()
      : (validPermissionMode(provider, base.permissionMode) ? base.permissionMode : Backend.defaultPermissionMode);
    if (!validPermissionMode(provider, permissionMode)) {
      throw Object.assign(new Error(`invalid permissionMode for ${provider}: ${permissionMode}`), { status: 400 });
    }

    const opts = {
      provider,
      model: typeof body.model === 'string' ? body.model.trim() : base.model,
      cwd,
      permissionMode,
      agent: typeof body.agent === 'string' ? body.agent.trim() : base.agent,
      appendSystemPrompt: typeof body.appendSystemPrompt === 'string' ? body.appendSystemPrompt : base.appendSystemPrompt,
      addDirs: Array.isArray(body.addDirs) ? body.addDirs.filter((d) => typeof d === 'string' && d.trim()) : base.addDirs,
      extraArgs: Array.isArray(body.extraArgs) ? body.extraArgs.filter((a) => typeof a === 'string') : base.extraArgs,
      sessionName: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : '',
    };
    const session = manager.create({
      opts,
      provider,
      name: opts.sessionName || `${Backend.label} session ${manager.sessions.size + 1}`,
    });
    sendJson(res, 201, { session: session.snapshot() });
  });

  route('GET', /^\/api\/sessions\/([^/]+)$/, async (req, res, url, match) => {
    sendJson(res, 200, { session: manager.require(decodeURIComponent(match[1])).snapshot() });
  });

  route('GET', /^\/api\/sessions\/([^/]+)\/logs$/, async (req, res, url, match) => {
    const session = manager.require(decodeURIComponent(match[1]));
    sendJson(res, 200, { logs: session.logs, running: session.alive });
  });

  route('POST', /^\/api\/sessions\/([^/]+)\/messages$/, async (req, res, url, match) => {
    const session = manager.require(decodeURIComponent(match[1]));
    const body = await readBody(req);
    const cwd = session.cwd || session.opts?.cwd || config.workspace.workspace;
    const item = session.send(body.text, normalizeAttachments(body.attachments, cwd));
    sendJson(res, 202, { ok: true, item });
  });

  route('POST', /^\/api\/sessions\/([^/]+)\/uploads$/, async (req, res, url, match) => {
    const session = manager.require(decodeURIComponent(match[1]));
    const body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
    const incoming = Array.isArray(body.files) ? body.files : [];
    if (!incoming.length) throw Object.assign(new Error('no files in request'), { status: 400 });
    if (incoming.length > MAX_UPLOADS_PER_MESSAGE) {
      throw Object.assign(new Error(`at most ${MAX_UPLOADS_PER_MESSAGE} files per message`), { status: 400 });
    }
    const cwd = session.cwd || session.opts?.cwd || config.workspace.workspace;
    const files = [];
    for (const file of incoming) {
      files.push(await storeUpload(cwd, file));
    }
    sendJson(res, 200, { ok: true, files });
  });

  // Query-string token works here because isAuthorized already accepts it, which
  // is what an <a download> needs — it cannot send an Authorization header.
  route('GET', /^\/api\/files$/, async (req, res, url) => {
    const roots = collectAllowedRoots({
      workspace: config.workspace,
      sessions: [...manager.sessions.values()],
    });
    const file = await resolveDownload(url.searchParams.get('path'), roots);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(file.path),
      'Content-Length': file.size,
      // attachment, never inline: user-supplied markup must not run in this origin
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    const stream = createReadStream(file.path);
    stream.on('error', (err) => {
      console.error(`[proxy] download failed: ${file.path}:`, err.message);
      res.destroy();
    });
    stream.pipe(res);
    return undefined;
  });

  route('POST', /^\/api\/sessions\/([^/]+)\/interrupt$/, async (req, res, url, match) => {
    const session = manager.require(decodeURIComponent(match[1]));
    sendJson(res, 200, { ok: true, interrupted: session.interrupt() });
  });

  route('POST', /^\/api\/sessions\/([^/]+)\/resume$/, async (req, res, url, match) => {
    const session = manager.resume(decodeURIComponent(match[1]));
    sendJson(res, 200, { ok: true, session: session.snapshot({ includeTranscript: false }) });
  });

  route('POST', /^\/api\/sessions\/([^/]+)\/stop$/, async (req, res, url, match) => {
    const session = manager.stop(decodeURIComponent(match[1]));
    sendJson(res, 200, { ok: true, session: session.snapshot({ includeTranscript: false }) });
  });

  route('DELETE', /^\/api\/sessions\/([^/]+)$/, async (req, res, url, match) => {
    manager.remove(decodeURIComponent(match[1]));
    sendJson(res, 200, { ok: true });
  });

  route('POST', /^\/api\/sessions\/([^/]+)\/permissions\/([^/]+)$/, async (req, res, url, match) => {
    const session = manager.require(decodeURIComponent(match[1]));
    if (!session.backend.constructor.supportsPermissionPrompts) {
      throw Object.assign(new Error(`${session.provider} has no interactive approval channel`), { status: 409 });
    }
    const body = await readBody(req);
    const resolved = session.resolvePermission(decodeURIComponent(match[2]), Boolean(body.allow), body.updatedInput);
    sendJson(res, resolved ? 200 : 404, { ok: resolved });
  });

  // Server-sent events: one global feed, every session's events tagged with
  // its id, so any number of browsers can watch (and drive) the same session.
  route('GET', /^\/api\/stream$/, async (req, res, url) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const onEvent = (event) => write('agent', event);
    const onChanged = () => write('sessions', { sessions: manager.list() });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      clearInterval(heartbeat);
      manager.off('event', onEvent);
      manager.off('changed', onChanged);
      res.end();
    };

    // The console's own stream is flagged so the host is not counted as a guest,
    // and so pausing the share does not hang up the tab holding the switch.
    const viewerId = presence.join({
      ip: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      admin: isAdmin(req, url),
      close: detach,
    });

    write('hello', {
      serverTime: Date.now(),
      viewerId,
      sessions: manager.list(),
      sessionDefaults: config.sessionDefaults,
      providers: allProviderMeta(),
      workspace: config.workspace,
      authEnabled: !authDisabled,
    });

    manager.on('event', onEvent);
    manager.on('changed', onChanged);

    req.on('close', () => {
      presence.leave(viewerId);
      detach();
    });
  });

  // Which session a viewer is looking at. Only the id: the console shows the
  // model in use, never a line of the conversation.
  route('POST', /^\/api\/presence$/, async (req, res) => {
    const body = await readBody(req);
    const known = presence.touch(String(body.viewerId ?? ''), { sessionId: body.sessionId ?? null });
    sendJson(res, 200, { ok: true, known });
  });

  // ------------------------------------------------------------ admin console

  const shareUrl = () => {
    const lan = lanUrls(config.port, config.host);
    const base = lan[0] ?? `http://127.0.0.1:${config.port}`;
    return authDisabled ? `${base}/` : `${base}/?token=${encodeURIComponent(config.token)}`;
  };

  const modelOf = (session) => session.observedModel || session.opts?.model || '';

  /**
   * Hand-built projection rather than `session.snapshot()`: the snapshot carries
   * the transcript and the in-flight assistant text, and the console must never
   * see what anyone is saying.
   */
  const adminSessions = () => [...manager.sessions.values()]
    .map((session) => ({
      id: session.id,
      name: session.name,
      provider: session.provider,
      providerLabel: session.backend.constructor.label,
      model: modelOf(session),
      status: session.status,
      busy: session.busy,
      alive: session.alive,
      turnCount: session.turnCount,
      cwd: session.cwd ?? session.opts?.cwd ?? '',
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  route('GET', /^\/api\/admin\/state$/, async (req, res) => {
    const binaries = await providerHealth();
    const describe = (id) => {
      const session = manager.get(id);
      if (!session) return null;
      return {
        name: session.name,
        provider: session.backend.constructor.label,
        model: modelOf(session),
      };
    };
    sendJson(res, 200, {
      sharing,
      version: VERSION,
      node: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      hostname: os.hostname(),
      authEnabled: !authDisabled,
      listen: { host: config.host, port: config.port },
      lanUrls: lanUrls(config.port, config.host),
      shareUrl: shareUrl(),
      token: authDisabled ? '' : config.token,
      workspace: config.workspace,
      maxSessions: config.maxSessions,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      providers: allProviderMeta().map((meta) => ({ ...meta, binary: binaries[meta.id] })),
      stats: presence.stats(),
      viewers: presence.list(describe),
      sessions: adminSessions(),
    });
  });

  route('POST', /^\/api\/admin\/sharing$/, async (req, res) => {
    const body = await readBody(req);
    sharing = Boolean(body.enabled);
    // Guests keep an open SSE stream, so flipping the switch has to hang them
    // up too — otherwise they would go on receiving events after the close.
    const closed = sharing ? 0 : presence.disconnect();
    console.log(`[proxy] sharing ${sharing ? 'resumed' : 'paused'} from the console${closed ? ` (${closed} viewer(s) disconnected)` : ''}`);
    sendJson(res, 200, { ok: true, sharing, disconnected: closed });
  });

  route('POST', /^\/api\/admin\/kick$/, async (req, res) => {
    const body = await readBody(req);
    const id = String(body.viewerId ?? '');
    sendJson(res, 200, { ok: true, disconnected: id ? presence.disconnect(id) : 0 });
  });

  route('POST', /^\/api\/admin\/shutdown$/, async (req, res) => {
    sendJson(res, 200, { ok: true, stopping: true });
    // Let the response flush before the process goes away.
    setTimeout(() => requestShutdown?.('console request'), 150).unref();
  });

  // ------------------------------------------------------------------- server

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname.startsWith('/api/admin/')) {
          if (!isAdmin(req, url)) {
            return sendJson(res, 401, { error: 'admin token required' });
          }
        } else {
          const publicPaths = ['/api/health', '/api/auth'];
          if (!publicPaths.includes(url.pathname)) {
            if (!isAuthorized(req, url)) {
              return sendJson(res, 401, { error: 'unauthorized', authEnabled: !authDisabled });
            }
            // Paused from the console: guests are turned away while the host,
            // who holds the admin token, can still use their own tab.
            if (!sharing && !isAdmin(req, url)) {
              return sendJson(res, 503, { error: 'sharing paused', sharing: false });
            }
          }
        }
        for (const entry of routes) {
          if (entry.method !== req.method) continue;
          const match = url.pathname.match(entry.pattern);
          if (!match) continue;
          await entry.handler(req, res, url, match);
          return undefined;
        }
        return sendJson(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      return await serveStatic(req, res, url);
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 500;
      if (status >= 500) console.error(`[proxy] ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
      return undefined;
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[proxy] port ${config.port} is already in use — try --port ${config.port + 1}`);
      process.exit(1);
    }
    throw err;
  });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));

  const shutdown = (signal) => {
    console.log(`\n[proxy] ${signal}, shutting down`);
    manager.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  requestShutdown = shutdown;

  const urls = [...new Set([`http://127.0.0.1:${config.port}`, ...lanUrls(config.port, config.host)])];
  console.log('');
  console.log('  agent-session-proxy');
  console.log(`  workspace : ${config.workspace.workspace}${config.workspace.ok ? '' : `  (unusable: ${config.workspace.error})`}`);
  for (const id of PROVIDER_IDS) {
    console.log(`  ${id.padEnd(9)} : ${binaryPath(id)}`);
  }
  console.log(`  sessions  : ${manager.sessions.size} restored, max ${config.maxSessions}`);
  console.log('');
  for (const url of urls) console.log(`  → ${url}`);
  console.log('');
  if (authDisabled) {
    console.log('  ⚠ auth DISABLED — anyone on this network can drive these CLIs on this machine.');
  } else {
    console.log(`  passphrase: ${config.token}${tokenGenerated ? '   (generated, saved to config.json)' : ''}`);
    console.log(`  share     : ${urls.find((u) => !u.includes('127.0.0.1')) ?? urls[0]}/?token=${config.token}`);
  }
  console.log('');
  // Host-only secret: it is never sent to the guest UI, so the console URL is
  // printed here and nowhere else.
  console.log(`  console   : http://127.0.0.1:${config.port}/admin.html?admin=${config.adminToken}`);
  console.log('');
}

main().catch((err) => {
  console.error('[proxy] fatal:', err);
  process.exit(1);
});
