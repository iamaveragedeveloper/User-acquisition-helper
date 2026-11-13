// Run with: node extension/test/core.test.js
const assert = require('node:assert/strict');
const RT = require('../core.js');

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   - ' + name);
  } catch (e) {
    console.error('FAIL - ' + name + '\n' + e.stack);
    process.exitCode = 1;
  }
}

t('localParts: LA winter / summer offsets (DST)', () => {
  const w = RT.localParts({ iana: 'America/Los_Angeles' }, new Date(Date.UTC(2026, 0, 15, 12, 0)));
  assert.equal(w.hour, 4);
  assert.equal(w.offsetMin, -480);
  const s = RT.localParts({ iana: 'America/Los_Angeles' }, new Date(Date.UTC(2026, 6, 15, 12, 0)));
  assert.equal(s.hour, 5);
  assert.equal(s.offsetMin, -420);
});

t('localParts: India half-hour offset and fixed zones', () => {
  const p = RT.localParts({ iana: 'Asia/Kolkata' }, new Date(Date.UTC(2026, 0, 15, 12, 0)));
  assert.equal(p.hour, 17);
  assert.equal(p.minute, 30);
  assert.equal(p.offsetMin, 330);
  const f = RT.localParts({ fixed: -300 }, new Date(Date.UTC(2026, 0, 15, 2, 0)));
  assert.equal(f.hour, 21);
  assert.equal(f.weekday, 3); // Wed Jan 14
});

t('formatting helpers', () => {
  assert.equal(RT.formatOffset(330), 'UTC+5:30');
  assert.equal(RT.formatOffset(-480), 'UTC-8');
  assert.equal(RT.describeDelta(330, -480), '13h 30m ahead of you');
  assert.equal(RT.describeDelta(-480, 330), '13h 30m behind you');
  assert.equal(RT.describeDelta(60, 60), 'same time as you');
  assert.equal(RT.fmtClock(0, 5), '12:05 AM');
  assert.equal(RT.fmtClock(13, 0), '1:00 PM');
});

t('parseWindows incl. overnight + invalid fallback', () => {
  assert.deepEqual(RT.parseWindows('09:00-11:30, 18:00-21:00'), [[540, 690], [1080, 1260]]);
  assert.deepEqual(RT.parseWindows('22:00-01:00'), [[1320, 1440], [0, 60]]);
  assert.deepEqual(RT.parseWindows('nonsense'), [[540, 690], [1080, 1260]]);
});

t('windowStatus: inside a window and next window', () => {
  const zone = { iana: 'Asia/Kolkata' };
  const wins = [[540, 690], [1080, 1260]];
  // 04:00 UTC = 09:30 IST -> inside, ends in 120 min
  const a = RT.windowStatus(zone, wins, new Date(Date.UTC(2026, 0, 15, 4, 0)));
  assert.equal(a.state, 'now');
  assert.equal(a.endsInMin, 120);
  // 08:00 UTC = 13:30 IST -> next at 18:00 IST = 12:30 UTC -> 270 min
  const b = RT.windowStatus(zone, wins, new Date(Date.UTC(2026, 0, 15, 8, 0)));
  assert.equal(b.state, 'later');
  assert.equal(b.inMin, 270);
  assert.equal(b.startsAt.toISOString(), '2026-01-15T12:30:00.000Z');
});

t('inferOffsetFromPosts finds UTC-5 for an evening poster', () => {
  const times = [];
  // posts at local 9..22 (UTC-5) on several days -> UTC 14..03
  for (let day = 1; day <= 4; day++) {
    for (const lh of [9, 11, 13, 15, 18, 20, 22]) {
      times.push(Date.UTC(2026, 0, day, lh + 5, 0));
    }
  }
  const r = RT.inferOffsetFromPosts(times);
  assert.equal(r.level, 'good');
  assert.equal(r.offsetHours, -5);
  assert.equal(RT.inferOffsetFromPosts(times.slice(0, 5)).level, 'none');
});

t('parseLocation: city/state, aliases, junk, flags', () => {
  assert.deepEqual(RT.parseLocation('Austin, TX').queries, ['Austin']);
  assert.ok(RT.parseLocation('Austin, TX').hints.includes('texas'));
  assert.deepEqual(RT.parseLocation('NYC').queries, ['New York']);
  assert.deepEqual(RT.parseLocation('Earth 🌍').queries, []);
  assert.deepEqual(RT.parseLocation('Remote').queries, []);
  assert.deepEqual(RT.parseLocation('London, UK').queries, ['London', 'United Kingdom']);
  assert.deepEqual(RT.parseLocation('Berlin 🇩🇪 / Remote').queries, ['Berlin']);
  assert.equal(RT.parseLocation('🇮🇳').flag, 'IN');
  assert.deepEqual(RT.parseLocation('Bay Area').queries, ['San Francisco']);
});

t('pickPlace uses hints and flags precision', () => {
  const results = [
    { name: 'Austin', admin1: 'Minnesota', country: 'United States', country_code: 'US', timezone: 'America/Chicago', feature_code: 'PPL', population: 25000 },
    { name: 'Austin', admin1: 'Texas', country: 'United States', country_code: 'US', timezone: 'America/Chicago', feature_code: 'PPLA', population: 900000 },
  ];
  const plan = RT.parseLocation('Austin, TX');
  const p = RT.pickPlace(results, plan, 'Austin');
  assert.equal(p.admin1, 'Texas');
  assert.equal(p.precision, 3);
  const us = RT.pickPlace(
    [{ name: 'United States', country: 'United States', country_code: 'US', timezone: 'America/Chicago', feature_code: 'PCLI', population: 3e8 }],
    RT.parseLocation('USA'),
    'United States'
  );
  assert.equal(us.precision, 1);
  const india = RT.pickPlace(
    [{ name: 'India', country: 'India', country_code: 'IN', timezone: 'Asia/Kolkata', feature_code: 'PCLI', population: 1e9 }],
    RT.parseLocation('India'),
    'India'
  );
  assert.equal(india.precision, 3);
});

t('parseCount', () => {
  assert.equal(RT.parseCount('12.3K Followers'), 12300);
  assert.equal(RT.parseCount('1,234 Followers'), 1234);
  assert.equal(RT.parseCount('4.5M'), 4500000);
  assert.equal(RT.parseCount('87'), 87);
  assert.equal(RT.parseCount('none'), null);
});

t('analyze: location only', () => {
  const now = new Date(Date.UTC(2026, 0, 15, 4, 0)); // 09:30 IST
  const a = RT.analyze({
    place: { name: 'Mumbai', country: 'India', timezone: 'Asia/Kolkata', precision: 3 },
    sampleTimes: [],
    myTz: 'America/Los_Angeles',
    windowsStr: '09:00-11:30, 18:00-21:00',
    now,
  });
  assert.equal(a.used, 'location');
  assert.equal(a.confidence, 'High');
  assert.equal(a.timeNow, 'Thu 9:30 AM');
  assert.equal(a.deltaText, '13h 30m ahead of you');
  assert.equal(a.status.state, 'now');
  assert.equal(a.windowSource, 'default');
  // their 9:00-11:30 / 18:00-21:00 IST in LA time (UTC-8): 7:30 PM-10:00 PM, 4:30 AM-7:30 AM
  assert.equal(a.windowsMine, '7:30 PM–10:00 PM, 4:30 AM–7:30 AM');
});

t('analyze: no data -> none; posts-only -> estimated zone; conflict lowers confidence', () => {
  const now = new Date(Date.UTC(2026, 0, 15, 12, 0));
  const none = RT.analyze({ place: null, sampleTimes: [], myTz: 'UTC', now });
  assert.equal(none.used, 'none');

  const times = [];
  for (let day = 1; day <= 4; day++) for (const lh of [9, 11, 13, 15, 18, 20, 22]) times.push(Date.UTC(2026, 0, day, lh + 5, 0));
  const posts = RT.analyze({ place: null, sampleTimes: times, myTz: 'UTC', now });
  assert.equal(posts.used, 'posts');
  assert.equal(posts.offsetLabel, 'UTC-5');
  assert.equal(posts.windowSource, 'activity');
  assert.ok(posts.confidence === 'Medium');

  // location says India but posts say UTC-5 -> conflict
  const c = RT.analyze({
    place: { name: 'Mumbai', country: 'India', timezone: 'Asia/Kolkata', precision: 3 },
    sampleTimes: times, myTz: 'UTC', now,
  });
  assert.equal(c.conflict, true);
  assert.equal(c.confidence, 'Low');
  assert.equal(c.canSwitch, true);
  const sw = RT.analyze({
    place: { name: 'Mumbai', country: 'India', timezone: 'Asia/Kolkata', precision: 3 },
    sampleTimes: times, myTz: 'UTC', now, source: 'posts',
  });
  assert.equal(sw.used, 'posts');

  // agreeing evidence raises a country-level ambiguous location
  const agree = RT.analyze({
    place: { name: 'United States', country: 'United States', timezone: 'America/New_York', precision: 1 },
    sampleTimes: times, myTz: 'UTC', now,
  });
  assert.equal(agree.agree, true);
  assert.equal(agree.confidence, 'Medium');
});

t('analyze: side-by-side clocks, day difference and shared timeline', () => {
  // Thu 2026-01-15 04:00 UTC = 20:00 Wed in LA (their side), 09:30 Thu in Kolkata (my side)
  const now = new Date(Date.UTC(2026, 0, 15, 4, 0));
  const a = RT.analyze({
    place: { name: 'Los Angeles', country: 'United States', timezone: 'America/Los_Angeles', precision: 3 },
    sampleTimes: [], myTz: 'Asia/Kolkata', windowsStr: '18:00-21:00', now,
  });
  assert.equal(a.my.clock, '9:30 AM');
  assert.equal(a.my.name, 'Kolkata');
  assert.equal(a.their.clock, '8:00 PM');
  assert.equal(a.their.name, 'Los Angeles');
  assert.equal(a.their.dateLabel, 'Wed, Jan 14');
  assert.equal(a.my.dateLabel, 'Thu, Jan 15');
  assert.equal(a.dayDiff, -1);
  assert.equal(a.my.daytime, true);
  assert.equal(a.their.daytime, false);

  const tl = a.timeline;
  assert.equal(tl.cells.length, 24);
  assert.ok(tl.nowPct >= 0 && tl.nowPct < 100 / 24);
  // cell 0 = 04:00-05:00 UTC = 20:00-21:00 LA (good) and 09:30-10:30 Kolkata (awake) -> both
  assert.equal(tl.cells[0].theirGood, true);
  assert.equal(tl.cells[0].myAwake, true);
  assert.equal(tl.cells[0].both, true);
  // cell 1 = 21:00 LA, outside the 18-21 window
  assert.equal(tl.cells[1].theirGood, false);
  // cell 14 = 18:00 UTC = 23:30 Kolkata -> I am asleep by default hours (08:00-23:00)
  assert.equal(tl.cells[14].myAwake, false);
  assert.ok(tl.theirTicks.every((x) => x.pos >= 0 && x.pos < 24) && tl.theirTicks.length >= 3);
  // custom awake hours are honoured
  const b = RT.analyze({
    place: { name: 'Los Angeles', country: 'United States', timezone: 'America/Los_Angeles', precision: 3 },
    sampleTimes: [], myTz: 'Asia/Kolkata', windowsStr: '18:00-21:00', myAwakeStr: '00:00-24:00', now,
  });
  assert.ok(b.timeline.cells.every((c) => c.myAwake));
  // unknown timezone still gives me my own clock
  const n = RT.analyze({ place: null, sampleTimes: [], myTz: 'Asia/Kolkata', now });
  assert.equal(n.used, 'none');
  assert.equal(n.my.clock, '9:30 AM');
  assert.equal(n.their, undefined);
});

t('formatAgo', () => {
  assert.equal(RT.formatAgo(0.4), 'just now');
  assert.equal(RT.formatAgo(12), '12 min ago');
  assert.equal(RT.formatAgo(180), '3h ago');
  assert.equal(RT.formatAgo(60 * 24 * 2), '2 days ago');
});

t('analyzePosts: usual times, next post, per-day, in both timezones', () => {
  const la = { iana: 'America/Los_Angeles' };
  const me = { iana: 'Asia/Kolkata' };
  const now = new Date(Date.UTC(2026, 0, 15, 16, 0)); // 08:00 Thu in LA, 21:30 Thu in Kolkata
  const posts = [];
  for (let d = 8; d <= 14; d++) {
    posts.push({ ms: Date.UTC(2026, 0, d, 17, 10), text: 'morning ' + d, href: 'h' + d }); // 09:10 LA
    posts.push({ ms: Date.UTC(2026, 0, d + 1, 3, 20), text: 'evening ' + d, href: 'e' + d }); // 19:20 LA
  }
  const r = RT.analyzePosts(posts, la, me, now);
  assert.equal(r.pattern.enough, true);
  assert.deepEqual(r.pattern.usual, [9, 19]);
  assert.equal(r.pattern.usualTheirsText, '9 AM and 7 PM');
  // 9 AM LA = 22:30 Kolkata, 7 PM LA = 08:30 Kolkata (next day)
  assert.equal(r.pattern.usualMineText, '10:30 PM and 8:30 AM');
  assert.equal(r.pattern.next.inside, false);
  assert.equal(r.pattern.next.inMin, 60);
  assert.equal(r.pattern.next.theirs, '9 AM');
  assert.match(r.pattern.perDayText, /^about 2 posts a day$/);
  assert.equal(r.fresh, null); // newest post is hours old
  assert.equal(r.latest[0].text, 'evening 14');
  assert.ok(r.latest[0].theirTime && r.latest[0].myTime);
});

t('analyzePosts: fresh post detection, pinned/replies ignored, works without a timezone', () => {
  const me = { iana: 'UTC' };
  const now = new Date(Date.UTC(2026, 0, 15, 12, 0));
  const posts = [
    { ms: now.getTime() - 7 * 60000, text: 'just now', href: 'x' },
    { ms: now.getTime() - 60000, text: 'a reply', reply: true },
    { ms: now.getTime() - 1000, text: 'pinned old', pinned: true },
    { ms: now.getTime() - 5 * 3600000, text: 'older' },
  ];
  const r = RT.analyzePosts(posts, null, me, now);
  assert.equal(r.fresh, 'now');
  assert.equal(r.latest[0].text, 'just now');
  assert.equal(r.latest.length, 2);
  assert.equal(r.pattern, null);
  const recent = RT.analyzePosts([{ ms: now.getTime() - 90 * 60000, text: 'x' }], null, me, now);
  assert.equal(recent.fresh, 'recent');
  // too few posts -> tells the UI how many are missing
  const few = RT.analyzePosts(posts, { iana: 'UTC' }, me, now);
  assert.equal(few.pattern.enough, false);
  assert.equal(few.pattern.have, 3);
});

t('analyze passes posts through (also when timezone is unknown)', () => {
  const now = new Date(Date.UTC(2026, 0, 15, 12, 0));
  const posts = [{ ms: now.getTime() - 5 * 60000, text: 'hi', href: 'u' }];
  const none = RT.analyze({ place: null, sampleTimes: [], posts, myTz: 'UTC', now });
  assert.equal(none.used, 'none');
  assert.equal(none.posts.fresh, 'now');
  const loc = RT.analyze({ place: { name: 'Paris', timezone: 'Europe/Paris', precision: 3, country: 'France' }, sampleTimes: [], posts, myTz: 'UTC', now });
  assert.equal(loc.posts.latest[0].theirTime, 'Thu 12:55 PM'); // 11:55 UTC = 12:55 in Paris (UTC+1)
});

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
