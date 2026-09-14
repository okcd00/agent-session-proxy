/**
 * Host-only control console. Deliberately talks to /api/admin/* only: the
 * payloads there carry connection and model metadata, never transcripts, so
 * nothing a guest types can reach this page.
 */
(() => {
  const POLL_MS = 2_000;
  const STORE_KEY = 'asp.adminToken';
  const $ = (sel) => document.querySelector(sel);

  const state = {
    token: '',
    data: null,
    timer: null,
    tokenVisible: false,
    busy: false,
  };

  // ------------------------------------------------------------------ helpers

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child == null) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function fmtDuration(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分 ${sec % 60} 秒`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时 ${min % 60} 分`;
    return `${Math.floor(hour / 24)} 天 ${hour % 24} 小时`;
  }

  function fmtAgo(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 10_000) return '刚刚';
    return `${fmtDuration(diff)}前`;
  }

  let toastTimer = null;
  function toast(message, kind = 'ok') {
    const box = $('#toast');
    box.textContent = message;
    box.className = `toast toast-${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add('hidden'), 2_600);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        'x-admin-token': state.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const err = new Error(payload?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  // -------------------------------------------------------------------- gate

  function showGate(message = '') {
    stopPolling();
    $('#app').classList.add('hidden');
    $('#gate').classList.remove('hidden');
    const err = $('#gateError');
    err.textContent = message;
    err.classList.toggle('hidden', !message);
    $('#gateToken').focus();
  }

  function showApp() {
    $('#gate').classList.add('hidden');
    $('#app').classList.remove('hidden');
  }

  // ------------------------------------------------------------------ render

  function renderStats(data) {
    $('#statViewers').textContent = String(data.stats.viewers);
    $('#statDevices').textContent = String(data.stats.devices);
    $('#statSessions').textContent = `${data.sessions.length} / ${data.maxSessions}`;
    $('#statUptime').textContent = fmtDuration(data.uptimeSec * 1000);
    $('#hostLine').textContent = `${data.hostname} · v${data.version} · Node ${data.node}`;
  }

  function renderSwitch(data) {
    const btn = $('#shareToggle');
    btn.disabled = state.busy;
    $('#shareState').textContent = data.sharing ? '开启中' : '已暂停';
    $('#shareState').className = `switch-state ${data.sharing ? 'on' : 'off'}`;
    $('#shareHint').textContent = data.sharing
      ? '局域网里拿到口令的小伙伴现在可以进来聊。'
      : '小伙伴访问会收到「已暂停」提示；会话和历史都还在。';
    btn.textContent = data.sharing ? '暂停共享' : '恢复共享';
    btn.className = `btn btn-lg ${data.sharing ? 'btn-danger' : 'btn-primary'}`;
  }

  function renderShare(data) {
    const first = data.lanUrls[0] || `http://127.0.0.1:${data.listen.port}`;
    $('#shareUrl').value = data.shareUrl;
    $('#plainUrl').value = `${first}/`;
    const tokenBox = $('#shareToken');
    tokenBox.value = data.authEnabled ? data.token : '（已用 --no-auth 关闭口令）';
    tokenBox.type = state.tokenVisible || !data.authEnabled ? 'text' : 'password';
    $('#tokenReveal').textContent = state.tokenVisible ? '隐藏' : '显示';
    $('#tokenReveal').disabled = !data.authEnabled;
    $('#listenLine').textContent = `${data.listen.host}:${data.listen.port}`
      + (data.listen.host === '0.0.0.0' ? '   （0.0.0.0 = 局域网可达）' : '   （只绑了这一个地址）');
    const lan = data.lanUrls.slice(1);
    $('#lanList').textContent = lan.length ? lan.join('   ') : '只有一个网卡地址';
  }

  function renderViewers(data) {
    const body = $('#viewerRows');
    body.replaceChildren();
    const guests = data.viewers.filter((v) => !v.admin);
    $('#viewerEmpty').classList.toggle('hidden', guests.length > 0);
    for (const viewer of guests) {
      const backend = [viewer.provider, viewer.model || '（CLI 默认模型）'].filter(Boolean).join(' · ');
      body.append(el('tr', {}, [
        el('td', { text: viewer.device }),
        el('td', { class: 'mono small', text: viewer.ip || '—' }),
        el('td', { text: viewer.sessionName || (viewer.sessionId ? '（未命名会话）' : '还在会话列表页') }),
        el('td', { class: 'small', text: viewer.sessionId ? backend : '—' }),
        el('td', { class: 'small muted', text: fmtDuration(Date.now() - viewer.connectedAt) }),
        el('td', {}, [
          el('button', {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            title: '断开这个连接（对方刷新还能再进来）',
            onclick: () => kick(viewer.id),
          }, '断开'),
        ]),
      ]));
    }
  }

  const STATUS_TEXT = {
    starting: '启动中', idle: '空闲', busy: '思考中', closed: '已停止', error: '出错',
  };

  function renderSessions(data) {
    const body = $('#sessionRows');
    body.replaceChildren();
    $('#sessionEmpty').classList.toggle('hidden', data.sessions.length > 0);
    for (const session of data.sessions) {
      const watchers = data.viewers.filter((v) => !v.admin && v.sessionId === session.id).length;
      body.append(el('tr', {}, [
        el('td', {}, [
          el('span', { text: session.name || '（未命名）' }),
          watchers ? el('span', { class: 'pill', text: `${watchers} 人在看` }) : null,
        ]),
        el('td', { class: 'small', text: `${session.providerLabel} · ${session.model || '（CLI 默认）'}` }),
        el('td', {}, [
          el('span', {
            class: `dot dot-${session.status}`,
          }),
          el('span', { class: 'small', text: STATUS_TEXT[session.status] ?? session.status }),
        ]),
        el('td', { class: 'small', text: String(session.turnCount) }),
        el('td', { class: 'mono small muted', text: session.cwd || '—' }),
        el('td', { class: 'small muted', text: fmtAgo(session.lastActiveAt) }),
      ]));
    }
  }

  function renderMachine(data) {
    const box = $('#providerLines');
    box.replaceChildren();
    for (const provider of data.providers) {
      const ok = provider.binary?.ok;
      box.append(el('div', { class: 'provider-line' }, [
        el('span', { class: `dot ${ok ? 'dot-idle' : 'dot-error'}` }),
        el('span', { text: `${provider.label}: ` }),
        el('span', {
          class: 'small muted mono',
          text: ok ? `${provider.binary.version || 'ok'} — ${provider.binary.path}` : (provider.binary?.error || '未安装'),
        }),
      ]));
    }
    const ws = data.workspace ?? {};
    $('#workspaceLine').textContent = ws.workspace
      ? `${ws.workspace}${ws.ok ? '' : `   （不可用：${ws.error}）`}`
      : '—';
    $('#platformLine').textContent = data.platform;
  }

  function render(data) {
    state.data = data;
    renderStats(data);
    renderSwitch(data);
    renderShare(data);
    renderViewers(data);
    renderSessions(data);
    renderMachine(data);
  }

  // ------------------------------------------------------------------ actions

  async function refresh() {
    try {
      const data = await api('/api/admin/state');
      render(data);
      $('#pollState').textContent = `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      $('#pollState').className = 'small muted';
    } catch (err) {
      if (err.status === 401) {
        localStorage.removeItem(STORE_KEY);
        state.token = '';
        showGate('管理口令不对，或者服务重启后换了口令。');
        return;
      }
      $('#pollState').textContent = `连不上服务：${err.message}`;
      $('#pollState').className = 'small error-text';
    }
  }

  function startPolling() {
    stopPolling();
    refresh();
    state.timer = setInterval(refresh, POLL_MS);
  }

  function stopPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function toggleSharing() {
    if (!state.data || state.busy) return;
    const next = !state.data.sharing;
    if (!next && state.data.stats.viewers > 0) {
      const ok = confirm(`现在有 ${state.data.stats.viewers} 位小伙伴连着，暂停会把他们踢下线（会话内容都保留）。继续？`);
      if (!ok) return;
    }
    state.busy = true;
    renderSwitch(state.data);
    try {
      const result = await api('/api/admin/sharing', { method: 'POST', body: { enabled: next } });
      toast(result.sharing
        ? '共享已恢复，小伙伴可以进来了。'
        : `共享已暂停${result.disconnected ? `，断开了 ${result.disconnected} 个连接` : ''}。`);
    } catch (err) {
      toast(`切换失败：${err.message}`, 'error');
    } finally {
      state.busy = false;
      refresh();
    }
  }

  async function kick(viewerId) {
    try {
      await api('/api/admin/kick', { method: 'POST', body: { viewerId } });
      toast('已断开该连接。');
    } catch (err) {
      toast(`断开失败：${err.message}`, 'error');
    }
    refresh();
  }

  async function shutdown() {
    const viewers = state.data?.stats.viewers ?? 0;
    const warn = '这会结束服务进程，本页面也会失效。\n'
      + '要重新开启，需要回到那台机器的终端运行 ./start.sh。\n\n'
      + (viewers ? `当前还有 ${viewers} 位小伙伴在线。\n\n` : '')
      + '确定要关闭吗？';
    if (!confirm(warn)) return;
    try {
      await api('/api/admin/shutdown', { method: 'POST' });
    } catch {
      // The socket usually dies with the process; that is the expected outcome.
    }
    stopPolling();
    $('#shutdownHint').textContent = '关闭指令已发出。';
    $('#pollState').textContent = '服务已停止';
    $('#pollState').className = 'small error-text';
    $('#shareToggle').disabled = true;
    $('#shutdownBtn').disabled = true;
  }

  // -------------------------------------------------------------------- boot

  function bind() {
    $('#gateForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = $('#gateToken').value.trim();
      if (!token) return;
      state.token = token;
      try {
        await api('/api/admin/state');
      } catch (err) {
        state.token = '';
        showGate(err.status === 401 ? '管理口令不对。' : `连不上服务：${err.message}`);
        return;
      }
      localStorage.setItem(STORE_KEY, token);
      $('#gateToken').value = '';
      showApp();
      startPolling();
    });

    $('#shareToggle').addEventListener('click', toggleSharing);
    $('#shutdownBtn').addEventListener('click', shutdown);

    $('#tokenReveal').addEventListener('click', () => {
      state.tokenVisible = !state.tokenVisible;
      if (state.data) renderShare(state.data);
    });

    $('#logoutBtn').addEventListener('click', () => {
      localStorage.removeItem(STORE_KEY);
      state.token = '';
      state.data = null;
      showGate('已退出控制台。');
    });

    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', async () => {
        const input = document.getElementById(button.dataset.copy);
        const wasHidden = input.type === 'password';
        if (wasHidden) input.type = 'text';
        try {
          await navigator.clipboard.writeText(input.value);
          toast('已复制。');
        } catch {
          // Clipboard needs a secure context; plain http on the LAN is not one.
          input.select();
          toast('浏览器不给复制，已选中，请手动 Ctrl/⌘+C。', 'warn');
        }
        if (wasHidden) input.type = 'password';
      });
    }

    // Pausing the poll while hidden keeps a forgotten tab from hammering the CLI
    // health checks all day.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling();
      else if (state.token && !$('#app').classList.contains('hidden')) startPolling();
    });
  }

  async function boot() {
    bind();
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('admin');
    if (fromUrl) {
      // Keep the secret out of the address bar, history and screenshots.
      url.searchParams.delete('admin');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    const token = fromUrl || localStorage.getItem(STORE_KEY) || '';
    if (!token) return showGate();
    state.token = token;
    try {
      const data = await api('/api/admin/state');
      localStorage.setItem(STORE_KEY, token);
      showApp();
      render(data);
      startPolling();
    } catch (err) {
      state.token = '';
      showGate(err.status === 401 ? '管理口令不对，或者服务重启后换了口令。' : `连不上服务：${err.message}`);
    }
    return undefined;
  }

  boot();
})();
