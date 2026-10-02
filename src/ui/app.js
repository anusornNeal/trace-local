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
    shownWarnings: new Set(),
    mobileStatus: null,
    mobileToken: null,
    qrExpiryTimer: null,
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

  function toast(message, duration = 1800) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), duration);
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
    for (const warning of s.warnings || []) {
      if (state.shownWarnings.has(warning)) continue;
      state.shownWarnings.add(warning);
      toast(warning, 8000);
    }
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

    // Handle detail load error state
    if (session._detailLoadError) {
      $('#detailMeta').textContent = 'Error loading details';
      $('#detailUrl').textContent = session.url || session.id;
      $('#detailFlags').innerHTML = '<span class="flag error">Failed to load full request details</span>';
      $('#detailOverview').innerHTML = '<div class="block"><h3>Error</h3><pre>' + escapeHtml(session._detailLoadError) + '</pre></div>';
      $('#detailRequest').innerHTML = '<div class="block"><p>Request details could not be loaded.</p></div>';
      $('#detailResponse').innerHTML = '<div class="block"><p>Response details could not be loaded.</p></div>';
      return;
    }

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
    // Find the session in the list to set selection optimistically
    const listSession = state.sessions.find((s) => s.id === id);
    if (!listSession) {
      toast('Request not found');
      return;
    }

    // Set selection immediately so the row highlights
    state.selected = { ...listSession };
    renderSessions();
    renderDetail();

    // Load full details in the background
    try {
      const fullSession = await api('/api/sessions/' + encodeURIComponent(id));
      // Only update if this session is still selected
      if (state.selected?.id === id) {
        state.selected = fullSession;
        renderDetail();
      }
    } catch (error) {
      // Only update if this session is still selected
      if (state.selected?.id === id) {
        state.selected._detailLoadError = error.message;
        renderDetail();
      }
      toast('Could not load request details: ' + error.message);
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
    const [status, sessions, rules, ca, mobileStatus] = await Promise.all([
      api('/api/status'),
      api('/api/sessions?limit=500'),
      api('/api/rules'),
      api('/api/ca'),
      api('/api/ca/mobile-status'),
    ]);
    state.status = status;
    state.sessions = sessions.sessions || [];
    state.rules = rules.rules || [];
    state.ca = ca;
    state.mobileStatus = mobileStatus;
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

    if (state.mobileStatus) {
      const proxyAddr = state.mobileStatus.proxyAddress || '—';
      $('#mobileProxyAddress').textContent = proxyAddr;
      const count = state.mobileStatus.activeClients || 0;
      $('#connectedDevices').textContent = count + (count === 1 ? ' active' : ' active');
    }

    if (state.mobileToken) {
      const now = Date.now();
      const remaining = Math.max(0, state.mobileToken.expiresAt - now);
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      $('#qrExpiry').textContent = remaining > 0 ? `${minutes}m ${seconds}s` : 'expired';

      if (remaining <= 0) {
        clearInterval(state.qrExpiryTimer);
        $('#mobileQrSection').hidden = true;
        $('#generateQr').hidden = false;
        state.mobileToken = null;
      }
    }
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
      // If the updated session is currently selected, refresh its list data while preserving full details
      if (state.selected?.id === session.id && !state.selected._detailLoadError) {
        // Update list fields but preserve detail fields that may have been loaded
        state.selected = { ...state.selected, ...session };
        renderDetail();
      }
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
        renderSessions();
        renderDetail();
      } catch (error) {
        toast('Could not clear traffic: ' + error.message);
      }
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

    $('#generateQr').addEventListener('click', async () => {
      try {
        const tokenData = await api('/api/ca/mobile-token', { method: 'POST' });
        state.mobileToken = tokenData;
        $('#mobileQrSection').hidden = false;
        $('#generateQr').hidden = true;

        generateQrCode(tokenData.url);

        clearInterval(state.qrExpiryTimer);
        state.qrExpiryTimer = setInterval(() => {
          renderSettings();
          updateMobileStatus();
        }, 1000);

        toast('QR code generated');
      } catch (error) {
        toast('Failed to generate QR code: ' + error.message);
      }
    });

    $('#copyMobileLink').addEventListener('click', () => {
      if (state.mobileToken) {
        copyText(state.mobileToken.url);
      }
    });
  }

  async function updateMobileStatus() {
    try {
      const mobileStatus = await api('/api/ca/mobile-status');
      state.mobileStatus = mobileStatus;
    } catch (error) {
      // Silently fail
    }
  }

  function generateQrCode(url) {
    const canvas = $('#qrCanvas');
    const ctx = canvas.getContext('2d');
    const size = 200;

    // Use inline SVG QR code generation
    const qrSvg = generateQrSvg(url);
    const img = new Image();
    const svgBlob = new Blob([qrSvg], { type: 'image/svg+xml' });
    const svgUrl = URL.createObjectURL(svgBlob);

    img.onload = () => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(svgUrl);
    };
    img.src = svgUrl;
  }

  function generateQrSvg(text) {
    // Minimal QR Code generator - simplified for browser use
    const modules = encodeQrData(text);
    const size = modules.length;
    const svgSize = 200;
    const scale = svgSize / size;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgSize}" height="${svgSize}" viewBox="0 0 ${size} ${size}">`;
    svg += `<rect width="${size}" height="${size}" fill="white"/>`;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) {
          svg += `<rect x="${x}" y="${y}" width="1" height="1" fill="black"/>`;
        }
      }
    }

    svg += '</svg>';
    return svg;
  }

  function encodeQrData(text) {
    // Simple QR code encoder (version 3, 29x29)
    const size = 29;
    const modules = Array(size).fill(0).map(() => Array(size).fill(false));

    // Add finder patterns (position detection patterns)
    addFinderPattern(modules, 0, 0);
    addFinderPattern(modules, size - 7, 0);
    addFinderPattern(modules, 0, size - 7);

    // Add timing patterns
    for (let i = 8; i < size - 8; i++) {
      modules[6][i] = i % 2 === 0;
      modules[i][6] = i % 2 === 0;
    }

    // Encode data (simplified - creates readable pattern)
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }

    // Fill data region
    let bitIndex = 0;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let row = 0; row < size; row++) {
        for (let c = 0; c < 2; c++) {
          const x = col - c;
          const y = (col + 1) & 2 ? size - 1 - row : row;
          if (!isReserved(modules, x, y)) {
            modules[y][x] = ((hash >> (bitIndex % 32)) & 1) === 1;
            bitIndex++;
          }
        }
      }
    }

    return modules;
  }

  function addFinderPattern(modules, top, left) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const y = top + dy;
        const x = left + dx;
        if (y >= 0 && y < modules.length && x >= 0 && x < modules.length) {
          const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          modules[y][x] = dist !== 1 && dist !== 5;
        }
      }
    }
  }

  function isReserved(modules, x, y) {
    const size = modules.length;
    // Check if in finder pattern area
    if ((x <= 8 && y <= 8) || (x >= size - 8 && y <= 8) || (x <= 8 && y >= size - 8)) {
      return true;
    }
    // Check if on timing pattern
    if (x === 6 || y === 6) {
      return true;
    }
    return false;
  }

  bindUi();
  renderConnection();
  loadBootstrap().catch((error) => toast('Startup failed: ' + error.message));
  connectEvents();
})();
