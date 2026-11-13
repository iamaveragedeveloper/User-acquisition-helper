// Run with: node extension/test/background.test.js
// Loads background.js in a vm with a stubbed chrome + fetch and drives the Notion flow against a database
// shaped like the user's real tracker: ID (auto), Account handle (title), Status / Sale / Type (Notion "Status"
// columns), Which sold (select).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const DB = 'a'.repeat(32);
const store = {};
const calls = [];

const schema = {
  title: [{ plain_text: 'Accounts' }],
  properties: {
    ID: { id: 'i', type: 'unique_id', unique_id: { prefix: null } },
    'Account handle': { id: 't', type: 'title', title: {} },
    Status: { id: 's', type: 'status', status: { options: [{ name: 'Information' }, { name: 'Contacted' }, { name: 'Replied' }] } },
    Sale: { id: 'sa', type: 'status', status: { options: [{ name: '---' }, { name: 'Won' }] } },
    'Which sold': { id: 'w', type: 'select', select: { options: [{ name: 'Course' }] } },
    Type: { id: 'ty', type: 'status', status: { options: [{ name: 'AI Educator' }, { name: 'Founder' }] } },
  },
};
let existingPages = [];

const jsonRes = (status, body) =>
  Promise.resolve({ ok: status < 400, status, statusText: 'x', json: () => Promise.resolve(body) });

const sandbox = {
  console, Intl, Date, JSON, Promise, URL, encodeURIComponent, setTimeout,
  importScripts: (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx),
  chrome: {
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
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });
    if (url.includes('geocoding-api')) {
      return jsonRes(200, { results: [{ name: 'Austin', admin1: 'Texas', country: 'United States', country_code: 'US', timezone: 'America/Chicago', feature_code: 'PPLA', population: 900000 }] });
    }
    if (url.endsWith('/databases/' + DB) && method === 'GET') return jsonRes(200, schema);
    if (url.endsWith('/databases/' + DB) && method === 'PATCH') {
      // behave like Notion: the new columns now exist
      for (const [name, def] of Object.entries(body.properties)) {
        const type = Object.keys(def)[0];
        schema.properties[name] = { id: name, type, [type]: def[type] };
      }
      return jsonRes(200, schema);
    }
    if (url.endsWith('/query')) return jsonRes(200, { results: existingPages });
    if (url.endsWith('/pages') && method === 'POST') return jsonRes(200, { id: 'new', url: 'https://notion.so/new', properties: { Status: { type: 'status', status: { name: 'Information' } } } });
    if (url.includes('/pages/') && method === 'PATCH') return jsonRes(200, { id: 'old', url: 'https://notion.so/old', properties: { Status: { type: 'status', status: { name: 'Contacted' } } } });
    return jsonRes(404, { message: 'nope', code: 'object_not_found' });
  },
};
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);

// results are copied into this realm so deepStrictEqual compares plain objects/arrays
const ask = (msg) =>
  new Promise((resolve) => sandbox.__handler(msg, { id: 'me' }, (res) => resolve(JSON.parse(JSON.stringify(res)))));
const lastCall = (method, test) => calls.filter((c) => c.method === method && test(c.url)).pop();

const profile = {
  handle: 'noahaitoolstech', displayName: 'Noah', url: 'https://x.com/noahaitoolstech', location: 'Austin, TX',
  place: 'Austin, Texas, United States', timezone: 'America/Chicago', utcOffset: -6, theirTime: 'Thu 9:30 AM (UTC-6)',
  bestWindow: '7:30 PM–10:00 PM (my time)', confidence: 'High', bio: 'hi', links: 'https://a.com', followers: 1200,
  lastPost: '2026-11-12T10:00:00.000Z', dmOpen: true, followsMe: false,
};

(async () => {
  store.notionToken = 'secret_x';
  store.databaseId = 'https://www.notion.so/ws/Accounts-' + DB + '?v=' + 'b'.repeat(32);

  // geocode round trip + cache
  assert.equal((await ask({ type: 'geocode', location: 'Austin, TX' })).place.timezone, 'America/Chicago');
  const before = calls.length;
  await ask({ type: 'geocode', location: 'Austin, TX' });
  assert.equal(calls.length, before, 'second geocode must come from cache');

  // test: title found, Status recognised, Sale/Type/Which sold left alone, timing columns offered
  const test = await ask({ type: 'notion-test' });
  assert.equal(test.ok, true);
  const cols = Object.fromEntries(test.matched.map((m) => [m.key, m.column]));
  assert.equal(cols.handle, 'Account handle');
  assert.equal(cols.status, 'Status');
  assert.ok(!Object.values(cols).some((c) => ['Sale', 'Type', 'Which sold', 'ID'].includes(c)), 'must not claim your own columns');
  const missingKeys = test.missing.map((m) => m.key);
  assert.ok(!missingKeys.includes('status'), 'status is yours, never offered as a column to add');
  assert.deepEqual(test.missing.filter((m) => m.core).map((m) => m.key).sort(), ['bestWindow', 'confidence', 'location', 'theirTime', 'timezone', 'url', 'usualTimes']);

  // save BEFORE adding any columns: only the handle is written, and the UI is told
  existingPages = [];
  const bare = await ask({ type: 'notion-save', profile });
  assert.equal(bare.ok, true);
  assert.equal(bare.wrote, 0);
  assert.equal(bare.missingCore.length, 7);
  let post = lastCall('POST', (u) => u.endsWith('/pages'));
  assert.equal(post.body.properties['Account handle'].title[0].text.content, '@noahaitoolstech');
  assert.ok(!('Status' in post.body.properties), 'no "New" option -> Status keeps Notion’s own default');
  assert.deepEqual(Object.keys(post.body.properties).filter((k) => !['Account handle'].includes(k)), []);

  // add only the ticked columns
  const prep = await ask({ type: 'notion-prepare', keys: ['location', 'timezone', 'bestWindow'] });
  assert.deepEqual(prep.added.sort(), ['Best window (my time)', 'Location', 'Timezone']);
  assert.ok(!('Bio' in schema.properties) && !('Followers' in schema.properties), 'unticked columns are not added');
  assert.ok('Status' in schema.properties && 'Sale' in schema.properties, 'existing columns untouched');

  // save again: new row now carries the data; Sale / Type / Which sold / Status untouched
  const created = await ask({ type: 'notion-save', profile });
  assert.equal(created.created, true);
  assert.equal(created.wrote, 3);
  assert.deepEqual(created.missingCore.sort(), ['Profile URL', 'TZ confidence', 'Their time (at save)', 'Usual post times (my time)']);

  // add the usual-times column and check it is filled from the profile payload
  await ask({ type: 'notion-prepare', keys: ['usualTimes'] });
  await ask({ type: 'notion-save', profile: Object.assign({}, profile, { usualTimes: '8:30 AM and 8:30 PM (my time)' }) });
  const withUsual = lastCall('POST', (u) => u.endsWith('/pages'));
  assert.equal(withUsual.body.properties['Usual post times (my time)'].rich_text[0].text.content, '8:30 AM and 8:30 PM (my time)');
  post = lastCall('POST', (u) => u.endsWith('/pages'));
  assert.equal(post.body.parent.database_id, DB);
  assert.equal(post.body.properties.Location.rich_text[0].text.content, 'Austin, TX');
  assert.equal(post.body.properties.Timezone.rich_text[0].text.content, 'America/Chicago');
  for (const mine of ['Status', 'Sale', 'Type', 'Which sold', 'ID', 'Notes']) {
    assert.ok(!(mine in post.body.properties), mine + ' must not be written');
  }

  // an existing row (typed by you as "@NoahAIToolsTech") is updated, not duplicated; Status never overwritten
  existingPages = [{ id: 'old', url: 'https://notion.so/old', properties: { 'Account handle': { type: 'title', title: [{ plain_text: '@NoahAIToolsTech' }] }, Status: { type: 'status', status: { name: 'Contacted' } } } }];
  const lookup = await ask({ type: 'notion-lookup', handle: 'noahaitoolstech' });
  assert.equal(lookup.found, true);
  assert.equal(lookup.status, 'Contacted');
  const upd = await ask({ type: 'notion-save', profile });
  assert.equal(upd.created, false);
  const patch = lastCall('PATCH', (u) => u.includes('/pages/'));
  assert.ok(!('Status' in patch.body.properties));
  assert.ok('Location' in patch.body.properties);

  // a similar handle must not match
  existingPages = [{ id: 'x', url: 'u', properties: { 'Account handle': { type: 'title', title: [{ plain_text: '@noahaitoolstech2' }] } } }];
  assert.equal((await ask({ type: 'notion-lookup', handle: 'noahaitoolstech' })).found, false);

  // if a Status column DOES have a "New" option it is used for new rows only
  schema.properties.Status.status.options.push({ name: 'new' });
  existingPages = [];
  await ask({ type: 'notion-save', profile });
  post = lastCall('POST', (u) => u.endsWith('/pages'));
  assert.deepEqual(post.body.properties.Status, { status: { name: 'new' } });

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
