(() => {
  'use strict';

  const state = {
    status: null,
    ca: null,
    sessions: [],
    selected: null,
    rules: [],
    sse: null,
    connected: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...(options.headers || {}) } : options.headers,
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        const payload = await response.json();
        message = payload.message || payload.error || message;
      } catch {}
      throw new Error(message || ('HTTP ' + response.status));
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 1800);
  }

  function formatBytes(value) {
    const n = Number(value || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatDuration(value) {
    if (value == null) return '—';
    if (value < 1000) return Math.round(value) + ' ms';
    return (value / 1000).toFixed(2) + ' s';
  }

  function statusClass(session) {
    if (session.error) return 'error';
    if (!session.statusCode) return '';
    return 's' + String(session.statusCode)[0];
  }

  function renderStatus() {
    const s = state.status;
    if (!s) return;
    const proxy = s.proxy?.proxyUrl || 'Proxy unavailable';
    $('#proxySummary').textContent = proxy;
    $('#proxyUrl').textContent = proxy;
    $('#proxyStatus').textContent = s.proxy?.running ? 'Running' : 'Stopped';
    $('#sessionCount').textContent = s.sessions + (s.sessions === 1 ? ' request' : ' requests');
    $('#runtimeVersion').textContent = s.version || '—';
    $('#controlUrl').textContent = location.origin;
    $('#trafficCount').textContent = String(state.sessions.length);
    $('#ruleCount').textContent = String(state.rules.length);
  }

  function renderConnection() {
    const pill = $('#liveState');
    pill.classList.toggle('live', state.connected);
    pill.classList.toggle('muted', !state.connected);
    pill.innerHTML = '<span class="dot"></span>' + (state.connected ? 'Live' : 'Reconnecting');
    $('#sseStatus').textContent = state.connected ? 'Connected' : 'Reconnecting';
  }

  function sessionMatches(session) {
    const q = $('#trafficSearch').value.trim().toLowerCase();
    const method = $('#methodFilter').value;
    const status = $('#statusFilter').value;
    if (q && !(session.url + ' ' + session.host + ' ' + session.path).toLowerCase().includes(q)) return false;
    if (method && session.method !== method) return false;
    if (status === 'mapped' && !session.mapped) return false;
    if (status === 'error' && !session.error) return false;
    if (/^[2-5]$/.test(status) && String(session.statusCode || '')[0] !== status) return false;
    return true;
  }

  function renderSessions() {
    const list = $('#sessionList');
    const sessions = state.sessions.filter(sessionMatches);
    $('#trafficCount').textContent = String(state.sessions.length);
    $('#trafficEmpty').classList.toggle('visible', sessions.length === 0);
    list.innerHTML = sessions.map((session) => {
      const total = Number(session.requestBodyBytes || 0) + Number(session.responseBodyBytes || 0);
      return '<button class="session-row session-grid ' + (state.selected?.id === session.id ? 'selected' : '') + '" data-session="' + escapeHtml(session.id) + '" role="listitem">' +
        '<span class="method">' + escapeHtml(session.method) + '</span>' +
        '<span class="status-code ' + statusClass(session) + '">' + escapeHtml(session.error ? 'ERR' : (session.statusCode ?? '…')) + '</span>' +
        '<span class="host-path"><strong>' + escapeHtml(session.host) + (session.mapped ? '<span class="mapped-badge">MAPPED</span>' : '') + '</strong><span>' + escapeHtml(session.path) + '</span></span>' +
        '<span class="cell-muted">' + escapeHtml(formatDuration(session.durationMs)) + '</span>' +
        '<span class="cell-muted">' + escapeHtml(formatBytes(total)) + '</span>' +
      '</button>';
    }).join('');
    list.querySelectorAll('[data-session]').forEach((row) => {
      row.addEventListener('click', () => selectSession(row.dataset.session));
    });
  }

  function headersText(headers) {
    if (!headers) return 'No headers';
    return Object.entries(headers).map(([key, value]) => key + ': ' + (Array.isArray(value) ? value.join(', ') : value ?? '')).join('\n') || 'No headers';
  }

  function bodyText(body, encoding) {
    if (body == null || body === '') return 'No body captured';
    if (encoding === 'binary') return '[base64 binary preview]\n' + body;
    return body;
  }

  function renderDetail() {
    const session = state.selected;
    $('#detailEmpty').hidden = Boolean(session);
    $('#detailContent').hidden = !session;
    if (!session) return;

    $('#detailMeta').textContent = [session.method, session.statusCode || 'No response', formatDuration(session.durationMs)].join(' · ');
    $('#detailUrl').textContent = session.url;
    const flags = [];
    if (session.mapped) flags.push('<span class="flag mapped">Map Local · ' + escapeHtml(session.mapRuleId || 'rule') + '</span>');
    if (session.error) flags.push('<span class="flag error">' + escapeHtml(session.error) + '</span>');
    flags.push('<span class="flag">' + escapeHtml(session.protocol.toUpperCase()) + ' · HTTP/' + escapeHtml(session.httpVersion) + '</span>');
    $('#detailFlags').innerHTML = flags.join('');

    const overview = [
      ['Started', new Date(session.startedAt).toLocaleString()],
      ['Duration', formatDuration(session.durationMs)],
      ['Host', session.host],
      ['Path', session.path],
      ['Request body', formatBytes(session.requestBodyBytes)],
      ['Response body', formatBytes(session.responseBodyBytes)],
    ];
    $('#detailOverview').innerHTML =
      '<dl class="kv-grid">' + overview.map(([k,v]) => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(v) + '</dd>').join('') + '</dl>' +
      (session.error ? '<div class="block"><h3>Error</h3><pre>' + escapeHtml(session.error) + '</pre></div>' : '');

    $('#detailRequest').innerHTML =
      '<div class="block"><h3>Headers</h3><pre>' + escapeHtml(headersText(session.requestHeaders)) + '</pre></div>' +
      '<div class="block"><h3>Body · ' + escapeHtml(formatBytes(session.requestBodyBytes)) + '</h3><pre>' + escapeHtml(bodyText(session.requestBody, session.requestBodyEncoding)) + '</pre></div>';

    $('#detailResponse').innerHTML =
      '<div class="block"><h3>Headers</h3><pre>' + escapeHtml(headersText(session.responseHeaders)) + '</pre></div>' +
      '<div class="block"><h3>Body · ' + escapeHtml(formatBytes(session.responseBodyBytes)) + '</h3><pre>' + escapeHtml(bodyText(session.responseBody, session.responseBodyEncoding)) + '</pre></div>';
  }

  async function selectSession(id) {
    try {
      state.selected = await api('/api/sessions/' + encodeURIComponent(id));
      renderSessions();
      renderDetail();
    } catch (error) {
      toast('Could not load request: ' + error.message);
    }
  }

  function curlFor(session) {
    const parts = ['curl', '-X', session.method];
    for (const [key, raw] of Object.entries(session.requestHeaders || {})) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (value == null || key.toLowerCase() === 'content-length') continue;
        parts.push('-H', quoteShell(key + ': ' + value));
      }
    }
    if (session.requestBody && session.requestBodyEncoding !== 'binary') parts.push('--data-raw', quoteShell(session.requestBody));
    parts.push(quoteShell(session.url));
    return parts.join(' ');
  }

  function quoteShell(value) {
    return "'" + String(value).replaceAll("'", "'\\''") + "'";
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      toast('Copied');
    }
  }

  function renderRules() {
    $('#ruleCount').textContent = String(state.rules.length);
    $('#rulesEmpty').classList.toggle('visible', state.rules.length === 0);
    $('#ruleList').innerHTML = state.rules.map((rule) =>
      '<div class="rule-row" data-rule="' + escapeHtml(rule.id) + '">' +
        '<button class="switch ' + (rule.enabled ? 'on' : '') + '" data-toggle aria-label="' + (rule.enabled ? 'Disable' : 'Enable') + ' rule"></button>' +
        '<span class="method">' + escapeHtml(rule.method) + '</span>' +
        '<span class="rule-main"><strong>' + escapeHtml(rule.target.toUpperCase() + ' · ' + rule.pattern) + '</strong><span>' + escapeHtml(rule.contentType || 'Auto content type') + '</span></span>' +
        '<span class="rule-main"><strong>' + escapeHtml(rule.filePath.split(/[\\/]/).pop()) + '</strong><span title="' + escapeHtml(rule.filePath) + '">' + escapeHtml(rule.filePath) + '</span></span>' +
        '<span class="status-code s' + String(rule.statusCode)[0] + '">' + rule.statusCode + '</span>' +
        '<button class="icon-button" data-delete aria-label="Delete rule">Delete</button>' +
      '</div>'
    ).join('');

    $$('#ruleList [data-rule]').forEach((row) => {
      row.querySelector('[data-toggle]').addEventListener('click', () => toggleRule(row.dataset.rule));
      row.querySelector('[data-delete]').addEventListener('click', () => deleteRule(row.dataset.rule));
    });
  }

  async function toggleRule(id) {
    const rule = state.rules.find((item) => item.id === id);
    if (!rule) return;
    try {
      await api('/api/rules/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) });
    } catch (error) {
      toast('Could not update rule: ' + error.message);
    }
  }

  async function deleteRule(id) {
    try {
      await api('/api/rules/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (error) {
      toast('Could not delete rule: ' + error.message);
    }
  }

  async function loadBootstrap() {
    const [status, sessions, rules, ca] = await Promise.all([
      api('/api/status'),
      api('/api/sessions?limit=500'),
      api('/api/rules'),
      api('/api/ca'),
    ]);
    state.status = status;
    state.sessions = sessions.sessions || [];
    state.rules = rules.rules || [];
    state.ca = ca;
    renderStatus();
    renderSessions();
    renderRules();
    renderSettings();
  }

  function renderSettings() {
    if (!state.ca) return;
    $('#caPath').textContent = state.ca.certPath || '—';
    $('#caFingerprint').textContent = state.ca.fingerprint256 || '—';
    $('#caExpiry').textContent = state.ca.expiresAt ? new Date(state.ca.expiresAt).toLocaleString() : '—';
  }

  function connectEvents() {
    state.sse?.close();
    const source = new EventSource('/api/events');
    state.sse = source;

    source.addEventListener('open', () => {
      state.connected = true;
      renderConnection();
    });
    source.addEventListener('error', () => {
      state.connected = false;
      renderConnection();
    });
    source.addEventListener('status', (event) => {
      state.status = JSON.parse(event.data);
      renderStatus();
    });
    source.addEventListener('session-added', (event) => {
      const payload = JSON.parse(event.data);
      const session = payload.session;
      state.sessions = [session, ...state.sessions.filter((item) => item.id !== session.id)].slice(0, 500);
      if (state.status) state.status.sessions = state.sessions.length;
      renderSessions();
      renderStatus();
    });
    source.addEventListener('sessions-cleared', () => {
      state.sessions = [];
      state.selected = null;
      if (state.status) state.status.sessions = 0;
      renderSessions();
      renderDetail();
      renderStatus();
    });
    source.addEventListener('rules-changed', (event) => {
      const payload = JSON.parse(event.data);
      state.rules = payload.rules || [];
      if (state.status) state.status.rules = state.rules.length;
      renderRules();
      renderStatus();
    });
  }

  function bindUi() {
    $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
      $$('.tab').forEach((item) => item.classList.toggle('active', item === tab));
      $$('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      $('#' + tab.dataset.tab + 'Tab').classList.add('active');
    }));

    $$('.detail-tab').forEach((tab) => tab.addEventListener('click', () => {
      $$('.detail-tab').forEach((item) => item.classList.toggle('active', item === tab));
      $$('.detail-section').forEach((section) => section.classList.remove('active'));
      $('#detail' + tab.dataset.detail[0].toUpperCase() + tab.dataset.detail.slice(1)).classList.add('active');
    }));

    ['#trafficSearch', '#methodFilter', '#statusFilter'].forEach((selector) => {
      $(selector).addEventListener('input', renderSessions);
      $(selector).addEventListener('change', renderSessions);
    });

    $('#clearSessions').addEventListener('click', async () => {
      try {
        await api('/api/sessions', { method: 'DELETE' });
        state.sessions = [];
        state.selected = null;
        renderSessions(); renderDetail();
      } catch (error) { toast('Could not clear traffic: ' + error.message); }
    });

    $('#copyCurl').addEventListener('click', () => state.selected && copyText(curlFor(state.selected)));

    $('#openRuleForm').addEventListener('click', () => {
      $('#ruleForm').hidden = false;
      $('#rulePattern').focus();
    });
    $('#cancelRule').addEventListener('click', () => { $('#ruleForm').hidden = true; $('#ruleForm').reset(); $('#ruleMethod').value = '*'; $('#ruleStatus').value = '200'; });

    $('#browseFile').addEventListener('click', async () => {
      if (!window.traceLocalDesktop?.chooseFile) {
        toast('Native file picker is available in the desktop app');
        return;
      }
      const path = await window.traceLocalDesktop.chooseFile();
      if (path) $('#ruleFile').value = path;
    });

    $('#ruleForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorElement = $('#ruleFormError');
      errorElement.hidden = true;
      try {
        await api('/api/rules', {
          method: 'POST',
          body: JSON.stringify({
            target: $('#ruleTarget').value,
            pattern: $('#rulePattern').value,
            method: $('#ruleMethod').value || '*',
            filePath: $('#ruleFile').value,
            statusCode: Number($('#ruleStatus').value || 200),
            contentType: $('#ruleContentType').value || undefined,
          }),
        });
        $('#ruleForm').reset();
        $('#ruleMethod').value = '*';
        $('#ruleStatus').value = '200';
        $('#ruleForm').hidden = true;
        toast('Rule added');
      } catch (error) {
        errorElement.textContent = error.message;
        errorElement.hidden = false;
      }
    });

    $$('[data-copy]').forEach((button) => button.addEventListener('click', () => {
      const element = $('#' + button.dataset.copy);
      copyText(element.textContent);
    }));
  }

  bindUi();
  renderConnection();
  loadBootstrap().catch((error) => toast('Startup failed: ' + error.message));
  connectEvents();
})();
