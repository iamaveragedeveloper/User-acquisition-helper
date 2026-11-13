/*
 * Reach Timing - service worker.
 * - geocodes the free-text X location (only the location string leaves the browser)
 * - talks to the Notion API (token stays in chrome.storage.local, only sent to api.notion.com)
 */
importScripts('core.js');
const RT = self.RT;

const NOTION_VERSION = '2022-06-28';
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  route(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: friendly(e) }));
  return true; // async response
});

async function route(msg) {
  switch (msg && msg.type) {
    case 'geocode': return geocode(msg.location);
    case 'notion-test': return notionTest();
    case 'notion-prepare': return notionPrepare();
    case 'notion-lookup': return notionLookup(msg.handle);
    case 'notion-save': return notionSave(msg.profile);
    case 'open-options': chrome.runtime.openOptionsPage(); return { ok: true };
    default: return { ok: false, error: 'Unknown message' };
  }
}

// ------------------------------------------------------------- settings

async function getSettings() {
  const s = await chrome.storage.local.get(['notionToken', 'databaseId']);
  return { token: (s.notionToken || '').trim(), databaseId: normalizeId(s.databaseId || '') };
}

/** Accepts a bare id, a dashed uuid or a full Notion URL. */
function normalizeId(input) {
  const s = String(input || '').split('?')[0];
  const m = /([0-9a-f]{32})/i.exec(s.replace(/-/g, ''));
  return m ? m[1].toLowerCase() : '';
}

async function requireNotion() {
  const { token, databaseId } = await getSettings();
  if (!token) throw new Error('Add your Notion token in the extension settings.');
  if (!databaseId) throw new Error('Add your Notion database link in the extension settings.');
  return { token, databaseId };
}

class NotionError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function friendly(e) {
  const msg = String((e && e.message) || e);
  if (e instanceof NotionError) {
    if (e.status === 401) return 'Notion rejected the token. Re-copy it from your integration page.';
    if (e.status === 404 || e.code === 'object_not_found') {
      return 'Notion cannot see that database. Open it in Notion, click ••• → Connections, and add your integration.';
    }
    if (/is a page, not a database/i.test(msg)) {
      return 'That link is a page, not a database. Create a table inside the page (type /table) and use the table’s own link.';
    }
    if (e.status === 429) return 'Notion rate limit hit. Try again in a few seconds.';
  }
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Network error. Check your connection and try again.';
  return msg;
}

async function notion(token, path, method, body) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new NotionError(json.message || res.statusText, res.status, json.code);
  return json;
}

// ------------------------------------------------------------ geocoding

async function geocode(location) {
  const plan = RT.parseLocation(location);
  if (!plan.queries.length && !plan.flag) return { ok: true, place: null, reason: 'no-location' };

  const cacheKey = 'geo:' + String(location).trim().toLowerCase();
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.at < 30 * 24 * 3600 * 1000) return { ok: true, place: cached.place };

  let place = null;
  const queries = plan.queries.slice();
  if (plan.flag) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(plan.flag);
      if (name && name !== plan.flag) queries.push(name);
    } catch (_) { /* ignore */ }
  }
  for (const q of queries) {
    const url = GEO_URL + '?name=' + encodeURIComponent(q) + '&count=10&language=en&format=json';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Geocoding service error (' + res.status + ')');
    const json = await res.json();
    place = RT.pickPlace(json.results, plan, q);
    if (place) break;
  }
  await chrome.storage.local.set({ [cacheKey]: { at: Date.now(), place } });
  return { ok: true, place };
}

// ---------------------------------------------------- Notion field map

/**
 * key: what the extension knows. names: column names we recognise (case-insensitive).
 * create: how "Add missing columns" creates it. types: Notion property types we can write.
 */
const FIELDS = [
  { key: 'handle', title: true },
  { key: 'displayName', create: 'Display name', names: ['display name', 'full name', 'person'], types: ['rich_text'], make: 'rich_text' },
  { key: 'url', create: 'Profile URL', names: ['profile url', 'url', 'x url', 'link', 'x link', 'profile'], types: ['url', 'rich_text'], make: 'url' },
  { key: 'location', create: 'Location', names: ['location', 'place'], types: ['rich_text', 'select'], make: 'rich_text' },
  { key: 'place', create: 'Resolved place', names: ['resolved place', 'city', 'region'], types: ['rich_text', 'select'], make: 'rich_text' },
  { key: 'timezone', create: 'Timezone', names: ['timezone', 'time zone', 'tz'], types: ['rich_text', 'select'], make: 'rich_text' },
  { key: 'utcOffset', create: 'UTC offset', names: ['utc offset', 'offset', 'utc'], types: ['number', 'rich_text'], make: 'number' },
  { key: 'theirTime', create: 'Their time (at save)', names: ['their time (at save)', 'their time', 'local time'], types: ['rich_text'], make: 'rich_text' },
  { key: 'bestWindow', create: 'Best window (my time)', names: ['best window (my time)', 'best window', 'best time', 'window'], types: ['rich_text'], make: 'rich_text' },
  { key: 'confidence', create: 'TZ confidence', names: ['tz confidence', 'timezone confidence', 'confidence'], types: ['select', 'rich_text'], make: 'select', options: ['High', 'Medium', 'Low'] },
  { key: 'bio', create: 'Bio', names: ['bio', 'description', 'about'], types: ['rich_text'], make: 'rich_text' },
  { key: 'links', create: 'Links', names: ['links', 'website', 'websites'], types: ['rich_text', 'url'], make: 'rich_text' },
  { key: 'followers', create: 'Followers', names: ['followers', 'follower count'], types: ['number'], make: 'number' },
  { key: 'lastPost', create: 'Last post', names: ['last post', 'last active', 'last posted'], types: ['date'], make: 'date' },
  { key: 'dmOpen', create: 'DMs open', names: ['dms open', 'dm open', 'dm'], types: ['checkbox'], make: 'checkbox' },
  { key: 'followsMe', create: 'Follows me', names: ['follows me', 'follows you'], types: ['checkbox'], make: 'checkbox' },
  { key: 'status', create: 'Status', names: ['status', 'stage'], types: ['select', 'status'], make: 'select', options: ['New', 'Contacted', 'Replied', 'Ghosted', 'Won'], createOnly: true },
  { key: 'notes', create: 'Notes', names: ['notes', 'note'], types: ['rich_text'], make: 'rich_text', neverWrite: true },
  { key: 'checked', create: 'Last checked', names: ['last checked', 'last updated', 'updated'], types: ['date'], make: 'date' },
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function mapProperties(schema) {
  const props = Object.entries(schema.properties || {}).map(([name, p]) => ({ name, id: p.id, type: p.type }));
  const title = props.find((p) => p.type === 'title');
  const taken = new Set(title ? [title.name] : []);
  const map = {};
  if (title) map.handle = title;
  for (const f of FIELDS) {
    if (f.title) continue;
    for (const alias of f.names) {
      const hit = props.find((p) => !taken.has(p.name) && norm(p.name) === alias && f.types.includes(p.type));
      if (hit) {
        map[f.key] = hit;
        taken.add(hit.name);
        break;
      }
    }
  }
  return { map, title, props };
}

const trunc = (s, n) => String(s).slice(0, n);

function toNotion(type, value) {
  if (value === null || value === undefined || value === '') return undefined;
  switch (type) {
    case 'title': return { title: [{ text: { content: trunc(value, 2000) } }] };
    case 'rich_text': return { rich_text: [{ text: { content: trunc(value, 2000) } }] };
    case 'url': return { url: trunc(value, 2000) };
    case 'number': return typeof value === 'number' && isFinite(value) ? { number: value } : undefined;
    case 'select': return { select: { name: trunc(String(value).replace(/,/g, ' '), 100) } };
    case 'status': return { status: { name: trunc(value, 100) } };
    case 'date': return { date: { start: value } };
    case 'checkbox': return { checkbox: !!value };
    default: return undefined;
  }
}

function buildProperties(map, p, isNew) {
  const out = {};
  const set = (key, value) => {
    const prop = map[key];
    if (!prop) return;
    const v = toNotion(prop.type, value);
    if (v !== undefined) out[prop.name] = v;
  };
  set('handle', '@' + p.handle);
  set('displayName', p.displayName);
  set('url', p.url);
  set('location', p.location);
  set('place', p.place);
  set('timezone', p.timezone);
  set('utcOffset', p.utcOffset);
  set('theirTime', p.theirTime);
  set('bestWindow', p.bestWindow);
  set('confidence', p.confidence);
  set('bio', p.bio);
  set('links', p.links);
  set('followers', p.followers);
  set('lastPost', p.lastPost);
  set('dmOpen', p.dmOpen);
  set('followsMe', p.followsMe);
  set('checked', new Date().toISOString());
  if (isNew) set('status', 'New'); // never overwrite the status you maintain by hand
  return out; // 'notes' is intentionally never written
}

// ------------------------------------------------------------- Notion ops

async function getSchema(token, databaseId) {
  return notion(token, '/databases/' + databaseId, 'GET');
}

function pageStatus(page, map) {
  const prop = map.status && page.properties[map.status.name];
  if (!prop) return null;
  if (prop.type === 'select') return prop.select ? prop.select.name : null;
  if (prop.type === 'status') return prop.status ? prop.status.name : null;
  return null;
}

async function findExisting(token, databaseId, handle, schemaInfo) {
  const { map, title } = schemaInfo;
  const h = handle.toLowerCase();
  const or = [{ property: title.name, title: { contains: h } }];
  if (map.url && map.url.type === 'url') or.push({ property: map.url.name, url: { contains: '/' + h } });
  const res = await notion(token, '/databases/' + databaseId + '/query', 'POST', {
    filter: or.length > 1 ? { or } : or[0],
    page_size: 25,
  });
  for (const page of res.results) {
    const t = page.properties[title.name];
    const text = t && t.title ? t.title.map((x) => x.plain_text).join('') : '';
    if (text.replace(/^@/, '').trim().toLowerCase() === h) return page;
    const u = map.url && page.properties[map.url.name];
    const urlVal = u && u.type === 'url' ? u.url : null;
    if (urlVal) {
      const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i.exec(urlVal);
      if (m && m[1].toLowerCase() === h) return page;
    }
  }
  return null;
}

async function notionLookup(handle) {
  const { token, databaseId } = await getSettings();
  if (!token || !databaseId) return { ok: true, configured: false };
  const schema = await getSchema(token, databaseId);
  const info = mapProperties(schema);
  if (!info.title) throw new Error('That database has no title column.');
  const page = await findExisting(token, databaseId, handle, info);
  if (!page) return { ok: true, configured: true, found: false };
  return { ok: true, configured: true, found: true, url: page.url, status: pageStatus(page, info.map) };
}

async function notionSave(profile) {
  const { token, databaseId } = await requireNotion();
  const schema = await getSchema(token, databaseId);
  const info = mapProperties(schema);
  if (!info.title) throw new Error('That database has no title column.');

  const existing = await findExisting(token, databaseId, profile.handle, info);
  if (existing) {
    const properties = buildProperties(info.map, profile, false);
    const page = await notion(token, '/pages/' + existing.id, 'PATCH', { properties });
    return { ok: true, created: false, url: page.url, status: pageStatus(page, info.map) };
  }
  const create = (props) =>
    notion(token, '/pages', 'POST', { parent: { database_id: databaseId }, properties: props });
  const properties = buildProperties(info.map, profile, true);
  let page;
  try {
    page = await create(properties);
  } catch (e) {
    // e.g. a Status column without a "New" option: retry without it
    if (info.map.status && properties[info.map.status.name] && e.status === 400) {
      delete properties[info.map.status.name];
      page = await create(properties);
    } else throw e;
  }
  return { ok: true, created: true, url: page.url, status: pageStatus(page, info.map) };
}

async function notionTest() {
  const { token, databaseId } = await requireNotion();
  const schema = await getSchema(token, databaseId);
  const info = mapProperties(schema);
  const title = (schema.title || []).map((t) => t.plain_text).join('') || 'Untitled database';
  const matched = [];
  const missing = [];
  for (const f of FIELDS) {
    if (f.title) {
      matched.push({ key: f.key, column: info.title ? info.title.name : null, type: 'title' });
      continue;
    }
    const m = info.map[f.key];
    if (m) matched.push({ key: f.key, column: m.name, type: m.type });
    else missing.push({ key: f.key, column: f.create });
  }
  return { ok: true, title, matched, missing };
}

async function notionPrepare() {
  const { token, databaseId } = await requireNotion();
  const schema = await getSchema(token, databaseId);
  const info = mapProperties(schema);
  const existingNames = new Set(info.props.map((p) => norm(p.name)));
  const add = {};
  const added = [];
  for (const f of FIELDS) {
    if (f.title || info.map[f.key]) continue;
    if (existingNames.has(norm(f.create))) continue; // name taken by a column of another type: leave alone
    let def;
    if (f.make === 'select') def = { select: { options: (f.options || []).map((name) => ({ name })) } };
    else if (f.make === 'number') def = { number: { format: 'number' } };
    else def = { [f.make]: {} };
    add[f.create] = def;
    added.push(f.create);
  }
  if (added.length) await notion(token, '/databases/' + databaseId, 'PATCH', { properties: add });
  return { ok: true, added };
}
