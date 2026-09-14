/* agent-session-proxy — web client */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const TOKEN_KEY = 'asp.token';
const MD_THROTTLE_MS = 120;

const state = {
  token: '',
  authEnabled: true,
  config: null,
  providers: [],
  models: {},
  server: null,
  sessions: [],
  currentId: null,
  current: null,
  liveMessages: new Map(),
  toolSlots: new Map(),
  logs: new Map(),
  pendingPermissions: new Map(),
  activityText: '',
  pendingFiles: [],
  uploading: false,
  dir: { target: null, path: '', selected: '' },
  es: null,
  viewerId: null,
};

/* ────────────────────────────── small utils ────────────────────────────── */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtAgo(ts) {
  if (!ts) return '';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

function fmtDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(usage) {
  if (!usage) return '';
  const parts = [];
  if (usage.input_tokens) parts.push(`in ${usage.input_tokens}`);
  if (usage.output_tokens) parts.push(`out ${usage.output_tokens}`);
  if (usage.cache_read_input_tokens) parts.push(`cache ${usage.cache_read_input_tokens}`);
  return parts.join(' · ');
}

function shortPath(p, max = 34) {
  if (!p) return '';
  return p.length > max ? `…${p.slice(-max)}` : p;
}

function lines(value) {
  return String(value ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/* ───────────────────────────── markdown ───────────────────────────── */

/** An <a> cannot send an Authorization header, so the token rides in the query. */
function downloadUrl(absPath) {
  const token = state.token ? `&token=${encodeURIComponent(state.token)}` : '';
  return `/api/files?path=${encodeURIComponent(absPath)}${token}`;
}

// Absolute paths, bounded so they cannot start or end inside a longer token.
const FILE_PATH_RE = /(^|[^\w~/.-])((?:\/[\w.@+~-]+)+)(?=$|[^\w~/.-])/g;

function linkifyPaths(escaped) {
  return escaped.replace(FILE_PATH_RE, (match, prefix, candidate) => {
    const base = candidate.slice(candidate.lastIndexOf('/') + 1);
    // Directories are not downloadable; require a real extension.
    if (!/\.[A-Za-z0-9]{1,10}$/.test(base)) return match;
    return `${prefix}<a class="file-link" href="${downloadUrl(candidate)}" download title="下载到本地">${candidate}</a>`;
  });
}

function inlineMd(escaped) {
  // Pulled out first: a path regex would otherwise match "/b.txt" inside
  // "http://a.com/b.txt" and shred the markdown link around it.
  const urls = [];
  const text = String(escaped).replace(/https?:\/\/[^\s<)"']+/g, (found) => {
    urls.push(found);
    return `\u0000U${urls.length - 1}\u0000`;
  });

  const rendered = linkifyPaths(text)
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((\u0000U\d+\u0000|https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Already escaped when extracted, and only http(s) can match, so restore raw.
  return rendered.replace(/\u0000U(\d+)\u0000/g, (_, index) => urls[Number(index)]);
}

/**
 * Everything from the model is escaped before any markup is produced, so the
 * only HTML in the output is what this function writes itself.
 */
function renderMarkdown(src) {
  const fences = [];
  const withPlaceholders = String(src ?? '').replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    fences.push({ lang: (lang || '').trim(), code });
    return `\u0000F${fences.length - 1}\u0000`;
  });

  const out = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inlineMd(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };

  for (const line of escapeHtml(withPlaceholders).split('\n')) {
    const fence = line.match(/^\u0000F(\d+)\u0000$/);
    if (fence) {
      flushPara(); flushList();
      const entry = fences[Number(fence[1])];
      out.push(`<pre><code>${escapeHtml(entry.code.replace(/\n$/, ''))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }

    let match;
    if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); flushList();
      const level = match[1].length;
      out.push(`<h${level}>${inlineMd(match[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if ((match = line.match(/^\s*([-*+])\s+(.*)$/))) {
      flushPara();
      if (list?.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(match[2]);
      continue;
    }
    if ((match = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list?.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(match[1]);
      continue;
    }
    if ((match = line.match(/^\s*&gt;\s?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote>${inlineMd(match[1])}</blockquote>`);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();

  // A fence that was not alone on its line never matched the block pass above.
  return out.join('\n').replace(/\u0000F(\d+)\u0000/g, (_, i) => (
    `<pre><code>${escapeHtml(fences[Number(i)].code.replace(/\n$/, ''))}</code></pre>`
  ));
}

/* ─────────────────────────────── api client ─────────────────────────────── */

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && path !== '/api/auth') {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    showGate('口令已失效，请重新输入');
    throw new Error(data?.error ?? 'unauthorized');
  }
  if (res.status === 503 && data?.sharing === false) {
    showPaused();
    throw new Error(data.error ?? 'sharing paused');
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * The host paused sharing from their console. Poll until it is back rather than
 * asking the visitor to keep hitting refresh.
 */
let pausedPoll = null;
function showPaused() {
  if (pausedPoll) return;
  state.es?.close();
  document.body.replaceChildren(el('div', {
    class: 'gate',
    html: '<div class="gate-card"><div class="gate-mark">⏸</div>'
      + '<h1>主人暂停了共享</h1>'
      + '<p class="muted">会话和历史都还在，等对方重新打开就能继续。<br>这个页面会自己恢复，不用刷新。</p></div>',
  }));
  pausedPoll = setInterval(async () => {
    try {
      const health = await (await fetch('/api/health')).json();
      if (health.sharing) location.reload();
    } catch { /* the service is down; keep waiting */ }
  }, 5_000);
}

/**
 * Tell the host's console which session this tab is on — the id only, so the
 * console can show "which model" without ever seeing the conversation. Failures
 * are ignored: this is a courtesy signal, not part of the chat path.
 */
function reportPresence() {
  if (!state.viewerId) return;
  api('/api/presence', { method: 'POST', body: { viewerId: state.viewerId, sessionId: state.currentId } })
    .catch(() => {});
}

/* ───────────────────────────────── gate ───────────────────────────────── */

function showGate(message = '') {
  $('#app').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  const err = $('#gateError');
  err.textContent = message;
  err.classList.toggle('hidden', !message);
  $('#gateToken').value = '';
  $('#gateToken').focus();
}

async function verifyToken(token) {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return res.ok;
}

/* ─────────────────────────── transcript rendering ─────────────────────────── */

function transcriptRoot() {
  return $('#transcriptItems');
}

function scrollToBottom(force = false) {
  const wrap = $('#transcript');
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 160;
  if (force || nearBottom) wrap.scrollTop = wrap.scrollHeight;
}

function buildToolCard(block) {
  const args = el('pre', { class: 'tool-args', text: JSON.stringify(block.input ?? {}, null, 2) });
  const resultSlot = el('div');
  if (block.id) state.toolSlots.set(block.id, resultSlot);
  const body = el('div', { class: 'disclosure-body' }, [args, resultSlot]);
  const filePath = block.input?.file_path ?? block.input?.path;
  const downloadable = typeof filePath === 'string' && filePath.startsWith('/');
  return el('details', { class: 'disclosure' }, [
    el('summary', {}, [
      el('span', { class: 'caret', text: '▶' }),
      el('span', { text: '🔧' }),
      el('span', { class: 'tool-name', text: block.name ?? 'tool' }),
      downloadable
        ? el('a', {
          class: 'tool-download',
          href: downloadUrl(filePath),
          download: '',
          title: `下载 ${filePath}`,
          text: '⬇ 下载',
          // Keep the click from toggling the disclosure.
          onclick: (event) => event.stopPropagation(),
        })
        : null,
    ]),
    body,
  ]);
}

function attachToolResult(item) {
  const slot = item.toolUseId ? state.toolSlots.get(item.toolUseId) : null;
  const body = el('div', { class: `tool-result${item.isError ? ' is-error' : ''}` }, [
    el('div', { class: 'msg-role', text: item.isError ? '出错' : '结果' }),
    el('pre', { text: item.content || '(空)' }),
  ]);
  if (slot) {
    slot.replaceChildren(body);
    return null;
  }
  return el('details', { class: 'disclosure', open: item.isError ? '' : null }, [
    el('summary', {}, [
      el('span', { class: 'caret', text: '▶' }),
      el('span', { text: item.isError ? '⚠️' : '📄' }),
      el('span', { class: 'tool-name', text: '工具结果' }),
      item.isError ? el('span', { class: 'badge-error', text: 'error' }) : null,
    ]),
    el('div', { class: 'disclosure-body' }, [
      el('pre', { class: 'tool-args', text: item.content || '(空)' }),
    ]),
  ]);
}

function buildItemNode(item) {
  if (item.kind === 'user') {
    const attachments = item.attachments ?? [];
    return el('div', { class: `msg msg-user ${item.state ?? 'sent'}`, 'data-item-id': item.id }, [
      item.text ? el('div', { class: 'msg-body', text: item.text }) : null,
      attachments.length
        ? el('div', { class: 'msg-attachments' }, attachments.map((file) => el('a', {
          class: 'attach-chip sent',
          href: downloadUrl(file.path),
          download: '',
          title: file.path,
        }, [
          el('span', { class: 'attach-icon', text: file.isImage ? '🖼' : '📄' }),
          el('span', { class: 'attach-name', text: file.name }),
        ])))
        : null,
    ]);
  }

  if (item.kind === 'assistant') {
    const blocks = (item.blocks ?? []).map((block) => {
      if (block.type === 'tool_use') return buildToolCard(block);
      if (block.type === 'thinking') {
        if (!block.text?.trim()) return null;
        return el('details', { class: 'disclosure disclosure-thinking' }, [
          el('summary', {}, [
            el('span', { class: 'caret', text: '▶' }),
            el('span', { text: '💭 思考过程' }),
            el('span', { class: 'muted small', text: `${block.text.length} 字` }),
          ]),
          el('div', { class: 'disclosure-body', text: block.text }),
        ]);
      }
      if (!block.text?.trim()) return null;
      return el('div', { class: 'prose', html: renderMarkdown(block.text) });
    }).filter(Boolean);

    return el('div', { class: 'msg msg-assistant', 'data-message-id': item.id ?? '' }, [
      el('div', { class: 'msg-role' }, [
        el('span', { text: providerBadge() }),
        item.model ? el('span', { class: 'model-tag', text: item.model }) : null,
      ]),
      ...(blocks.length ? blocks : [el('div', { class: 'prose muted', text: '(无文本输出)' })]),
    ]);
  }

  if (item.kind === 'tool_result') return attachToolResult(item);

  if (item.kind === 'turn') {
    const bits = [];
    if (item.subtype && item.subtype !== 'success') bits.push(item.subtype);
    if (item.durationMs != null) bits.push(fmtDuration(item.durationMs));
    const tokens = fmtTokens(item.usage);
    if (tokens) bits.push(tokens);
    if (item.note) bits.push(item.note);
    if (!bits.length) return null;
    return el('div', { class: `turn-meta${item.isError ? ' is-error' : ''}`, text: `— ${bits.join('  ·  ')}` });
  }

  return null;
}

function appendItem(item) {
  const node = buildItemNode(item);
  if (!node) return;
  transcriptRoot().append(node);
  scrollToBottom();
}

function renderTranscript(items) {
  state.toolSlots.clear();
  const root = transcriptRoot();
  root.replaceChildren();
  for (const item of items) {
    const node = buildItemNode(item);
    if (node) root.append(node);
  }
  scrollToBottom(true);
}

/* ─────────────────────────── live streaming render ─────────────────────────── */

function clearLive() {
  state.liveMessages.clear();
  state.activityText = '';
  $('#live').replaceChildren();
  $('#live').classList.add('hidden');
}

/** codex reports progress per item rather than streaming tokens. */
function renderActivity(text, output) {
  if (!text) {
    clearLive();
    return;
  }
  const live = $('#live');
  let card = live.querySelector('.activity-card');
  if (!card) {
    card = el('div', { class: 'live-card activity-card' }, [
      el('div', { class: 'live-head' }, [
        el('span', { class: 'spinner' }),
        el('span', { class: 'activity-text' }),
      ]),
    ]);
    live.replaceChildren(card);
    live.classList.remove('hidden');
  }
  card.querySelector('.activity-text').textContent = text;
  const existing = card.querySelector('.activity-output');
  if (output) {
    const out = existing ?? el('pre', { class: 'activity-output' });
    out.textContent = output;
    if (!existing) card.append(out);
  } else if (existing) {
    existing.remove();
  }
  scrollToBottom();
}

/** Seed the live region from a snapshot when joining a session mid-turn. */
function restoreLive(liveState) {
  clearLive();
  if (!liveState) return;
  if (liveState.activity) {
    state.activityText = liveState.activity;
    renderActivity(liveState.activity);
    return;
  }
  if (!liveState.messageId) return;
  for (const block of liveState.blocks ?? []) {
    const liveBlock = ensureLiveBlock(liveState.messageId, block.index, block);
    liveBlock.text = block.text ?? '';
    paintLiveBlock(liveBlock);
  }
}

function dropLiveMessage(messageId) {
  const entry = state.liveMessages.get(messageId);
  if (!entry) return;
  entry.el.remove();
  state.liveMessages.delete(messageId);
  if (!state.liveMessages.size) $('#live').classList.add('hidden');
}

function ensureLiveMessage(messageId, model) {
  let entry = state.liveMessages.get(messageId);
  if (entry) return entry;
  const card = el('div', { class: 'live-card' }, [
    el('div', { class: 'live-head' }, [
      el('span', { class: 'spinner' }),
      el('span', { text: `${providerBadge()} 正在输出` }),
      model ? el('span', { class: 'model-tag muted', text: model }) : null,
    ]),
  ]);
  entry = { el: card, blocks: new Map() };
  state.liveMessages.set(messageId, entry);
  $('#live').append(card);
  $('#live').classList.remove('hidden');
  scrollToBottom();
  return entry;
}

function ensureLiveBlock(messageId, index, info) {
  const message = ensureLiveMessage(messageId, info.model);
  const existing = message.blocks.get(index);
  if (existing) return existing;

  let node;
  let textEl = null;

  if (info.type === 'tool_use') {
    node = el('div', { class: 'disclosure' }, [
      el('div', { class: 'disclosure-body' }, [
        el('span', { text: '🔧 ' }),
        el('span', { class: 'tool-name', text: info.name ?? 'tool' }),
        el('span', { class: 'muted small', text: ' 准备参数…' }),
      ]),
    ]);
  } else {
    textEl = el('div', { class: info.type === 'thinking' ? 'thinking-text' : 'prose caret-blink' });
    node = info.type === 'thinking'
      ? el('details', { class: 'disclosure disclosure-thinking', open: '' }, [
        el('summary', {}, [el('span', { text: '💭 思考中…' })]),
        el('div', { class: 'disclosure-body' }, [textEl]),
      ])
      : el('div', { class: 'live-block' }, [textEl]);
  }

  const block = {
    type: info.type,
    text: info.text ?? '',
    name: info.name ?? null,
    el: node,
    textEl,
    renderedAt: 0,
    pendingRender: false,
  };
  message.blocks.set(index, block);
  message.el.append(node);
  scrollToBottom();
  return block;
}

function paintLiveBlock(block) {
  if (!block.textEl) return;
  if (block.type === 'thinking') {
    block.textEl.textContent = block.text;
  } else {
    block.textEl.innerHTML = renderMarkdown(block.text);
  }
  block.renderedAt = Date.now();
  block.pendingRender = false;
  scrollToBottom();
}

function scheduleLivePaint(block) {
  if (block.pendingRender) return;
  const wait = Math.max(0, MD_THROTTLE_MS - (Date.now() - block.renderedAt));
  block.pendingRender = true;
  setTimeout(() => paintLiveBlock(block), wait);
}

/* ───────────────────────────── notices + logs ───────────────────────────── */

function showNotice(text) {
  const box = $('#notice');
  if (!text) {
    box.classList.add('hidden');
    box.replaceChildren();
    return;
  }
  box.replaceChildren(el('div', { class: 'notice-inner', text }));
  box.classList.remove('hidden');
}

function pushLog(sessionId, entry) {
  const list = state.logs.get(sessionId) ?? [];
  list.push(entry);
  if (list.length > 400) list.splice(0, list.length - 400);
  state.logs.set(sessionId, list);
}

/* ─────────────────────────── permission prompts ─────────────────────────── */

function renderPermissions() {
  const bar = $('#permissionBar');
  bar.replaceChildren();
  if (!state.pendingPermissions.size) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  for (const request of state.pendingPermissions.values()) {
    bar.append(el('div', { class: 'permission-card' }, [
      el('div', { class: 'p-title' }, [
        el('span', { text: '请求使用工具 ' }),
        el('span', { class: 'tool-name', text: request.toolName }),
      ]),
      el('pre', { text: JSON.stringify(request.input ?? {}, null, 2) }),
      el('div', { class: 'p-actions' }, [
        el('button', {
          class: 'btn btn-primary btn-sm',
          text: '允许',
          onclick: () => answerPermission(request.id, true),
        }),
        el('button', {
          class: 'btn btn-danger btn-sm',
          text: '拒绝',
          onclick: () => answerPermission(request.id, false),
        }),
      ]),
    ]));
  }
  scrollToBottom();
}

async function answerPermission(requestId, allow) {
  state.pendingPermissions.delete(requestId);
  renderPermissions();
  try {
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/permissions/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: { allow },
    });
  } catch (err) {
    showNotice(`权限应答失败：${err.message}`);
  }
}

/* ───────────────────────────── agent events ───────────────────────────── */

function onAgentEvent(event) {
  const sessionId = event.sessionId;
  if (!sessionId) return;

  if (event.type === 'log') {
    pushLog(sessionId, event.entry);
    if (sessionId === state.currentId && !$('#logsModal').classList.contains('hidden')) renderLogs();
    return;
  }

  if (event.type === 'status') {
    const summary = state.sessions.find((s) => s.id === sessionId);
    if (summary) {
      summary.status = event.status;
      summary.busy = event.status === 'busy';
      renderSessionList();
    }
    if (sessionId === state.currentId) {
      if (state.current) state.current.status = event.status;
      updateChrome();
    }
    return;
  }

  if (sessionId !== state.currentId) return;

  switch (event.type) {
    case 'init':
      if (state.current) {
        state.current.agentSessionId = event.agentSessionId ?? state.current.agentSessionId;
        state.current.cwd = event.cwd ?? state.current.cwd;
        state.current.cliVersion = event.cliVersion ?? state.current.cliVersion;
      }
      showNotice('');
      updateChrome();
      break;

    case 'activity':
      state.activityText = event.text;
      renderActivity(event.text);
      break;

    case 'activity_output':
      renderActivity(state.activityText, event.text);
      break;

    case 'message_start':
      ensureLiveMessage(event.messageId, event.model);
      break;

    case 'block_start':
      ensureLiveBlock(event.messageId, event.block.index, { ...event.block, model: state.current?.observedModel });
      break;

    case 'delta': {
      const block = ensureLiveBlock(event.messageId, event.index, {
        type: event.deltaType === 'thinking_delta' ? 'thinking'
          : event.deltaType === 'input_json_delta' ? 'tool_use' : 'text',
        model: state.current?.observedModel,
      });
      block.text += event.text;
      if (block.type === 'tool_use') {
        block.el.querySelector('.small').textContent = ' 拼接参数…';
      } else {
        scheduleLivePaint(block);
      }
      break;
    }

    case 'block_stop': {
      const message = state.liveMessages.get(event.messageId);
      const block = message?.blocks.get(event.block.index);
      if (block) {
        block.text = event.block.text ?? block.text;
        paintLiveBlock(block);
        block.textEl?.classList.remove('caret-blink');
      }
      break;
    }

    case 'item':
      if (event.item.kind === 'assistant') dropLiveMessage(event.item.id);
      if (event.item.kind === 'turn') {
        // An interrupted turn never sends message_stop, so its partial streaming
        // card would otherwise be left on screen after the turn is over.
        clearLive();
        showNotice('');
      }
      if (state.current) state.current.transcript.push(event.item);
      appendItem(event.item);
      break;

    case 'item_update': {
      const node = transcriptRoot().querySelector(`[data-item-id="${CSS.escape(event.id)}"]`);
      if (node) {
        node.classList.remove('queued', 'sent', 'dropped');
        node.classList.add(event.state);
      }
      const stored = state.current?.transcript.find((i) => i.id === event.id);
      if (stored) stored.state = event.state;
      break;
    }

    case 'queued':
      break;

    case 'permission_request':
      state.pendingPermissions.set(event.request.id, event.request);
      renderPermissions();
      break;

    case 'permission_resolved':
      state.pendingPermissions.delete(event.id);
      renderPermissions();
      break;

    case 'permission_cancelled':
      state.pendingPermissions.delete(event.id);
      renderPermissions();
      break;

    case 'notice':
      showNotice(event.message);
      break;

    case 'interrupting':
      showNotice('正在请求中断…');
      break;

    case 'error':
      showNotice(event.message);
      break;

    case 'session_closed':
      clearLive();
      refreshSessions();
      if (state.current) {
        const canResume = state.current.persistent !== false && state.current.agentSessionId;
        showNotice(`${state.current.providerLabel ?? state.current.provider} 进程已结束（${event.reason}）。${canResume ? '可以点“恢复进程”用同一个上下文继续。' : ''}`);
      }
      updateChrome();
      break;

    default:
      break;
  }
}

/* ───────────────────────────── session chrome ───────────────────────────── */

function updateChrome() {
  const session = state.current;
  const has = Boolean(session);
  $('#empty').classList.toggle('hidden', has);
  $('#transcriptWrap').classList.toggle('hidden', !has);
  $('#composer').classList.toggle('hidden', !has);

  const badge = $('#sessionBadge');
  if (!has) {
    badge.textContent = '';
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');
  badge.textContent = `${session.name} · ${session.providerLabel ?? session.provider} · ${shortPath(session.cwd ?? session.opts?.cwd ?? '', 34)}`;
  badge.title = session.cwd ?? session.opts?.cwd ?? '';

  const persistent = session.persistent !== false;
  const busy = session.status === 'busy';
  const stopped = persistent && (session.status === 'closed' || session.status === 'error');
  $('#sendBtn').disabled = state.uploading || busy || (session.status === 'error' && !session.agentSessionId);
  $('#stopBtn').classList.toggle('hidden', !busy);
  $('#resumeBtn').classList.toggle('hidden', !stopped || !session.agentSessionId);
  $('#input').placeholder = state.uploading
    ? '正在上传附件…'
    : busy
      ? '正在处理上一条，这条会排队…'
      : stopped
        ? '会话进程已停止，发送消息会自动恢复'
        : '发消息…（Enter 发送 / Shift+Enter 换行，可粘贴或拖入图片）';

  const meta = [];
  meta.push(session.providerLabel ?? session.provider);
  if (session.observedModel ?? session.opts?.model) meta.push(`模型 ${session.observedModel ?? session.opts.model}`);
  meta.push(`权限 ${session.opts?.permissionMode ?? '-'}`);
  meta.push(`回合 ${session.turnCount ?? 0}`);
  if (session.queueLength) meta.push(`排队 ${session.queueLength}`);
  if (session.agentSessionId) meta.push(`id ${session.agentSessionId.slice(0, 8)}`);
  $('#composerMeta').textContent = meta.join('  ·  ');
}

function renderSessionList() {
  const list = $('#sessionList');
  list.replaceChildren();
  if (!state.sessions.length) {
    list.append(el('li', { class: 'muted small', style: 'padding:14px 10px', text: '还没有会话' }));
    return;
  }
  for (const summary of state.sessions) {
    const item = el('li', {
      class: `session-item${summary.id === state.currentId ? ' active' : ''}`,
      onclick: () => selectSession(summary.id),
    }, [
      el('span', { class: `s-dot ${summary.status}` }),
      el('div', { class: 's-main' }, [
        el('div', { class: 's-name', text: summary.name, title: summary.name }),
        el('div', {
          class: 's-meta',
          text: `${statusLabel(summary.status)} · ${summary.provider ?? 'qodercli'} · ${shortPath(summary.cwd ?? summary.opts?.cwd ?? '', 22)} · ${fmtAgo(summary.lastActiveAt)}`,
          title: summary.cwd ?? summary.opts?.cwd ?? '',
        }),
      ]),
    ]);
    list.append(item);
  }
}

function statusLabel(status) {
  return {
    starting: '启动中', idle: '空闲', busy: '运行中', closed: '已停止', error: '出错',
  }[status] ?? status;
}

function setSessions(sessions) {
  state.sessions = sessions ?? [];
  if (state.currentId && !state.sessions.some((s) => s.id === state.currentId)) {
    state.currentId = null;
    state.current = null;
    clearLive();
    renderTranscript([]);
    showNotice('');
  }
  renderSessionList();
  updateChrome();
}

async function refreshSessions() {
  try {
    const data = await api('/api/sessions');
    setSessions(data.sessions);
  } catch { /* the SSE feed will catch up */ }
}

async function selectSession(id) {
  if (id === state.currentId && state.current) return;
  state.currentId = id;
  clearLive();
  state.pendingPermissions.clear();
  // Attachments upload into the current session's directory; do not carry them over.
  state.pendingFiles = [];
  renderAttachTray();
  renderPermissions();
  showNotice('');
  renderSessionList();
  reportPresence();
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
    state.current = data.session;
    if (!state.current.transcript) state.current.transcript = [];
    for (const request of state.current.pendingPermissions ?? []) {
      state.pendingPermissions.set(request.id, request);
    }
    renderPermissions();
    renderTranscript(state.current.transcript);
    restoreLive(state.current.live);
    if (state.current.error) showNotice(state.current.error);
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  } catch (err) {
    state.current = null;
    showNotice(`加载会话失败：${err.message}`);
  }
  updateChrome();
  $('#sidebar').classList.remove('open');
}

/* ───────────────────────────── model / config ───────────────────────────── */

function providerMeta(id) {
  return state.providers.find((provider) => provider.id === id) ?? state.providers[0] ?? null;
}

/** Short badge for the message gutter: "Qoder CLI" -> "QODER", "Codex CLI" -> "CODEX". */
function providerBadge() {
  const label = state.current?.providerLabel
    || providerMeta(state.current?.provider)?.label
    || 'Qoder CLI';
  return label.split(' ')[0].toUpperCase();
}

function currentProviderId(form) {
  return form?.elements?.provider?.value || state.config?.sessionDefaults?.provider || 'qodercli';
}

function fillProviderSelect(select, chosen) {
  select.replaceChildren();
  // Fail open: binary health is only known once /api/server has answered.
  const isUsable = (provider) => provider.binary ? provider.binary.ok : true;
  for (const provider of state.providers) {
    const ok = isUsable(provider);
    const kind = provider.persistent ? '常驻进程，逐字流式' : '每轮一个进程，整段返回';
    select.append(el('option', {
      value: provider.id,
      text: ok ? `${provider.label}（${kind}）` : `${provider.label}（未安装）`,
      disabled: !ok,
    }));
  }
  const usable = state.providers.filter(isUsable);
  const want = usable.some((p) => p.id === chosen) ? chosen : usable[0]?.id;
  if (want) select.value = want;
}

function fillModelSelect(select, provider, chosen) {
  select.replaceChildren();
  const values = new Set();
  for (const model of state.models[provider] ?? []) {
    if (values.has(model.value)) continue;
    values.add(model.value);
    select.append(el('option', { value: model.value, text: model.label }));
  }
  if (chosen && !values.has(chosen)) {
    select.append(el('option', { value: chosen, text: `${chosen}（自定义）` }));
  }
  select.value = chosen && values.has(chosen) ? chosen : (select.value ?? '');
}

function fillPermissionSelect(select, provider, chosen) {
  const meta = providerMeta(provider);
  select.replaceChildren();
  for (const mode of meta?.permissionModes ?? []) {
    select.append(el('option', { value: mode.value, text: mode.label }));
  }
  const wanted = chosen && (meta?.permissionModes ?? []).some((m) => m.value === chosen)
    ? chosen
    : meta?.defaultPermissionMode;
  if (wanted) select.value = wanted;
}

function providerHint(provider) {
  const meta = providerMeta(provider);
  if (!meta) return '';
  const bits = [];
  bits.push(meta.persistent
    ? '一个常驻进程维持多轮上下文，输出逐字流式。'
    : '每轮启动一个 `codex exec`，用 thread id 续接上下文，输出整段返回。');
  if (!meta.supportsPermissionPrompts) bits.push('没有交互式审批，权限由沙箱策略决定。');
  if (!meta.persistent) bits.push('「Agent」和「追加系统提示词」是 qodercli 专有，对 codex 无效。');
  return bits.join(' ');
}

async function loadModels(provider, force = false) {
  if ((state.models[provider]?.length) && !force) return state.models[provider];
  try {
    const query = new URLSearchParams({ provider, ...(force ? { refresh: '1' } : {}) });
    const data = await api(`/api/models?${query}`);
    state.models[provider] = data.models ?? [];
  } catch (err) {
    state.models[provider] = [];
    console.warn(`model list unavailable for ${provider}:`, err.message);
  }
  return state.models[provider];
}

async function loadServerInfo() {
  try {
    state.server = await api('/api/server');
  } catch {
    state.server = null;
  }
  mergeProviderHealth();
  renderServerBadge();
  renderShareRow();
}

/** Only /api/server reports binary health; fold it into the list the dropdowns read. */
function mergeProviderHealth() {
  const health = new Map((state.server?.providers ?? []).map((p) => [p.id, p.binary]));
  if (!health.size) return;
  for (const provider of state.providers) {
    if (health.has(provider.id)) provider.binary = health.get(provider.id);
  }
}

function renderServerBadge() {
  const badge = $('#serverBadge');
  const info = state.server;
  badge.className = 'server-badge';
  if (!info) {
    badge.classList.add('bad');
    badge.replaceChildren(el('span', { class: 'dot' }), el('span', { text: '服务状态未知' }));
    return;
  }
  const providers = info.providers ?? [];
  const usable = providers.filter((provider) => provider.binary?.ok);
  badge.classList.add(usable.length ? 'ok' : 'bad');
  const label = usable.length
    ? `${usable.map((p) => `${p.id} ${p.binary.version || ''}`.trim()).join(' · ')} · ${info.hostname}`
    : '没有可用的 CLI';
  const title = providers
    .map((p) => `${p.id}: ${p.binary?.path ?? '?'} — ${p.binary?.ok ? (p.binary.version || 'ok') : (p.binary?.error || 'unavailable')}`)
    .join('\n');
  badge.replaceChildren(el('span', { class: 'dot' }), el('span', { text: label, title }));
}

function renderShareRow() {
  const row = $('#shareRow');
  row.replaceChildren();
  const info = state.server;
  if (!info) return;
  const lan = info.lanUrls?.[0];
  if (!lan) return;
  const shareUrl = state.token ? `${lan}/?token=${encodeURIComponent(state.token)}` : lan;
  const link = el('div', {
    class: 'share-link',
    text: shareUrl,
    title: '点击复制分享链接',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        link.textContent = '已复制 ✓';
        setTimeout(() => { link.textContent = shareUrl; }, 1600);
      } catch {
        window.prompt('复制这个链接：', shareUrl);
      }
    },
  });
  row.append(el('div', { class: 'muted small', text: '分享链接（点击复制）' }), link);
}

/* ─────────────────────────────── modals ─────────────────────────────── */

function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

async function openNewSession() {
  const form = $('#newSessionForm');
  const defaults = state.config?.sessionDefaults ?? {};
  fillProviderSelect(form.elements.provider, defaults.provider);
  await syncProviderFields(form, defaults);
  form.elements.name.value = '';
  form.elements.cwd.value = defaults.cwd ?? '';
  form.elements.agent.value = defaults.agent ?? '';
  form.elements.appendSystemPrompt.value = defaults.appendSystemPrompt ?? '';
  form.elements.addDirs.value = (defaults.addDirs ?? []).join('\n');
  form.elements.extraArgs.value = (defaults.extraArgs ?? []).join('\n');
  $('#newSessionError').classList.add('hidden');
  openModal('newSessionModal');
  form.elements.name.focus();
}

async function syncProviderFields(form, defaults = {}) {
  const provider = currentProviderId(form);
  await loadModels(provider);
  fillModelSelect(form.elements.model, provider, defaults.model ?? '');
  fillPermissionSelect(form.elements.permissionMode, provider, defaults.permissionMode ?? '');
  const hint = form.querySelector('[data-hint="provider"]');
  if (hint) hint.textContent = providerHint(provider);
  updatePermissionHint(form);
}

function updatePermissionHint(form) {
  const target = form ?? $('#newSessionForm');
  const provider = currentProviderId(target);
  const meta = providerMeta(provider);
  const entry = meta?.permissionModes?.find((mode) => mode.value === target.elements.permissionMode.value);
  const hint = target.querySelector('[data-hint="permission"]');
  if (!hint) return;
  hint.textContent = entry?.risky
    ? '⚠ 局域网里拿到口令的人可以在这个目录里读写文件、执行命令。'
    : meta?.supportsPermissionPrompts
      ? '需要授权的操作会在对话里弹出确认卡片。'
      : '由沙箱策略限制可写范围。';
  hint.classList.toggle('warn', Boolean(entry?.risky));
}

async function openSettings() {
  const form = $('#settingsForm');
  const defaults = state.config?.sessionDefaults ?? {};
  fillProviderSelect(form.elements.provider, defaults.provider);
  await Promise.all([syncProviderFields(form, defaults), loadServerInfo()]);
  form.elements.cwd.value = defaults.cwd ?? '';
  form.elements.token.value = '';
  form.elements.maxSessions.value = state.config?.maxSessions ?? 8;
  form.elements.qodercliPath.value = state.config?.qodercliPath ?? 'qodercli';
  form.elements.codexPath.value = state.config?.codexPath ?? 'codex';
  form.elements.sharedWorkspace.value = state.config?.workspace?.workspace ?? '';
  renderSettingsInfo();
  $('#settingsError').classList.add('hidden');
  $('#settingsOk').classList.add('hidden');
  openModal('settingsModal');
}

function renderSettingsInfo() {
  const box = $('#serverInfo');
  const info = state.server;
  box.replaceChildren();
  if (!info) return;
  const rows = [
    ['监听', `${info.listen?.host}:${info.listen?.port}${info.authEnabled ? '' : '（无口令）'}`],
    ['局域网', (info.lanUrls ?? []).join('  ') || '未检测到'],
  ];
  for (const provider of info.providers ?? []) {
    const binary = provider.binary ?? {};
    rows.push([provider.id, binary.ok
      ? `${binary.path} ${binary.version ?? ''}`.trim()
      : `${binary.path ?? '?'} — ${binary.error || '不可用'}`]);
  }
  const workspace = info.workspace ?? {};
  rows.push(['工作区', workspace.ok ? `${workspace.workspace}（临时文件 ${workspace.tmp}）` : `${workspace.workspace} — ${workspace.error}`]);
  rows.push(['运行环境', `${info.platform} · node ${info.node}`]);
  rows.push(['已运行', `${Math.floor((info.uptimeSec ?? 0) / 60)} 分钟`]);
  for (const [key, value] of rows) {
    box.append(el('div', { class: 'kv' }, [
      el('b', { text: key }),
      key === '局域网' ? el('code', { text: value }) : el('span', { text: value }),
    ]));
  }
}

async function openDirPicker(button) {
  const name = button.dataset.browse;
  const form = button.form;
  state.dir.target = { form, name };
  const start = form?.elements?.[name]?.value || state.config?.sessionDefaults?.cwd || '';
  await browseTo(start);
  openModal('dirModal');
}

async function browseTo(target) {
  const errBox = $('#dirError');
  errBox.classList.add('hidden');
  try {
    const data = await api(`/api/fs?path=${encodeURIComponent(target || '~')}`);
    state.dir.path = data.path;
    state.dir.selected = data.path;
    $('#dirCurrent').value = data.path;
    const list = $('#dirList');
    list.replaceChildren();
    if (!data.dirs?.length) {
      list.append(el('li', { class: 'dir-empty', text: '（没有子目录）' }));
    }
    for (const dir of data.dirs ?? []) {
      list.append(el('li', {
        class: dir.hidden ? 'hidden-dir' : '',
        onclick: (event) => {
          $$('#dirList li').forEach((li) => li.classList.remove('selected'));
          event.currentTarget.classList.add('selected');
          state.dir.selected = dir.path;
        },
        ondblclick: () => browseTo(dir.path),
      }, [
        el('span', { class: 'd-icon', text: '📁' }),
        el('span', { text: dir.name }),
      ]));
    }
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
}

async function renderLogs() {
  const body = $('#logsBody');
  if (!state.currentId) {
    body.textContent = '(没有选中的会话)';
    return;
  }
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(state.currentId)}/logs`);
    state.logs.set(state.currentId, data.logs ?? []);
  } catch { /* keep whatever streamed in */ }
  const entries = state.logs.get(state.currentId) ?? [];
  body.textContent = entries.length
    ? entries.map((entry) => `${new Date(entry.ts).toLocaleTimeString()} [${entry.level}] ${entry.text}`).join('\n')
    : '(暂无日志)';
  body.scrollTop = body.scrollHeight;
}

/* ─────────────────────────────── attachments ─────────────────────────────── */

const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const MAX_ATTACH_COUNT = 8;
let attachSeq = 0;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function addFiles(fileList) {
  const incoming = [...(fileList ?? [])].filter(Boolean);
  if (!incoming.length) return;
  for (const file of incoming) {
    if (state.pendingFiles.length >= MAX_ATTACH_COUNT) {
      showNotice(`一次最多 ${MAX_ATTACH_COUNT} 个附件`);
      break;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      showNotice(`${file.name || '粘贴的图片'} 超过 ${MAX_ATTACH_BYTES / 1024 / 1024}MB，已跳过`);
      continue;
    }
    const entry = {
      key: `f${attachSeq++}`,
      file,
      // Clipboard screenshots arrive with an empty name.
      name: file.name || `pasted-${Date.now()}.png`,
      size: file.size,
      mime: file.type || '',
      isImage: (file.type || '').startsWith('image/'),
      preview: null,
    };
    state.pendingFiles.push(entry);
    if (entry.isImage) {
      const reader = new FileReader();
      reader.onload = () => { entry.preview = String(reader.result); renderAttachTray(); };
      reader.readAsDataURL(file);
    }
  }
  renderAttachTray();
  updateChrome();
}

function removePendingFile(key) {
  state.pendingFiles = state.pendingFiles.filter((entry) => entry.key !== key);
  renderAttachTray();
  updateChrome();
}

function renderAttachTray() {
  const tray = $('#attachTray');
  if (!tray) return;
  if (!state.pendingFiles.length) {
    tray.replaceChildren();
    tray.classList.add('hidden');
    return;
  }
  tray.classList.remove('hidden');
  tray.replaceChildren(...state.pendingFiles.map((entry) => el('div', { class: 'attach-chip' }, [
    entry.preview
      ? el('img', { class: 'attach-thumb', src: entry.preview, alt: '' })
      : el('span', { class: 'attach-icon', text: entry.isImage ? '🖼' : '📄' }),
    el('span', { class: 'attach-name', text: entry.name, title: entry.name }),
    el('span', { class: 'attach-size muted', text: fmtSize(entry.size) }),
    el('button', {
      class: 'attach-remove',
      title: '移除',
      text: '×',
      onclick: () => removePendingFile(entry.key),
    }),
  ])));
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(sessionId, entries) {
  const payloads = await Promise.all(entries.map(async (entry) => ({
    name: entry.name,
    mime: entry.mime,
    dataBase64: await readAsBase64(entry.file),
  })));
  state.uploading = true;
  updateChrome();
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, {
      method: 'POST',
      body: { files: payloads },
    });
    return data.files ?? [];
  } finally {
    state.uploading = false;
    updateChrome();
  }
}

function dragCarriesFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}

function bindDragDrop() {
  const hint = $('#dropHint');
  let depth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!dragCarriesFiles(event) || !state.currentId) return;
    depth += 1;
    hint.classList.remove('hidden');
  });
  window.addEventListener('dragover', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hint.classList.add('hidden');
  });
  window.addEventListener('drop', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    hint.classList.add('hidden');
    addFiles(event.dataTransfer?.files);
  });
}

/* ─────────────────────────────── actions ─────────────────────────────── */

async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  const staged = [...state.pendingFiles];
  if ((!text && !staged.length) || state.uploading) return;
  let id = state.currentId;
  try {
    if (!id) {
      const created = await createSession({});
      id = created.id;
    }
    input.value = '';
    autosize(input);
    state.pendingFiles = [];
    renderAttachTray();
    $('#sendBtn').disabled = true;
    const attachments = staged.length ? await uploadFiles(id, staged) : [];
    await api(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: { text, attachments },
    });
  } catch (err) {
    showNotice(`发送失败：${err.message}`);
    input.value = text;
    autosize(input);
    // Put the staged files back so a failed send does not discard them.
    state.pendingFiles = staged;
    renderAttachTray();
  }
  updateChrome();
}

async function createSession(values) {
  const data = await api('/api/sessions', { method: 'POST', body: values });
  await refreshSessions();
  await selectSession(data.session.id);
  return data.session;
}

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

/* ─────────────────────────────── wiring ─────────────────────────────── */

function connectStream() {
  if (state.es) state.es.close();
  const query = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  const es = new EventSource(`/api/stream${query}`);
  state.es = es;

  es.addEventListener('hello', (event) => {
    const data = JSON.parse(event.data);
    state.authEnabled = data.authEnabled;
    state.viewerId = data.viewerId ?? null;
    if (data.sessionDefaults && state.config) state.config.sessionDefaults = data.sessionDefaults;
    if (data.providers?.length) {
      state.providers = data.providers;
      if (state.config) state.config.providers = data.providers;
      mergeProviderHealth();
    }
    if (data.workspace && state.config) state.config.workspace = data.workspace;
    setSessions(data.sessions);
    renderServerBadge();
    reportPresence();
  });
  es.addEventListener('sessions', (event) => setSessions(JSON.parse(event.data).sessions));
  es.addEventListener('agent', (event) => onAgentEvent(JSON.parse(event.data)));
  es.onerror = () => {
    $('#serverBadge').classList.remove('ok');
    $('#serverBadge').classList.add('bad');
  };
  es.onopen = () => renderServerBadge();
}

let uiBound = false;

function bindUi() {
  if (uiBound) return;
  uiBound = true;

  $('#gateForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = $('#gateToken').value.trim();
    if (!token) return;
    if (await verifyToken(token)) {
      state.token = token;
      localStorage.setItem(TOKEN_KEY, token);
      await enterApp();
    } else {
      showGate('口令不正确');
    }
  });

  $('#newSessionBtn').addEventListener('click', openNewSession);
  $('#emptyNewBtn').addEventListener('click', openNewSession);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#sidebarToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#logsBtn').addEventListener('click', async () => { await renderLogs(); openModal('logsModal'); });

  $('#sendBtn').addEventListener('click', sendMessage);
  $('#stopBtn').addEventListener('click', async () => {
    if (!state.currentId) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(state.currentId)}/interrupt`, { method: 'POST' });
    } catch (err) {
      showNotice(`中断失败：${err.message}`);
    }
  });
  $('#resumeBtn').addEventListener('click', async () => {
    if (!state.currentId) return;
    try {
      showNotice('正在恢复 qodercli 进程…');
      await api(`/api/sessions/${encodeURIComponent(state.currentId)}/resume`, { method: 'POST' });
      await refreshSessions();
      const data = await api(`/api/sessions/${encodeURIComponent(state.currentId)}`);
      state.current = { ...data.session, transcript: state.current?.transcript ?? [] };
      showNotice('');
      updateChrome();
    } catch (err) {
      showNotice(`恢复失败：${err.message}`);
    }
  });

  const input = $('#input');
  input.addEventListener('input', () => autosize(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

  // A pasted screenshot arrives as a file item, not text.
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });

  const fileInput = $('#fileInput');
  $('#attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    // Reset so choosing the same file again still fires a change event.
    fileInput.value = '';
  });
  bindDragDrop();

  $('#newSessionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const errBox = $('#newSessionError');
    errBox.classList.add('hidden');
    const payload = {
      name: form.elements.name.value.trim(),
      provider: form.elements.provider.value,
      model: form.elements.model.value,
      cwd: form.elements.cwd.value.trim(),
      permissionMode: form.elements.permissionMode.value,
      agent: form.elements.agent.value.trim(),
      appendSystemPrompt: form.elements.appendSystemPrompt.value,
      addDirs: lines(form.elements.addDirs.value),
      extraArgs: lines(form.elements.extraArgs.value),
    };
    try {
      await createSession(payload);
      closeModal('newSessionModal');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });
  for (const form of [$('#newSessionForm'), $('#settingsForm')]) {
    form.elements.provider.addEventListener('change', () => syncProviderFields(form));
    form.elements.permissionMode.addEventListener('change', () => updatePermissionHint(form));
  }

  $('#settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const errBox = $('#settingsError');
    const okBox = $('#settingsOk');
    errBox.classList.add('hidden');
    okBox.classList.add('hidden');
    try {
      const data = await api('/api/config', {
        method: 'POST',
        body: {
          sessionDefaults: {
            provider: form.elements.provider.value,
            model: form.elements.model.value,
            cwd: form.elements.cwd.value.trim(),
            permissionMode: form.elements.permissionMode.value,
          },
          maxSessions: Number(form.elements.maxSessions.value),
          qodercliPath: form.elements.qodercliPath.value.trim(),
          codexPath: form.elements.codexPath.value.trim(),
          sharedWorkspace: form.elements.sharedWorkspace.value.trim(),
          ...(form.elements.token.value.trim() ? { token: form.elements.token.value.trim() } : {}),
        },
      });
      state.config = { ...state.config, ...data };
      if (form.elements.token.value.trim()) {
        state.token = form.elements.token.value.trim();
        localStorage.setItem(TOKEN_KEY, state.token);
        connectStream();
      }
      okBox.textContent = '已保存到 config.json';
      okBox.classList.remove('hidden');
      renderShareRow();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });

  for (const button of $$('[data-close]')) {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  }
  for (const modal of $$('.modal')) {
    modal.addEventListener('mousedown', (event) => {
      if (event.target === modal) modal.classList.add('hidden');
    });
  }
  for (const button of $$('[data-browse]')) {
    button.addEventListener('click', () => openDirPicker(button));
  }
  $('#dirGo').addEventListener('click', () => browseTo($('#dirCurrent').value.trim()));
  $('#dirCurrent').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); browseTo($('#dirCurrent').value.trim()); }
  });
  $('#dirUp').addEventListener('click', async () => {
    const data = await api(`/api/fs?path=${encodeURIComponent(state.dir.path)}`).catch(() => null);
    if (data?.parent) browseTo(data.parent);
  });
  $('#dirChoose').addEventListener('click', () => {
    const { form, name } = state.dir.target ?? {};
    if (form?.elements?.[name]) form.elements[name].value = state.dir.selected;
    closeModal('dirModal');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') $$('.modal:not(.hidden)').forEach((modal) => modal.classList.add('hidden'));
  });

  // Right-click a session to stop or delete it.
  $('#sessionList').addEventListener('contextmenu', (event) => {
    const item = event.target.closest('.session-item');
    if (!item) return;
    event.preventDefault();
    const index = Number(Array.from(item.parentNode.children).indexOf(item));
    const summary = state.sessions[index];
    if (!summary) return;
    showSessionMenu(summary, event.clientX, event.clientY);
  });
}

function showSessionMenu(summary, x, y) {
  $$('#sessionMenu').forEach((node) => node.remove());
  const actions = [];
  if (summary.alive) {
    actions.push(['⏸ 停止进程', async () => {
      await api(`/api/sessions/${summary.id}/stop`, { method: 'POST' });
      refreshSessions();
    }]);
  } else if (summary.persistent !== false && summary.agentSessionId) {
    actions.push(['▶ 恢复进程', async () => {
      await api(`/api/sessions/${summary.id}/resume`, { method: 'POST' });
      refreshSessions();
    }]);
  }
  actions.push(['🗑 删除会话', async () => {
    if (!window.confirm(`删除会话「${summary.name}」？此操作不可撤销。`)) return;
    await api(`/api/sessions/${summary.id}`, { method: 'DELETE' });
    if (state.currentId === summary.id) {
      state.currentId = null;
      state.current = null;
      clearLive();
      renderTranscript([]);
      showNotice('');
    }
    refreshSessions();
  }]);

  const menu = el('div', {
    id: 'sessionMenu',
    style: `position:fixed;left:${x}px;top:${y}px;z-index:80;background:var(--bg-elev);border:1px solid var(--border);border-radius:9px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5);min-width:150px`,
  });
  for (const [label, handler] of actions) {
    menu.append(el('div', {
      style: 'padding:7px 11px;border-radius:6px;cursor:pointer;font-size:13px',
      text: label,
      onmouseenter: (event) => { event.currentTarget.style.background = 'var(--bg-elev-2)'; },
      onmouseleave: (event) => { event.currentTarget.style.background = 'transparent'; },
      onclick: async () => {
        menu.remove();
        try { await handler(); } catch (err) { showNotice(err.message); }
      },
    }));
  }
  document.body.append(menu);
  const dismiss = (event) => {
    if (!menu.contains(event.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

/* ──────────────────────────────── boot ──────────────────────────────── */

async function enterApp() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');

  state.config = await api('/api/config');
  state.providers = state.config.providers ?? [];
  bindUi();
  await Promise.all([
    loadModels(state.config.sessionDefaults?.provider),
    loadServerInfo(),
    refreshSessions(),
  ]);

  const wanted = location.hash.slice(1);
  const target = (wanted && state.sessions.find((s) => s.id === wanted)) || state.sessions[0];
  if (target) await selectSession(target.id);
  else updateChrome();

  connectStream();
  setInterval(() => { renderSessionList(); }, 30_000);
}

async function boot() {
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    history.replaceState(null, '', location.pathname + location.hash);
  }
  state.token = localStorage.getItem(TOKEN_KEY) ?? '';

  let health;
  try {
    health = await (await fetch('/api/health')).json();
  } catch {
    document.body.replaceChildren(el('div', {
      class: 'gate',
      html: '<div class="gate-card"><h1>无法连接服务</h1><p class="muted">请确认 agent-session-proxy 仍在运行。</p></div>',
    }));
    return;
  }

  state.authEnabled = health.authEnabled;
  if (health.sharing === false) return showPaused();
  if (state.authEnabled) {
    const hadStoredToken = Boolean(state.token);
    if (!state.token || !(await verifyToken(state.token))) {
      state.token = '';
      localStorage.removeItem(TOKEN_KEY);
      showGate(hadStoredToken ? '保存的口令已失效，请重新输入' : '');
      return;
    }
  }
  await enterApp();
}

boot();
