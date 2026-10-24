// The bin page. Everything captured is untrusted: it is rendered with
// textContent through h(), never innerHTML, and the CSP backs that up.

const binId = location.pathname.split('/')[2];
const $ = (id) => document.getElementById(id);

/** createElement with attributes and children; strings become text nodes. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

async function api(path, init) {
  const res = await fetch(`/api/bins/${binId}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

function toast(text) {
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 1600);
}

async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Could not copy');
  }
}

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

// ------------------------------------------------------------------ format

function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function left(ms) {
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `expires in ${Math.floor(m / 60)}h ${m % 60}m` : `expires in ${m}m`;
}

/** Single-quoted for a POSIX shell. */
const sq = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const SKIP_IN_CURL = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'accept-encoding']);

function curlFor(req) {
  const parts = [`curl -X ${req.method} ${sq(state.captureUrl + req.url)}`];
  for (const [name, value] of req.headers) {
    if (!SKIP_IN_CURL.has(name.toLowerCase())) parts.push(`-H ${sq(`${name}: ${value}`)}`);
  }
  if (req.bodySize > 0) {
    parts.push(req.bodyText !== null ? `--data-binary ${sq(req.bodyText)}` : `--data-binary @request-${req.id}.bin`);
  }
  return parts.join(' \\\n  ');
}

// ------------------------------------------------------------------- state

const state = {
  captureUrl: '',
  expiresAt: 0,
  summaries: new Map(), // id -> summary, the source of truth for the list
  details: new Map(), // id -> full request, fetched on demand
  selected: null,
  oldest: null,
};

// -------------------------------------------------------------------- list

function listItem(s) {
  return h(
    'li',
    { 'data-id': s.id, class: s.id === state.selected ? 'selected' : '' },
    h(
      'button',
      { onclick: () => select(s.id) },
      h('span', { class: `method ${s.method}` }, s.method),
      h('span', { class: 'path' }, s.url),
      h('span', { class: 'sub', 'data-at': s.receivedAt }, `${ago(s.receivedAt)} · ${size(s.bodySize)}`),
    ),
  );
}

function renderList() {
  const ids = [...state.summaries.keys()].sort((a, b) => b - a);
  $('requests').replaceChildren(...ids.map((id) => listItem(state.summaries.get(id))));
  $('empty').hidden = ids.length > 0;
  document.title = ids.length ? `(${ids.length}) Bin · HOOKtopus` : 'Bin · HOOKtopus';
}

function addLive(s) {
  if (state.summaries.has(s.id)) return; // replays after a reconnect can repeat
  state.summaries.set(s.id, s);
  renderList();
  document.querySelector(`li[data-id="${s.id}"]`)?.classList.add('fresh');
  if (state.selected === null) select(s.id);
}

async function loadOlder() {
  const query = state.oldest ? `?before=${state.oldest}` : '';
  const { requests } = await api(`/requests${query}`);
  for (const s of requests) state.summaries.set(s.id, s);
  if (requests.length) state.oldest = requests.at(-1).id;
  $('more').hidden = requests.length < 50;
  renderList();
  return requests;
}

// ------------------------------------------------------------------ detail

function table(rows) {
  return h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))));
}

function bodyView(req) {
  if (req.bodySize === 0) return h('p', { class: 'note' }, 'No body.');
  const raw = `/api/bins/${binId}/requests/${req.id}/raw`;
  if (req.bodyText === null) {
    return h('p', { class: 'note' }, `Binary, ${size(req.bodySize)}. `, h('a', { href: raw }, 'Download the raw bytes'));
  }

  const type = (req.contentType ?? '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    return table([...new URLSearchParams(req.bodyText)]);
  }

  let pretty = null;
  if (type.includes('json') || /^\s*[[{]/.test(req.bodyText)) {
    try { pretty = JSON.stringify(JSON.parse(req.bodyText), null, 2); } catch { /* shown raw */ }
  }
  if (pretty === null) {
    const invalid = type.includes('json') ? h('p', { class: 'note' }, 'Says it is JSON, but does not parse. Shown exactly as received.') : null;
    return h('div', {}, invalid, h('pre', { class: 'body' }, req.bodyText));
  }

  const pre = h('pre', { class: 'body' }, pretty);
  let showingRaw = false;
  const toggle = h('button', {
    onclick: () => {
      showingRaw = !showingRaw;
      pre.textContent = showingRaw ? req.bodyText : pretty;
      toggle.textContent = showingRaw ? 'Pretty' : 'Raw';
    },
  }, 'Raw');
  return h('div', {}, h('div', { class: 'actions' }, toggle), pre);
}

function forwardView(req) {
  const input = h('input', {
    type: 'url',
    required: true,
    placeholder: 'https://example.com/webhooks',
    value: storage.get('hooktopus:forward') ?? '',
    'aria-label': 'Forward to URL',
  });
  const send = h('button', { class: 'primary', type: 'submit' }, 'Send');
  const out = h('div');

  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      storage.set('hooktopus:forward', input.value);
      send.disabled = true;
      out.replaceChildren(h('p', { class: 'note' }, 'Sending…'));
      try {
        const r = await api(`/requests/${req.id}/forward`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: input.value }),
        });
        out.replaceChildren(resultView(r));
      } catch (err) {
        out.replaceChildren(h('div', { class: 'result' }, h('span', { class: 'status bad' }, err.message)));
      } finally {
        send.disabled = false;
      }
    },
  }, input, send);

  return h('div', { class: 'forward' }, form, out);
}

function resultView(r) {
  if (r.outcome === 'error') {
    return h('div', { class: 'result' },
      h('span', { class: 'status bad' }, r.code), ` · ${r.durationMs} ms`,
      h('p', { class: 'note' }, r.message));
  }
  const ok = r.status < 400;
  const body = r.bodyText !== null
    ? h('pre', { class: 'body' }, r.bodyText || '(empty body)')
    : h('p', { class: 'note' }, 'Binary response body.');
  return h('div', { class: 'result' },
    h('span', { class: `status ${ok ? 'ok' : 'bad'}` }, String(r.status)), ` · ${r.durationMs} ms`,
    r.status >= 300 && r.status < 400 ? h('p', { class: 'note' }, 'Redirects are reported, never followed.') : null,
    table(r.headers),
    body,
    r.truncated ? h('p', { class: 'note' }, 'Response cut at 64 KB.') : null);
}

async function select(id) {
  state.selected = id;
  for (const li of document.querySelectorAll('#requests li')) {
    li.classList.toggle('selected', Number(li.dataset.id) === id);
  }

  let req = state.details.get(id);
  if (!req) {
    $('detail').replaceChildren(h('p', { class: 'note' }, 'Loading…'));
    try {
      req = await api(`/requests/${id}`);
      state.details.set(id, req);
    } catch (err) {
      $('detail').replaceChildren(h('p', { class: 'note' }, `Could not load it: ${err.message}`));
      return;
    }
  }
  if (state.selected !== id) return; // another one was clicked meanwhile

  const query = [...new URL(req.url, 'http://x').searchParams];
  // Through h(), which skips nulls; replaceChildren itself would print them.
  $('detail').replaceChildren(h('div', {},
    h('h2', {}, h('span', { class: `method ${req.method}` }, req.method), h('span', { class: 'mono' }, req.url)),
    h('p', { class: 'subline' }, `${new Date(req.receivedAt).toLocaleString()} · from ${req.ip} · ${size(req.bodySize)}`),
    h('div', { class: 'actions' },
      h('button', { onclick: () => copy(curlFor(req), 'curl command copied') }, 'Copy as curl'),
      req.bodySize > 0 ? h('button', { onclick: () => { location.href = `/api/bins/${binId}/requests/${req.id}/raw`; } }, 'Download raw') : null),
    query.length ? [h('h3', {}, 'Query'), table(query)] : null,
    h('h3', {}, `Headers (${req.headers.length})`),
    table(req.headers),
    h('h3', {}, 'Body', req.contentType ? h('span', { class: 'mono' }, req.contentType) : null),
    bodyView(req),
    h('h3', {}, 'Forward'),
    forwardView(req),
  ));
  if (innerWidth < 900) $('detail').scrollIntoView({ behavior: 'smooth' });
}

// -------------------------------------------------------------------- live

function setStatus(text) {
  $('status').textContent = text;
  $('status').className = `pill ${text}`;
}

function connect(since) {
  // The browser resends Last-Event-ID on its own when it reconnects; ?since=
  // only covers this first connection.
  const es = new EventSource(`/api/bins/${binId}/stream?since=${since}`);
  es.onopen = () => setStatus('live');
  es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
  es.addEventListener('request', (event) => addLive(JSON.parse(event.data)));
  es.addEventListener('expired', () => {
    es.close();
    gone('This bin just expired. Bins last 24 hours.');
  });
}

function gone(reason) {
  $('app').hidden = true;
  $('gone').hidden = false;
  if (reason) $('gone-reason').textContent = reason;
  document.querySelector('.capture').hidden = true;
  $('expires').hidden = true;
  setStatus('closed');
}

function tick() {
  $('expires').textContent = left(state.expiresAt - Date.now());
  for (const el of document.querySelectorAll('[data-at]')) {
    el.textContent = el.textContent.replace(/^[^·]+/, `${ago(el.dataset.at)} `);
  }
}

// -------------------------------------------------------------------- boot

$('new-bin').addEventListener('click', async () => {
  const res = await fetch('/api/bins', { method: 'POST' });
  if (res.ok) location.href = `/b/${(await res.json()).id}`;
});
$('load-older').addEventListener('click', loadOlder);
$('copy-url').addEventListener('click', () => copy(state.captureUrl, 'Capture URL copied'));

try {
  const bin = await api('');
  state.captureUrl = bin.captureUrl;
  state.expiresAt = Date.parse(bin.expiresAt);
  $('capture-url').textContent = bin.captureUrl;
  $('try-it').textContent = `curl -X POST ${bin.captureUrl}/test \\\n  -H 'Content-Type: application/json' \\\n  -d '{"hello":"world"}'`;

  const first = await loadOlder();
  connect(first[0]?.id ?? 0);
  if (first[0]) select(first[0].id);
  tick();
  setInterval(tick, 15_000);
} catch (err) {
  gone(err.status === 410 ? 'This bin has expired. Bins last 24 hours.' : 'There is no bin here. It may have expired and been deleted.');
}
