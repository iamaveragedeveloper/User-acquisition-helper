// Run with: node extension/test/background.test.js
// Loads background.js in a vm with a stubbed chrome + fetch and drives the Notion upsert flow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const store = {};
const calls = [];

// A user's existing database: default "Name" title, some of our columns, a real Status column.
const schema = {
  title: [{ plain_text: 'Leads' }],
  properties: {
    Name: { id: 't', type: 'title' },
    Location: { id: 'a', type: 'rich_text' },
    'Profile URL': { id: 'b', type: 'url' },
    Status: { id: 'c', type: 'status' },
    Followers: { id: 'd', type: 'number' },
    Notes: { id: 'e', type: 'rich_text' },
    'Time zone': { id: 'f', type: 'rich_text' },
  },
};
let existingPages = [];

function jsonRes(status, body) {
  return Promise.resolve({ ok: status < 400, status, statusText: 'x', json: () => Promise.resolve(body) });
}

const sandbox = {
  console,
  Intl,
  Date,
  JSON,
  Promise,
  URL,
  encodeURIComponent,
  setTimeout,
  importScripts: (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx),
  chrome: {
    action: { onClicked: { addListener() {} } },
    runtime: { id: 'me', onMessage: { addListener(fn) { sandbox.__handler = fn; } }, openOptionsPage() {} },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (o) => Object.assign(store, o),
      },
    },
  },
  fetch: (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url.includes('geocoding-api')) {
      return jsonRes(200, { results: [{ name: 'Austin', admin1: 'Texas', country: 'United States', country_code: 'US', timezone: 'America/Chicago', feature_code: 'PPLA', population: 900000 }] });
    }
    if (url.endsWith('/databases/' + 'a'.repeat(32)) && (!opts || !opts.method || opts.method === 'GET')) return jsonRes(200, schema);
    if (url.endsWith('/query')) return jsonRes(200, { results: existingPages });
    if (url.endsWith('/pages') && opts.method === 'POST') return jsonRes(200, { id: 'new', url: 'https://notion.so/new', properties: { Status: { type: 'status', status: { name: 'New' } } } });
    if (url.includes('/pages/') && opts.method === 'PATCH') return jsonRes(200, { id: 'old', url: 'https://notion.so/old', properties: { Status: { type: 'status', status: { name: 'Contacted' } } } });
    if (url.endsWith('/databases/' + 'a'.repeat(32)) && opts.method === 'PATCH') return jsonRes(200, {});
    return jsonRes(404, { message: 'nope', code: 'object_not_found' });
  },
};
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);

const ask = (msg) =>
  new Promise((resolve) => sandbox.__handler(msg, { id: 'me' }, resolve));

const profile = {
  handle: 'NihalDev', displayName: 'Nihal', url: 'https://x.com/NihalDev', location: 'Austin, TX',
  place: 'Austin, Texas, United States', timezone: 'America/Chicago', utcOffset: -6, theirTime: 'Thu 9:30 AM (UTC-6)',
  bestWindow: '7:30 PM–10:00 PM (my time)', confidence: 'High', bio: 'hi', links: 'https://a.com', followers: 1200,
  lastPost: '2026-11-12T10:00:00.000Z', dmOpen: true, followsMe: false,
};

(async () => {
  store.notionToken = 'secret_x';
  store.databaseId = 'https://www.notion.so/ws/Leads-' + 'a'.repeat(32) + '?v=' + 'b'.repeat(32);

  // geocode round trip + cache
  const g = await ask({ type: 'geocode', location: 'Austin, TX' });
  assert.equal(g.place.timezone, 'America/Chicago');
  const before = calls.length;
  await ask({ type: 'geocode', location: 'Austin, TX' });
  assert.equal(calls.length, before, 'second geocode must come from cache');

  // test connection maps columns and reports missing ones
  const test = await ask({ type: 'notion-test' });
  assert.equal(test.ok, true);
  const cols = Object.fromEntries(test.matched.map((m) => [m.key, m.column]));
  assert.equal(cols.handle, 'Name');
  assert.equal(cols.timezone, 'Time zone');
  assert.equal(cols.status, 'Status');
  assert.ok(test.missing.some((m) => m.column === 'Bio'));

  // new row
  existingPages = [];
  const created = await ask({ type: 'notion-save', profile });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  const post = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pages')).pop();
  assert.equal(post.body.parent.database_id, 'a'.repeat(32));
  assert.equal(post.body.properties.Name.title[0].text.content, '@NihalDev');
  assert.equal(post.body.properties.Location.rich_text[0].text.content, 'Austin, TX');
  assert.equal(post.body.properties.Followers.number, 1200);
  assert.equal(post.body.properties['Time zone'].rich_text[0].text.content, 'America/Chicago');
  assert.deepEqual(post.body.properties.Status, { status: { name: 'New' } });
  assert.ok(!('Notes' in post.body.properties), 'Notes must never be written');
  assert.ok(!('Bio' in post.body.properties), 'columns that do not exist are skipped');

  // existing row (different case + @) -> PATCH, status untouched
  existingPages = [{ id: 'old', url: 'https://notion.so/old', properties: { Name: { type: 'title', title: [{ plain_text: '@nihaldev' }] }, Status: { type: 'status', status: { name: 'Contacted' } } } }];
  const lookup = await ask({ type: 'notion-lookup', handle: 'NihalDev' });
  assert.equal(lookup.found, true);
  assert.equal(lookup.status, 'Contacted');
  const upd = await ask({ type: 'notion-save', profile });
  assert.equal(upd.created, false);
  const patch = calls.filter((c) => c.method === 'PATCH' && c.url.includes('/pages/')).pop();
  assert.ok(!('Status' in patch.body.properties), 'status must not be overwritten on update');
  assert.ok('Location' in patch.body.properties);

  // someone else with a similar handle must not match
  existingPages = [{ id: 'x', url: 'u', properties: { Name: { type: 'title', title: [{ plain_text: '@nihaldev2' }] } } }];
  assert.equal((await ask({ type: 'notion-lookup', handle: 'NihalDev' })).found, false);

  // prepare adds only the missing columns
  const prep = await ask({ type: 'notion-prepare' });
  assert.ok(prep.added.includes('Bio') && !prep.added.includes('Location') && !prep.added.includes('Status'));
  const dbPatch = calls.filter((c) => c.method === 'PATCH' && c.url.endsWith('/databases/' + 'a'.repeat(32))).pop();
  assert.deepEqual(dbPatch.body.properties['TZ confidence'].select.options.map((o) => o.name), ['High', 'Medium', 'Low']);

  // friendly errors
  store.databaseId = 'c'.repeat(32);
  const bad = await ask({ type: 'notion-test' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Connections/);
  store.notionToken = '';
  assert.match((await ask({ type: 'notion-test' })).error, /token/i);

  console.log('background tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
