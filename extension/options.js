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
  const s = await chrome.storage.local.get(['notionToken', 'databaseId', 'myTz', 'windowsStr', 'useActivity']);
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
  });
  say('Saved.', 'ok');
  return true;
}

async function call(type) {
  if (!(await save())) return;
  say('Working…');
  const res = await chrome.runtime.sendMessage({ type }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  return res;
}

$('save').addEventListener('click', save);

$('test').addEventListener('click', async () => {
  const res = await call('notion-test');
  if (!res) return;
  if (!res.ok) return say(res.error, 'bad');
  const lines = ['Connected to “' + res.title + '”.', ''];
  lines.push('Columns it will fill: ' + res.matched.map((m) => m.column).join(', '));
  if (res.missing.length) {
    lines.push('', 'Not in your database yet (press “Add missing columns”): ' + res.missing.map((m) => m.column).join(', '));
  } else lines.push('', 'All columns are present.');
  say(lines.join('\n'), 'ok');
});

$('prepare').addEventListener('click', async () => {
  const res = await call('notion-prepare');
  if (!res) return;
  if (!res.ok) return say(res.error, 'bad');
  say(res.added.length ? 'Added columns: ' + res.added.join(', ') : 'Nothing to add. Your database already has every column.', 'ok');
});

load();
