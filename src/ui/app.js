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
    collapsedHosts: new Set(),
    domainFilter: '',
    favoriteDomains: new Set(),
    contextSessionId: null,
    editingRuleId: null,
    ruleFileLoadedPath: null,
    pendingBootstrap: null,
    trafficSort: { key: 'startedAt', direction: 'desc' },
    paneWidths: { domains: 190, detail: 390 },
    columnWidths: { method: 58, status: 58, target: 260, duration: 66, request: 68, response: 68 },
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  function readUiPrefs() {
    try {
      if (typeof localStorage === 'undefined') return;
      const saved = JSON.parse(localStorage.getItem('tracelocal.inspector.layout') || '{}');
      state.paneWidths = { ...state.paneWidths, ...(saved.paneWidths || {}) };
      state.columnWidths = { ...state.columnWidths, ...(saved.columnWidths || {}) };
      state.favoriteDomains = new Set(Array.isArray(saved.favoriteDomains) ? saved.favoriteDomains : []);
    } catch {}
  }

  function saveUiPrefs() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem('tracelocal.inspector.layout', JSON.stringify({
        paneWidths: state.paneWidths,
        columnWidths: state.columnWidths,
        favoriteDomains: [...state.favoriteDomains],
      }));
    } catch {}
  }

  function applyInspectorLayout() {
    const layout = $('#trafficLayout');
    if (layout?.style) {
      layout.style.setProperty('--domains-width', state.paneWidths.domains + 'px');
      layout.style.setProperty('--detail-width', state.paneWidths.detail + 'px');
    }
    const root = document.documentElement;
    if (root?.style) {
      for (const [name, width] of Object.entries(state.columnWidths)) {
        root.style.setProperty('--col-' + name, width + 'px');
      }
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      signal: options.signal || AbortSignal.timeout(10_000),
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
    if (value == null) return '\u2014';
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
    const proxy = s.proxy?.lanUrl || s.proxy?.proxyUrl || 'Proxy unavailable';
    const proxyStatus = s.proxy?.running ? 'Proxy Ready' : (s.proxy?.error || 'Proxy Stopped');
    $('#proxySummary').textContent = `${proxy} \u00b7 ${proxyStatus}`;
    const listening = $('#proxyListening');
    listening.classList.toggle('active', Boolean(s.proxy?.running));
    listening.classList.toggle('error', !s.proxy?.running);
    $('#proxyListeningText').textContent = s.proxy?.running
      ? 'TraceLocal | Listening on ' + proxy.replace(/^https?:\/\//, '')
      : 'TraceLocal | ' + proxyStatus;
    $('#proxyUrl').textContent = proxy;
    $('#proxyStatus').textContent = proxyStatus;
    $('#sessionCount').textContent = s.sessions + (s.sessions === 1 ? ' request' : ' requests');
    $('#runtimeVersion').textContent = s.version || '\u2014';
    $('#controlUrl').textContent = location.origin;
    $('#trafficCount').textContent = String(state.sessions.length);
    $('#ruleCount').textContent = String(state.rules.length);
    $('#domainSummary').textContent = 'Domains ' + new Set(state.sessions.map((item) => item.host).filter(Boolean)).size;
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
    if (state.domainFilter && session.host !== state.domainFilter) return false;
    if (q && !(session.url + ' ' + session.host + ' ' + session.path).toLowerCase().includes(q)) return false;
    if (method && session.method !== method) return false;
    if (status === 'mapped' && !session.mapped) return false;
    if (status === 'error' && !session.error) return false;
    if (/^[2-5]$/.test(status) && String(session.statusCode || '')[0] !== status) return false;
    return true;
  }

  function renderDomains() {
    const domainList = $('#domainList');
    const domainCount = $('#domainCount');
    if (!domainList || !domainCount) return;
    const domains = new Map();
    for (const session of state.sessions) {
      if (!session.host) continue;
      domains.set(session.host, (domains.get(session.host) || 0) + 1);
    }
    const activeDomainCount = domains.size;
    for (const host of state.favoriteDomains) {
      if (!domains.has(host)) domains.set(host, 0);
    }
    const entries = [...domains.entries()].sort((a, b) => {
      const af = state.favoriteDomains.has(a[0]) ? 1 : 0;
      const bf = state.favoriteDomains.has(b[0]) ? 1 : 0;
      return bf - af || a[0].localeCompare(b[0]);
    });
    domainCount.textContent = String(activeDomainCount);
    $('#domainSummary').textContent = 'Domains ' + activeDomainCount;
    domainList.innerHTML =
      '<button class="domain-row domain-all ' + (!state.domainFilter ? 'selected' : '') + '" data-domain="">All <span>' + state.sessions.length + '</span></button>' +
      entries.map(([host, count]) => {
        const favorite = state.favoriteDomains.has(host);
        return '<div class="domain-row-shell ' + (state.domainFilter === host ? 'selected ' : '') + (favorite ? 'favorite' : '') + '">' +
          '<button class="domain-select" data-domain="' + escapeHtml(host) + '"><span class="domain-dot"></span><strong>' + escapeHtml(host) + '</strong><span class="domain-count">' + count + '</span></button>' +
          '<button class="domain-favorite ' + (favorite ? 'on' : '') + '" data-favorite-domain="' + escapeHtml(host) + '" title="' + (favorite ? 'Remove favorite' : 'Favorite domain') + '" aria-label="' + (favorite ? 'Remove ' : 'Favorite ') + escapeHtml(host) + '">' + (favorite ? '&#9733;' : '&#9734;') + '</button>' +
        '</div>';
      }).join('');
    domainList.querySelectorAll('[data-domain]').forEach((button) => button.addEventListener('click', () => {
      state.domainFilter = button.dataset.domain || '';
      renderDomains();
      renderSessions();
    }));
    domainList.querySelectorAll('[data-favorite-domain]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      const host = button.dataset.favoriteDomain;
      if (!host) return;
      if (state.favoriteDomains.has(host)) state.favoriteDomains.delete(host);
      else state.favoriteDomains.add(host);
      saveUiPrefs();
      renderDomains();
    }));
  }

  function compareSessions(a, b) {
    const { key, direction } = state.trafficSort;
    const multiplier = direction === 'asc' ? 1 : -1;
    const av = key === 'startedAt' ? new Date(a.startedAt).getTime() : Number(a[key] ?? -1);
    const bv = key === 'startedAt' ? new Date(b.startedAt).getTime() : Number(b[key] ?? -1);
    if (av === bv) return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    return (av - bv) * multiplier;
  }

  function updateSortIndicators() {
    $$('.sortable').forEach((button) => {
      const active = button.dataset.sort === state.trafficSort.key;
      button.classList.toggle('active', active);
      const indicator = button.querySelector('.sort-indicator');
      if (indicator) indicator.textContent = active ? (state.trafficSort.direction === 'asc' ? '\u2191' : '\u2193') : '';
    });
  }

  function renderSessions() {
    const list = $('#sessionList');
    const sessions = state.sessions.filter(sessionMatches);
    $('#trafficCount').textContent = String(state.sessions.length);
    $('#trafficEmpty').classList.toggle('visible', sessions.length === 0);
    renderDomains();

    // Group sessions by host
    const hostGroups = new Map();
    for (const session of sessions) {
      const host = session.host;
      if (!hostGroups.has(host)) {
        hostGroups.set(host, []);
      }
      hostGroups.get(host).push(session);
    }

    // Sort each group newest-first and calculate most recent timestamp
    const hostData = [];
    for (const [host, groupSessions] of hostGroups.entries()) {
      groupSessions.sort(compareSessions);
      const mostRecent = new Date(groupSessions[0].startedAt).getTime();
      hostData.push({ host, sessions: groupSessions, mostRecent });
    }

    // Sort host groups by most recent request
    hostData.sort((a, b) => b.mostRecent - a.mostRecent);

    // Render grouped sessions
    const html = [];
    for (const { host, sessions: groupSessions } of hostData) {
      const isCollapsed = state.collapsedHosts.has(host);
      const count = groupSessions.length;

      // Host header
      html.push(
        '<button class="host-group-header" data-host="' + escapeHtml(host) + '" aria-expanded="' + (!isCollapsed) + '">' +
          '<span class="host-group-toggle">' + (isCollapsed ? '\u25b8' : '\u25be') + '</span>' +
          '<span class="host-group-name">' + escapeHtml(host) + '</span>' +
          '<span class="host-group-count">' + count + '</span>' +
        '</button>'
      );

      // Session rows (only if not collapsed)
      if (!isCollapsed) {
        for (const session of groupSessions) {
          html.push(
            '<button class="session-row session-grid ' + (state.selected?.id === session.id ? 'selected' : '') + '" data-session="' + escapeHtml(session.id) + '" role="listitem">' +
              '<span class="method">' + escapeHtml(session.method) + '</span>' +
              '<span class="status-code ' + statusClass(session) + '">' + escapeHtml(session.error ? 'ERR' : (session.statusCode ?? '\u2026')) + '</span>' +
              '<span class="host-path"><strong>' + (session.mapped ? '<span class="mapped-badge">MAPPED</span>' : '') + '</strong><span>' + escapeHtml(session.path) + '</span></span>' +
              '<span class="cell-muted">' + escapeHtml(formatDuration(session.durationMs)) + '</span>' +
              '<span class="cell-muted">' + escapeHtml(formatBytes(session.requestBodyBytes || 0)) + '</span>' +
              '<span class="cell-muted">' + escapeHtml(formatBytes(session.responseBodyBytes || 0)) + '</span>' +
            '</button>'
          );
        }
      }
    }

    list.innerHTML = html.join('');
    updateSortIndicators();

    // Host headers are rebuilt with the grouped list. Request row interactions use
    // event delegation in bindUi so live rerenders never drop click/contextmenu handlers.
    list.querySelectorAll('[data-host]').forEach((header) => {
      header.addEventListener('click', () => toggleHostGroup(header.dataset.host));
    });
  }

  function closeTrafficContextMenu() {
    const menu = $('#trafficContextMenu');
    menu.hidden = true;
    state.contextSessionId = null;
  }

  function openTrafficContextMenu(sessionId, x, y) {
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    state.contextSessionId = sessionId;
    const menu = $('#trafficContextMenu');
    menu.hidden = false;
    const margin = 8;
    const width = menu.offsetWidth || 150;
    const height = menu.offsetHeight || 40;
    menu.style.left = Math.max(margin, Math.min(x, window.innerWidth - width - margin)) + 'px';
    menu.style.top = Math.max(margin, Math.min(y, window.innerHeight - height - margin)) + 'px';
    $('#contextMapLocal').focus();
  }

  async function openMapLocalFromContext() {
    const sessionId = state.contextSessionId;
    const summary = state.sessions.find((item) => item.id === sessionId);
    if (!summary || !sessionId) {
      closeTrafficContextMenu();
      return;
    }
    const mapTab = $('.tab[data-tab="map"]');
    mapTab?.click();
    resetRuleEditor();
    const form = $('#ruleForm');
    form.reset();
    $('#ruleTarget').value = 'path';
    $('#ruleHost').value = summary.host || '';
    $('#rulePattern').value = summary.path || '/';
    $('#ruleMethod').value = summary.method || '*';
    $('#ruleMatchMode').value = 'exact';
    $('#ruleName').value = (summary.method || '*') + ' ' + (summary.path || '/');
    $('#ruleStatus').value = String(summary.statusCode || 200);
    $('#ruleFile').value = '';
    $('#ruleFileContent').value = '';
    $('#ruleContentType').value = '';
    form.hidden = false;
    closeTrafficContextMenu();
    $('#rulePattern').focus();
    try {
      const session = state.selected?.id === sessionId && state.selected.responseHeaders
        ? state.selected
        : await api('/api/sessions/' + encodeURIComponent(sessionId));
      if (session.responseBodyEncoding === 'binary') {
        toast('Binary response cannot be edited inline yet');
        return;
      }
      let body = session.responseBody ?? '';
      if (isJsonBody(body, session.responseHeaders)) {
        try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
      }
      $('#ruleFileContent').value = body;
      $('#ruleStatus').value = String(session.statusCode || summary.statusCode || 200);
      const rawContentType = session.responseHeaders?.['content-type'] ?? session.responseHeaders?.['Content-Type'] ?? '';
      $('#ruleContentType').value = Array.isArray(rawContentType) ? (rawContentType[0] || '') : String(rawContentType || '');
    } catch (error) {
      toast('Could not load captured response: ' + error.message);
    }
  }

  async function contextSessionFull() {
    const id = state.contextSessionId;
    if (!id) return null;
    if (state.selected?.id === id && state.selected.requestHeaders) return state.selected;
    try {
      return await api('/api/sessions/' + encodeURIComponent(id));
    } catch (error) {
      toast('Could not load request details: ' + error.message);
      return null;
    }
  }

  async function copyContext(kind) {
    const summary = state.sessions.find((item) => item.id === state.contextSessionId);
    if (!summary) return closeTrafficContextMenu();
    if (kind === 'url') {
      await copyText(summary.url);
      return closeTrafficContextMenu();
    }
    const session = await contextSessionFull();
    if (!session) return closeTrafficContextMenu();
    if (kind === 'curl') await copyText(curlFor(session));
    if (kind === 'request') await copyText(requestText(session));
    if (kind === 'response') await copyText(responseText(session));
    closeTrafficContextMenu();
  }

  async function clearContextHost() {
    const session = state.sessions.find((item) => item.id === state.contextSessionId);
    if (!session) return closeTrafficContextMenu();
    const host = session.host;
    try {
      const result = await api('/api/sessions?host=' + encodeURIComponent(host), { method: 'DELETE' });
      state.sessions = state.sessions.filter((item) => item.host !== host);
      if (state.selected?.host === host) state.selected = null;
      if (state.domainFilter === host) state.domainFilter = '';
      renderSessions();
      renderDetail();
      renderStatus();
      toast('Cleared ' + (result?.removed || 0) + ' requests from ' + host);
    } catch (error) {
      toast('Could not clear host traffic: ' + error.message);
    } finally {
      closeTrafficContextMenu();
    }
  }

  function toggleHostGroup(host) {
    if (state.collapsedHosts.has(host)) {
      state.collapsedHosts.delete(host);
    } else {
      state.collapsedHosts.add(host);
    }
    renderSessions();
  }

  function headersText(headers) {
    if (!headers) return 'No headers';
    return Object.entries(headers).map(([key, value]) => key + ': ' + (Array.isArray(value) ? value.join(', ') : value ?? '')).join('\n') || 'No headers';
  }

  function isJsonBody(body, headers) {
    const contentType = String(headers?.['content-type'] ?? headers?.['Content-Type'] ?? '').toLowerCase();
    if (contentType.includes('json')) return true;
    const trimmed = String(body ?? '').trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  }

  function bodyText(body, encoding, headers) {
    if (body == null || body === '') return 'No body captured';
    if (encoding === 'binary') return '[base64 binary preview]\n' + body;
    if (isJsonBody(body, headers)) {
      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Keep the original body when upstream labels malformed/non-JSON text as JSON.
      }
    }
    return body;
  }

  function headersTable(headers) {
    const entries = Object.entries(headers || {});
    if (!entries.length) return '<div class="inspector-empty">No headers</div>';
    return '<div class="headers-table">' + entries.map(([key, value]) =>
      '<div class="header-key">' + escapeHtml(key) + '</div><div class="header-value">' +
      escapeHtml(Array.isArray(value) ? value.join(', ') : (value ?? '')) + '</div>'
    ).join('') + '</div>';
  }

  function jsonPrimitive(value) {
    if (value === null) return '<span class="json-null">null</span>';
    if (typeof value === 'string') return '<span class="json-string">&quot;' + escapeHtml(value) + '&quot;</span>';
    if (typeof value === 'number') return '<span class="json-number">' + escapeHtml(value) + '</span>';
    if (typeof value === 'boolean') return '<span class="json-boolean">' + value + '</span>';
    return escapeHtml(String(value));
  }

  function jsonTree(value, depth = 0) {
    if (value === null || typeof value !== 'object') return jsonPrimitive(value);
    const array = Array.isArray(value);
    const entries = Object.entries(value);
    if (!entries.length) return '<span class="json-punctuation">' + (array ? '[]' : '{}') + '</span>';
    const summary = array ? 'Array(' + entries.length + ')' : 'Object{' + entries.length + '}';
    return '<details class="json-node" open><summary>' + escapeHtml(summary) + '</summary><div class="json-children">' +
      entries.map(([key, child]) =>
        '<div class="json-row"><span class="json-key">' + (array ? escapeHtml(key) : '&quot;' + escapeHtml(key) + '&quot;') +
        '</span><span class="json-colon">:</span><span class="json-value">' + jsonTree(child, depth + 1) + '</span></div>'
      ).join('') + '</div></details>';
  }

  function bodyViewer(body, encoding, headers, side) {
    const text = bodyText(body, encoding, headers);
    const isJson = encoding !== 'binary' && isJsonBody(body, headers);
    let content = '<pre class="body-viewer' + (isJson ? ' json-body' : '') + '">' + escapeHtml(text) + '</pre>';
    if (isJson) {
      try {
        content = '<div class="body-viewer json-tree">' + jsonTree(JSON.parse(body)) + '</div>';
      } catch {}
    }
    return '<div class="block"><div class="block-heading"><h3>Body' + (isJson ? ' \u00b7 JSON' : '') +
      '</h3><button class="copy-button" data-copy-detail="' + side + '-body">Copy body</button></div>' + content + '</div>';
  }

  function requestText(session) {
    return [
      session.method + ' ' + session.url,
      headersText(session.requestHeaders),
      '',
      bodyText(session.requestBody, session.requestBodyEncoding, session.requestHeaders),
    ].join('\n');
  }

  function responseText(session) {
    return [
      'HTTP ' + (session.statusCode ?? 'No response'),
      headersText(session.responseHeaders),
      '',
      bodyText(session.responseBody, session.responseBodyEncoding, session.responseHeaders),
    ].join('\n');
  }

  function renderDetail() {
    const session = state.selected;
    $('#detailPane').classList.toggle('open', Boolean(session));
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

    $('#detailMeta').textContent = [session.method, session.statusCode || 'No response', formatDuration(session.durationMs)].join(' \u00b7 ');
    $('#detailUrl').textContent = session.url;
    const flags = [];
    if (session.mapped) flags.push('<span class="flag mapped">Map Local \u00b7 ' + escapeHtml(session.mapRuleId || 'rule') + '</span>');
    if (session.error) flags.push('<span class="flag error">' + escapeHtml(session.error) + '</span>');
    flags.push('<span class="flag">' + escapeHtml(session.protocol.toUpperCase()) + ' \u00b7 HTTP/' + escapeHtml(session.httpVersion) + '</span>');
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
      '<div class="block"><div class="block-heading"><h3>Headers</h3><button class="copy-button" data-copy-detail="request-headers">Copy headers</button></div>' +
      headersTable(session.requestHeaders) + '</div>' +
      bodyViewer(session.requestBody, session.requestBodyEncoding, session.requestHeaders, 'request');

    $('#detailResponse').innerHTML =
      '<div class="block"><div class="block-heading"><h3>Headers</h3><button class="copy-button" data-copy-detail="response-headers">Copy headers</button></div>' +
      headersTable(session.responseHeaders) + '</div>' +
      bodyViewer(session.responseBody, session.responseBodyEncoding, session.responseHeaders, 'response');
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
    $('#detailContent').scrollTop = 0;

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
    const parts = ['curl', '-X', quoteShell(session.method)];
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

  function ruleResponseSummary(rule) {
    if (rule.responseBody !== undefined) {
      const size = typeof Blob !== 'undefined' ? new Blob([rule.responseBody]).size : String(rule.responseBody).length;
      return { title: 'Inline response', detail: formatBytes(size) + (rule.contentType ? ' | ' + rule.contentType : '') };
    }
    if (rule.filePath) {
      return { title: rule.filePath.split(/[\\/]/).pop() || 'Local file', detail: rule.filePath };
    }
    return { title: 'No response', detail: '' };
  }
  function renderRules() {
    $('#ruleCount').textContent = String(state.rules.length);
    $('#rulesEmpty').classList.toggle('visible', state.rules.length === 0);
    $('#ruleList').innerHTML = state.rules.map((rule) => {
      const response = ruleResponseSummary(rule);
      return '<div class="rule-row ' + (state.editingRuleId === rule.id ? 'selected' : '') + '" data-rule="' + escapeHtml(rule.id) + '" tabindex="0" role="button" aria-label="Edit Map Local rule">' +
        '<button class="switch ' + (rule.enabled ? 'on' : '') + '" data-toggle aria-label="' + (rule.enabled ? 'Disable' : 'Enable') + ' rule"></button>' +
        '<span class="method">' + escapeHtml(rule.method) + '</span>' +
        '<span class="rule-main"><strong>' + escapeHtml(rule.name || (rule.target.toUpperCase() + ' | ' + rule.pattern)) + '</strong><span>' + escapeHtml(rule.pattern + (rule.delayMs ? ' | ' + rule.delayMs + ' ms delay' : '')) + '</span></span>' +
        '<span class="rule-main"><strong>' + escapeHtml(response.title) + '</strong><span>' + escapeHtml(response.detail) + '</span></span>' +
        '<span class="status-code s' + String(rule.statusCode)[0] + '">' + rule.statusCode + '</span>' +
        '<button class="icon-button" data-delete aria-label="Delete rule">Delete</button>' +
      '</div>';
    }).join('');
    $$('#ruleList [data-rule]').forEach((row) => {
      row.querySelector('[data-toggle]').addEventListener('click', (event) => {
        event.stopPropagation();
        toggleRule(row.dataset.rule);
      });
      row.querySelector('[data-delete]').addEventListener('click', (event) => {
        event.stopPropagation();
        deleteRule(row.dataset.rule);
      });
      row.addEventListener('click', () => openRuleEditor(row.dataset.rule));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openRuleEditor(row.dataset.rule);
        }
      });
    });
  }

  async function loadRuleFileContent() {
    const filePath = $('#ruleFile').value.trim();
    if (!filePath) return;
    if (!window.traceLocalDesktop?.readTextFile) {
      $('#ruleFileState').textContent = 'Preview is available in the desktop app';
      return;
    }
    try {
      const content = await window.traceLocalDesktop.readTextFile(filePath);
      $('#ruleFileContent').value = content;
      state.ruleFileLoadedPath = filePath;
      $('#ruleFileState').textContent = 'Loaded ' + filePath.split(/[\\/]/).pop();
    } catch (error) {
      $('#ruleFileState').textContent = 'Could not load file';
      toast('Could not load response file: ' + error.message);
    }
  }

  function resetRuleEditor() {
    state.editingRuleId = null;
    $('#ruleForm').reset();
    $('#ruleEnabled').checked = true;
    $('#ruleMethod').value = '*';
    $('#ruleMatchMode').value = 'wildcard';
    $('#ruleIncludeSubpaths').checked = false;
    $('#ruleDelay').value = '0';
    $('#ruleStatus').value = '200';
    $('#ruleHost').value = '';
    $('#ruleFile').value = '';
    $('#ruleFileContent').value = '';
    state.ruleFileLoadedPath = null;
    $('#ruleFileState').textContent = '';
    $('#ruleFormTitle').textContent = 'New rule';
    $('#ruleIdentity').textContent = '';
    $('#saveRule').textContent = 'Add rule';
    $('#ruleFormError').hidden = true;
    renderRules();
  }

  function openRuleEditor(id) {
    const rule = state.rules.find((item) => item.id === id);
    if (!rule) return;
    state.editingRuleId = id;
    $('#ruleEnabled').checked = rule.enabled;
    $('#ruleName').value = rule.name || '';
    $('#ruleTarget').value = rule.target;
    $('#rulePattern').value = rule.pattern;
    $('#ruleHost').value = rule.host || '';
    $('#ruleMatchMode').value = rule.matchMode || 'wildcard';
    $('#ruleIncludeSubpaths').checked = Boolean(rule.includeSubpaths);
    $('#ruleMethod').value = rule.method;
    $('#ruleStatus').value = String(rule.statusCode);
    $('#ruleDelay').value = String(rule.delayMs || 0);
    $('#ruleFile').value = rule.filePath || '';
    $('#ruleContentType').value = rule.contentType || '';
    state.ruleFileLoadedPath = null;
    if (rule.responseBody !== undefined) {
      $('#ruleFileContent').value = rule.responseBody;
      $('#ruleFileState').textContent = '';
    } else {
      $('#ruleFileContent').value = '';
      $('#ruleFileState').textContent = rule.filePath ? 'Loading legacy response file...' : '';
      if (rule.filePath) void loadRuleFileContent();
    }
    $('#ruleFormTitle').textContent = 'Edit rule';
    $('#ruleIdentity').textContent = rule.id + ' | order ' + rule.order + (rule.updatedAt ? ' | updated ' + new Date(rule.updatedAt).toLocaleString() : '');
    $('#saveRule').textContent = 'Save changes';
    $('#ruleFormError').hidden = true;
    $('#ruleForm').hidden = false;
    renderRules();
    $('#rulePattern').focus();
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
    const pending = { events: [] };
    state.pendingBootstrap = pending;
    try {
      const [status, sessions, rules, ca, mobileStatus] = await Promise.all([
        api('/api/status'),
        api('/api/sessions?limit=500'),
        api('/api/rules'),
        api('/api/ca'),
        api('/api/ca/mobile-status'),
      ]);
      if (state.pendingBootstrap !== pending) return;
      state.status = status;
      state.sessions = sessions.sessions || [];
      state.rules = rules.rules || [];
      state.ca = ca;
      state.mobileStatus = mobileStatus;
      state.pendingBootstrap = null;
      for (const [type, payload] of pending.events) applyEvent(type, payload);
      if (state.selected && !state.sessions.some((session) => session.id === state.selected.id)) state.selected = null;
      state.status.sessions = state.sessions.length;
      state.status.rules = state.rules.length;
      renderStatus();
      renderSessions();
      renderRules();
      renderSettings();
      renderDetail();
    } finally {
      if (state.pendingBootstrap === pending) state.pendingBootstrap = null;
    }
  }

  function renderMobileStatus() {
    if (!state.mobileStatus) return;
    const proxyAddr = state.mobileStatus.proxyAddress || '\u2014';
    $('#mobileProxyAddress').textContent = proxyAddr;
    const count = state.mobileStatus.activeClients || 0;
    $('#connectedDevices').textContent = count + ' active';
    $('#clientSummary').textContent = 'Clients ' + count;
  }

  function renderSettings() {
    renderMobileStatus();
    if (!state.ca) return;
    $('#caPath').textContent = state.ca.certPath || '\u2014';
    $('#caFingerprint').textContent = state.ca.fingerprint256 || '\u2014';
    $('#caExpiry').textContent = state.ca.expiresAt ? new Date(state.ca.expiresAt).toLocaleString() : '\u2014';

    if (state.mobileToken) {
      const remaining = Math.max(0, state.mobileToken.expiresAt - Date.now());
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      $('#qrExpiry').textContent = remaining > 0 ? `${minutes}m ${seconds}s` : 'expired';

      if (remaining <= 0) {
        clearInterval(state.qrExpiryTimer);
        $('#mobileQrSection').hidden = true;
        $('#generateQr').hidden = false;
        $('#mobileQrSvg').innerHTML = '';
        state.mobileToken = null;
      }
    }
  }

  function applyEvent(type, payload) {
    if (type === 'status') {
      state.status = payload;
      renderStatus();
    } else if (type === 'session-added') {
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
      void updateMobileStatus();
    } else if (type === 'sessions-cleared') {
      state.sessions = [];
      state.selected = null;
      if (state.status) state.status.sessions = 0;
      renderSessions();
      renderDetail();
      renderStatus();
    } else if (type === 'sessions-removed') {
      const removedIds = new Set(payload.ids || []);
      state.sessions = state.sessions.filter((session) => !removedIds.has(session.id));
      if (state.selected && removedIds.has(state.selected.id)) state.selected = null;
      if (state.domainFilter && !state.sessions.some((session) => session.host === state.domainFilter)) state.domainFilter = '';
      if (state.status) state.status.sessions = state.sessions.length;
      renderSessions();
      renderDetail();
      renderStatus();
    } else if (type === 'rules-changed') {
      state.rules = payload.rules || [];
      if (state.status) state.status.rules = state.rules.length;
      renderRules();
      renderStatus();
    }
  }

  function connectEvents() {
    state.sse?.close();
    const source = new EventSource('/api/events');
    state.sse = source;

    source.addEventListener('open', () => {
      state.connected = true;
      renderConnection();
      loadBootstrap().catch((error) => toast('Could not refresh inspector: ' + error.message));
    });
    source.addEventListener('error', () => {
      state.connected = false;
      renderConnection();
    });
    for (const type of ['status', 'session-added', 'sessions-cleared', 'sessions-removed', 'rules-changed']) {
      source.addEventListener(type, (event) => {
        const payload = JSON.parse(event.data);
        state.pendingBootstrap?.events.push([type, payload]);
        applyEvent(type, payload);
      });
    }
  }

  function bindInspectorInteractions() {
    $$('.sortable').forEach((button) => button.addEventListener('click', () => {
      const key = button.dataset.sort;
      if (!key) return;
      if (state.trafficSort.key === key) {
        state.trafficSort.direction = state.trafficSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        state.trafficSort = { key, direction: 'desc' };
      }
      renderSessions();
    }));

    $$('.column-resizer').forEach((handle) => handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const column = handle.dataset.column;
      if (!column) return;
      const startX = event.clientX;
      const startWidth = state.columnWidths[column] || 80;
      const minWidth = column === 'target' ? 150 : 48;
      const move = (moveEvent) => {
        state.columnWidths[column] = Math.max(minWidth, startWidth + moveEvent.clientX - startX);
        applyInspectorLayout();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        saveUiPrefs();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }));

    $$('[data-pane-resizer]').forEach((handle) => handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const pane = handle.dataset.paneResizer;
      const startX = event.clientX;
      const startWidth = state.paneWidths[pane];
      const move = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        if (pane === 'domains') state.paneWidths.domains = Math.max(120, Math.min(360, startWidth + delta));
        if (pane === 'detail') state.paneWidths.detail = Math.max(300, Math.min(720, startWidth - delta));
        applyInspectorLayout();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        saveUiPrefs();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }));

    $('#detailPane').addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-copy-detail]');
      if (!button || !state.selected) return;
      const action = button.dataset.copyDetail;
      const session = state.selected;
      const value = action === 'request-headers' ? headersText(session.requestHeaders)
        : action === 'response-headers' ? headersText(session.responseHeaders)
        : action === 'request-body' ? bodyText(session.requestBody, session.requestBodyEncoding, session.requestHeaders)
        : action === 'response-body' ? bodyText(session.responseBody, session.responseBodyEncoding, session.responseHeaders)
        : '';
      if (value) void copyText(value);
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

    const sessionList = $('#sessionList');
    sessionList.addEventListener('click', (event) => {
      const row = event.target.closest?.('[data-session]');
      if (!row || !sessionList.contains(row)) return;
      closeTrafficContextMenu();
      void selectSession(row.dataset.session);
    });
    sessionList.addEventListener('contextmenu', (event) => {
      const row = event.target.closest?.('[data-session]');
      if (!row || !sessionList.contains(row)) return;
      event.preventDefault();
      void selectSession(row.dataset.session);
      openTrafficContextMenu(row.dataset.session, event.clientX, event.clientY);
    });
    $('#contextMapLocal').addEventListener('click', openMapLocalFromContext);
    $('#contextCopyUrl').addEventListener('click', () => void copyContext('url'));
    $('#contextCopyCurl').addEventListener('click', () => void copyContext('curl'));
    $('#contextCopyRequest').addEventListener('click', () => void copyContext('request'));
    $('#contextCopyResponse').addEventListener('click', () => void copyContext('response'));
    $('#contextClearHost').addEventListener('click', () => void clearContextHost());
    document.addEventListener('click', (event) => {
      const menu = $('#trafficContextMenu');
      if (!menu.hidden && !menu.contains(event.target)) closeTrafficContextMenu();
    });
    window.addEventListener('blur', closeTrafficContextMenu);

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
      resetRuleEditor();
      $('#ruleForm').hidden = false;
      $('#rulePattern').focus();
    });
    $('#cancelRule').addEventListener('click', () => {
      resetRuleEditor();
      $('#ruleForm').hidden = true;
    });

    $('#ruleForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorElement = $('#ruleFormError');
      errorElement.hidden = true;
      try {
        const editingId = state.editingRuleId;
        const payload = {
          enabled: $('#ruleEnabled').checked,
          name: $('#ruleName').value || (editingId ? null : undefined),
          target: $('#ruleTarget').value,
          pattern: $('#rulePattern').value,
          host: $('#ruleHost').value || (editingId ? null : undefined),
          matchMode: $('#ruleMatchMode').value,
          includeSubpaths: $('#ruleIncludeSubpaths').checked,
          method: $('#ruleMethod').value || '*',
          filePath: editingId ? null : undefined,
          responseBody: $('#ruleFileContent').value,
          statusCode: Number($('#ruleStatus').value || 200),
          contentType: $('#ruleContentType').value || (editingId ? null : undefined),
          delayMs: Number($('#ruleDelay').value || 0),
        };
        const saved = await api(editingId ? '/api/rules/' + encodeURIComponent(editingId) : '/api/rules', {
          method: editingId ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        });
        if (editingId) {
          state.rules = state.rules.map((rule) => rule.id === editingId ? saved : rule);
        } else if (saved && !state.rules.some((rule) => rule.id === saved.id)) {
          state.rules = [...state.rules, saved].sort((a, b) => a.order - b.order);
        }
        const message = editingId ? 'Rule updated' : 'Rule added';
        resetRuleEditor();
        $('#ruleForm').hidden = true;
        renderRules();
        toast(message);
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
        $('#mobileQrSvg').innerHTML = tokenData.qrSvg || '';
        $('#mobileQrSection').hidden = false;
        $('#generateQr').hidden = true;
        $('#mobileCaLink').textContent = tokenData.url;

        clearInterval(state.qrExpiryTimer);
        state.qrExpiryTimer = setInterval(() => {
          renderSettings();
          updateMobileStatus();
        }, 1000);

        renderSettings();
        toast('CA download QR generated');
      } catch (error) {
        toast('Failed to generate CA QR: ' + error.message);
      }
    });

    $('#copyMobileLink').addEventListener('click', () => {
      if (state.mobileToken) copyText(state.mobileToken.url);
    });
  }

  async function updateMobileStatus() {
    try {
      const mobileStatus = await api('/api/ca/mobile-status');
      state.mobileStatus = mobileStatus;
      renderMobileStatus();
    } catch (error) {
      // Silently fail
    }
  }

  readUiPrefs();
  applyInspectorLayout();
  bindUi();
  bindInspectorInteractions();
  renderConnection();
  loadBootstrap().catch((error) => toast('Startup failed: ' + error.message));
  connectEvents();
  setInterval(() => { void updateMobileStatus(); }, 3000);
})();
