const $ = (id) => document.getElementById(id);
const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const DEFAULT_WINDOWS = '09:00-11:30, 18:00-21:00';

function say(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = cls || '';
}

async function load() {
  try {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    $('tzlist').innerHTML = zones.map((z) => '<option value="' + z + '">').join('');
  } catch (_) { /* datalist is optional */ }
  const s = await chrome.storage.local.get(['notionToken', 'databaseId', 'myTz', 'windowsStr', 'myAwake', 'useActivity', 'showPanel']);
  $('panel').checked = s.showPanel !== false;
  $('awake').value = s.myAwake || '08:00-23:00';
  $('token').value = s.notionToken || '';
  $('db').value = s.databaseId || '';
  $('tz').value = s.myTz || defaultTz;
  $('windows').value = s.windowsStr || DEFAULT_WINDOWS;
  $('activity').checked = s.useActivity !== false;
}

function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

async function save() {
  const tz = $('tz').value.trim() || defaultTz;
  if (!validTz(tz)) {
    say('“' + tz + '” isn’t a valid timezone name. Use something like Asia/Kolkata or America/New_York.', 'bad');
    return false;
  }
  await chrome.storage.local.set({
    notionToken: $('token').value.trim(),
    databaseId: $('db').value.trim(),
    myTz: tz,
    windowsStr: $('windows').value.trim() || DEFAULT_WINDOWS,
    useActivity: $('activity').checked,
    showPanel: $('panel').checked,
    myAwake: $('awake').value.trim() || '08:00-23:00',
  });
  say('Saved.', 'ok');
  return true;
}

async function call(type, extra) {
  if (!(await save())) return;
  say('Working…');
  const res = await chrome.runtime
    .sendMessage(Object.assign({ type }, extra || {}))
    .catch((e) => ({ ok: false, error: String(e.message || e) }));
  return res;
}

const KIND = { rich_text: 'text', url: 'link', number: 'number', select: 'select', date: 'date', checkbox: 'checkbox' };

/** Tick-list of the columns your database doesn't have yet; the timing ones are pre-ticked. */
function renderMissing(missing) {
  const box = $('cols');
  box.textContent = '';
  if (!missing.length) return;
  const h = document.createElement('h2');
  h.textContent = 'Columns you can add';
  const p = document.createElement('p');
  p.textContent = 'Your existing columns are never changed. Untick anything you don’t want in your table.';
  box.append(h, p);
  for (const m of missing) {
    const label = document.createElement('label');
    label.className = 'colrow';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = m.key;
    cb.checked = !!m.core;
    const span = document.createElement('span');
    span.textContent = m.column + ' (' + (KIND[m.kind] || m.kind) + ')';
    label.append(cb, span);
    box.appendChild(label);
  }
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = 'Add selected columns';
  btn.addEventListener('click', async () => {
    const keys = Array.from(box.querySelectorAll('input:checked')).map((i) => i.value);
    if (!keys.length) return say('Tick at least one column.', 'bad');
    const res = await call('notion-prepare', { keys });
    if (!res) return;
    if (!res.ok) return say(res.error, 'bad');
    say(res.added.length ? 'Added columns: ' + res.added.join(', ') : 'Nothing was added.', 'ok');
    runTest(true);
  });
  box.appendChild(btn);
}

$('save').addEventListener('click', save);

async function runTest(keepMessage) {
  const res = await call('notion-test');
  if (!res) return;
  if (!res.ok) {
    renderMissing([]);
    return say(res.error, 'bad');
  }
  const filled = res.matched.filter((m) => m.key !== 'status' && m.key !== 'notes');
  const lines = ['Connected to “' + res.title + '”.', ''];
  lines.push('Will fill: ' + filled.map((m) => m.column).join(', '));
  const kept = res.matched.filter((m) => m.key === 'status' || m.key === 'notes').map((m) => m.column);
  if (kept.length) lines.push('Never touched by the extension: ' + kept.join(', ') + ' (plus any other columns you have)');
  lines.push('', res.missing.length ? 'Tick the columns you want added below.' : 'Every column is present.');
  if (!keepMessage || res.missing.length === 0) say(lines.join('\n'), 'ok');
  renderMissing(res.missing);
}

$('test').addEventListener('click', () => runTest(false));

load();
