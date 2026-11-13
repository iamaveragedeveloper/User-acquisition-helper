/*
 * Reach Timing - core logic (no DOM, no chrome.* APIs, so it can be unit-tested in node).
 * Loaded by the content script, the service worker (importScripts) and the tests.
 */
(function (root) {
  'use strict';

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DEFAULT_WINDOWS = '09:00-11:30, 18:00-21:00';

  // ---------------------------------------------------------------- zones

  const dtfCache = new Map();
  function dtf(tz) {
    let f = dtfCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      });
      dtfCache.set(tz, f);
    }
    return f;
  }

  /** zone is {iana: 'Asia/Kolkata'} or {fixed: minutesFromUTC}. */
  function localParts(zone, date) {
    if (zone.fixed != null) {
      const d = new Date(date.getTime() + zone.fixed * 60000);
      return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        weekday: d.getUTCDay(),
        offsetMin: zone.fixed,
      };
    }
    const o = {};
    for (const p of dtf(zone.iana).formatToParts(date)) o[p.type] = p.value;
    const hour = Number(o.hour) % 24;
    const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, hour, +o.minute, +o.second);
    const offsetMin = Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
    return {
      year: +o.year,
      month: +o.month,
      day: +o.day,
      hour,
      minute: +o.minute,
      weekday: WEEKDAYS.indexOf(o.weekday),
      offsetMin,
    };
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function fmtClock(hour, minute) {
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return h12 + ':' + pad(minute) + ' ' + ampm;
  }

  /** "Thu 9:40 AM" */
  function formatTime(zone, date) {
    const p = localParts(zone, date);
    return WEEKDAYS[p.weekday] + ' ' + fmtClock(p.hour, p.minute);
  }

  /** "UTC+5:30", "UTC-8" */
  function formatOffset(min) {
    const sign = min < 0 ? '-' : '+';
    const a = Math.abs(min);
    const h = Math.floor(a / 60);
    const m = a % 60;
    return 'UTC' + sign + h + (m ? ':' + pad(m) : '');
  }

  function formatDuration(min) {
    min = Math.max(0, Math.round(min));
    const d = Math.floor(min / 1440);
    const h = Math.floor((min % 1440) / 60);
    const m = min % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h' + (m ? ' ' + m + 'm' : '');
    return m + 'm';
  }

  /** Human text for how far their clock is from mine. */
  function describeDelta(theirOffsetMin, myOffsetMin) {
    const d = theirOffsetMin - myOffsetMin;
    if (d === 0) return 'same time as you';
    return formatDuration(Math.abs(d)) + (d > 0 ? ' ahead of you' : ' behind you');
  }

  function greetingFor(hour) {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'late night';
  }

  // -------------------------------------------------------------- windows

  function toMin(hhmm) {
    const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(hhmm.trim());
    if (!m) return null;
    const h = +m[1];
    const mm = m[2] ? +m[2] : 0;
    if (h > 24 || mm > 59) return null;
    return h * 60 + mm;
  }

  /** "09:00-11:30, 18:00-21:00" -> [[540,690],[1080,1260]] (minutes of local day). */
  function parseWindows(str) {
    const out = [];
    for (const part of String(str || '').split(',')) {
      const m = /^\s*([\d:]+)\s*[-–]\s*([\d:]+)\s*$/.exec(part);
      if (!m) continue;
      const a = toMin(m[1]);
      const b = toMin(m[2]);
      if (a == null || b == null || a === b) continue;
      if (b > a) out.push([a, b]);
      else {
        out.push([a, 1440]);
        if (b > 0) out.push([0, b]);
      }
    }
    return out.length ? out : parseWindows(DEFAULT_WINDOWS);
  }

  /** Activity histogram (24 local hours) -> awake-hours windows where they post most. */
  function windowsFromHist(hist) {
    const total = hist.reduce((a, b) => a + b, 0);
    if (total < 10) return null;
    const s = hist.map((_, h) => hist[(h + 23) % 24] + 2 * hist[h] + hist[(h + 1) % 24]);
    const max = Math.max.apply(null, s);
    if (max === 0) return null;
    const good = s.map((v, h) => h >= 7 && h < 23 && v >= 0.5 * max);
    const out = [];
    let start = null;
    for (let h = 0; h <= 24; h++) {
      if (h < 24 && good[h]) {
        if (start == null) start = h;
      } else if (start != null) {
        out.push([start * 60, h * 60]);
        start = null;
      }
    }
    return out.length ? out : null;
  }

  function inWindows(min, windows) {
    for (const w of windows) if (min >= w[0] && min < w[1]) return w;
    return null;
  }

  /** Where are we relative to their windows? Searches up to 48h ahead. */
  function windowStatus(zone, windows, now) {
    if (!windows.length) return { state: 'none' };
    const lp = localParts(zone, now);
    const nowMin = lp.hour * 60 + lp.minute;
    const cur = inWindows(nowMin, windows);
    if (cur) {
      let endsIn = cur[1] - nowMin;
      // window may continue after midnight (e.g. 22:00-24:00 then 00:00-01:00)
      if (cur[1] === 1440) {
        const next = windows.find((w) => w[0] === 0);
        if (next) endsIn += next[1];
      }
      return { state: 'now', endsInMin: endsIn };
    }
    const COARSE = 5;
    for (let k = 1; k <= (48 * 60) / COARSE; k++) {
      const t = new Date(now.getTime() + k * COARSE * 60000);
      const p = localParts(zone, t);
      if (inWindows(p.hour * 60 + p.minute, windows)) {
        // refine to the minute
        for (let m = (k - 1) * COARSE + 1; m <= k * COARSE; m++) {
          const t2 = new Date(now.getTime() + m * 60000);
          const p2 = localParts(zone, t2);
          if (inWindows(p2.hour * 60 + p2.minute, windows)) {
            return { state: 'later', inMin: m, startsAt: t2 };
          }
        }
      }
    }
    return { state: 'none' };
  }

  /** Express their-local windows in *my* clock, e.g. "9:30 PM-12:00 AM, 7:30 AM-9:30 AM". */
  function windowsInMyTime(windows, theirOffsetMin, myOffsetMin) {
    const shift = myOffsetMin - theirOffsetMin;
    const f = (m) => {
      const mm = (((m + shift) % 1440) + 1440) % 1440;
      return fmtClock(Math.floor(mm / 60), mm % 60);
    };
    return windows.map((w) => f(w[0]) + '–' + f(w[1])).join(', ');
  }

  function windowsInTheirTime(windows) {
    const f = (m) => fmtClock(Math.floor((m % 1440) / 60), m % 60);
    return windows.map((w) => f(w[0]) + '–' + f(w[1])).join(', ');
  }

  // ------------------------------------------------- timezone from posts

  /**
   * Estimate the UTC offset (whole hours) from the UTC times of someone's posts: people sleep,
   * so the offset that puts the quietest stretch at ~01:00-05:59 local is the best guess.
   */
  function inferOffsetFromPosts(times) {
    const n = times.length;
    if (n < 8) return { n, level: 'none' };
    const c = new Array(24).fill(0);
    for (const t of times) c[new Date(t).getUTCHours()]++;
    let best = null;
    for (let o = -11; o <= 14; o++) {
      let sleep = 0;
      let active = 0;
      for (let lh = 0; lh < 24; lh++) {
        const count = c[(((lh - o) % 24) + 24) % 24];
        if (lh >= 1 && lh <= 5) sleep += count;
        if (lh >= 9 && lh <= 22) active += count;
      }
      const score = sleep * 2 - active;
      if (!best || score < best.score) best = { o, score, sleep };
    }
    return {
      n,
      level: n >= 20 ? 'good' : 'rough',
      offsetHours: best.o,
      sleepShare: best.sleep / n,
    };
  }

  function circDiffHours(a, b) {
    const d = Math.abs(a - b) % 24;
    return Math.min(d, 24 - d);
  }

  // ---------------------------------------------------- location parsing

  const STOP = new Set([
    'earth', 'worldwide', 'global', 'remote', 'internet', 'online', 'everywhere', 'anywhere',
    'planet earth', 'the internet', 'web', 'cloud', 'metaverse', 'mars', 'moon', 'here',
    'somewhere', 'nowhere', 'home', 'world', 'universe', 'twitter', 'x', 'dm', 'dms', 'open',
    'tbd', 'wfh', 'the', 'a', 'and', 'in', 'based', 'planet', 'multiverse', 'online.',
  ]);

  const ALIASES = {
    nyc: 'New York', ny: 'New York', sf: 'San Francisco', sfo: 'San Francisco',
    'bay area': 'San Francisco', 'silicon valley': 'San Jose', la: 'Los Angeles',
    dc: 'Washington', 'washington dc': 'Washington', 'washington, d.c.': 'Washington',
    uk: 'United Kingdom', 'u.k.': 'United Kingdom', usa: 'United States', us: 'United States',
    'u.s.': 'United States', 'u.s.a.': 'United States', uae: 'United Arab Emirates',
    ksa: 'Saudi Arabia', nz: 'New Zealand', bangalore: 'Bengaluru', bombay: 'Mumbai',
    'new delhi': 'Delhi', ncr: 'Delhi', 'ho chi minh': 'Ho Chi Minh City', saigon: 'Ho Chi Minh City',
    'the netherlands': 'Netherlands', 'the uk': 'United Kingdom', 'the us': 'United States',
  };

  const US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
    IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
    ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
    WI: 'Wisconsin', WY: 'Wyoming',
  };
  const CA_PROVINCES = {
    ON: 'Ontario', BC: 'British Columbia', AB: 'Alberta', QC: 'Quebec', NS: 'Nova Scotia',
    NB: 'New Brunswick', MB: 'Manitoba', SK: 'Saskatchewan', PE: 'Prince Edward Island',
    NL: 'Newfoundland and Labrador',
  };

  /** Countries whose territory spans several timezones: a country-only location is ambiguous. */
  const MULTI_TZ = new Set(['US', 'CA', 'RU', 'BR', 'AU', 'MX', 'ID', 'KZ', 'CD', 'MN', 'CL']);

  function flagCountry(raw) {
    const m = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/u.exec(raw);
    if (!m) return null;
    const a = m[1].codePointAt(0) - 0x1f1e6 + 65;
    const b = m[2].codePointAt(0) - 0x1f1e6 + 65;
    return String.fromCharCode(a, b);
  }

  /**
   * Turn the free-text location into a geocoding plan:
   *   { queries: ['Austin'], hints: ['texas', 'united states'], flag: 'IN' | null }
   */
  function parseLocation(raw) {
    raw = String(raw || '');
    const flag = flagCountry(raw);
    let text = raw
      .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, ' ')
      .replace(/[\p{Extended_Pictographic}️‍]/gu, ' ')
      .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, ' ');
    const rawTokens = text
      .split(/[,;|/·•\n()]+|\s[-–—]\s|\s&\s|\s\+\s/)
      .map((t) => t.trim().replace(/^[.\-–—]+|[.\-–—]+$/g, '').trim())
      .filter(Boolean);

    const queries = [];
    const hints = [];
    rawTokens.forEach((tok, i) => {
      const low = tok.toLowerCase();
      if (STOP.has(low) || tok.length < 2) return;
      // US state / Canadian province abbreviation after a city -> hint, not a query
      if (i > 0 && /^[A-Z]{2}$/.test(tok)) {
        if (US_STATES[tok]) {
          hints.push(US_STATES[tok].toLowerCase(), 'united states');
          return;
        }
        if (CA_PROVINCES[tok]) {
          hints.push(CA_PROVINCES[tok].toLowerCase(), 'canada');
          return;
        }
        if (!ALIASES[low]) {
          hints.push(low); // probably an ISO country code
          return;
        }
      }
      const alias = ALIASES[low];
      const val = alias || tok;
      if (queries.length === 0) queries.push(val);
      else {
        queries.push(val);
        hints.push(val.toLowerCase());
      }
    });
    // a plain name may also be a country-ish hint for later tokens, keep every token as fallback query
    return { queries: queries.slice(0, 3), hints, flag };
  }

  /** Pick the best Open-Meteo geocoding result for the parsed hints. */
  function pickPlace(results, plan, query) {
    if (!results || !results.length) return null;
    const hints = new Set(plan.hints);
    if (plan.flag) hints.add(plan.flag.toLowerCase());
    const qlow = String(query || '').toLowerCase();
    let best = null;
    for (const r of results) {
      if (!r.timezone) continue;
      let score = 0;
      const country = (r.country || '').toLowerCase();
      const cc = (r.country_code || '').toLowerCase();
      const admin1 = (r.admin1 || '').toLowerCase();
      if (hints.has(country)) score += 3;
      if (hints.has(cc)) score += 2;
      if (hints.has(admin1)) score += 3;
      if (String(r.feature_code || '').startsWith('PCL') && (r.name || '').toLowerCase() === qlow) score += 4;
      if ((r.name || '').toLowerCase() === qlow) score += 1;
      score += Math.min(2, Math.log10((r.population || 0) + 1) / 4);
      if (!best || score > best.score) best = { score, r };
    }
    if (!best) return null;
    const r = best.r;
    const fc = String(r.feature_code || '');
    const countryLevel = fc.startsWith('PCL');
    let precision = 3; // 3 = city / single-timezone country, 2 = region, 1 = multi-tz country
    if (countryLevel) precision = MULTI_TZ.has(r.country_code) ? 1 : 3;
    else if (fc.startsWith('ADM')) precision = MULTI_TZ.has(r.country_code) ? 2 : 3;
    return {
      name: r.name,
      admin1: r.admin1 || null,
      country: r.country || null,
      countryCode: r.country_code || null,
      timezone: r.timezone,
      featureCode: fc,
      precision,
    };
  }

  function placeLabel(p) {
    if (!p) return '';
    return [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : null, p.country]
      .filter(Boolean)
      .join(', ');
  }

  // ------------------------------------------------------------- analysis

  /**
   * Everything the panel (and the Notion save) needs, from raw inputs.
   * input: { place, sampleTimes[ms], myTz, windowsStr, useActivity, source, now }
   */
  function analyze(input) {
    const now = input.now || new Date();
    const myZone = { iana: input.myTz };
    const myLp = localParts(myZone, now);
    const times = input.sampleTimes || [];
    const inferred = inferOffsetFromPosts(times);
    const place = input.place && input.place.timezone ? input.place : null;
    const locZone = place ? { iana: place.timezone } : null;

    let agree = false;
    let conflict = false;
    let locOffsetMin = null;
    if (locZone) {
      locOffsetMin = localParts(locZone, now).offsetMin;
      if (inferred.level !== 'none') {
        const diff = circDiffHours(locOffsetMin / 60, inferred.offsetHours);
        agree = diff <= 1.5;
        conflict = diff >= 3;
      }
    }

    let used = input.source || 'auto';
    const hasPosts = inferred.level !== 'none';
    if (used === 'auto') used = locZone ? 'location' : hasPosts ? 'posts' : 'none';
    if (used === 'posts' && !hasPosts) used = locZone ? 'location' : 'none';
    if (used === 'location' && !locZone) used = hasPosts ? 'posts' : 'none';

    const out = {
      used,
      inferred,
      conflict,
      agree,
      place,
      locOffsetMin,
      myOffsetMin: myLp.offsetMin,
      samples: times.length,
      canSwitch: !!(locZone && hasPosts),
    };
    if (used === 'none') {
      out.zone = null;
      out.confidence = 'None';
      return out;
    }

    const zone = used === 'location' ? locZone : { fixed: inferred.offsetHours * 60 };
    const lp = localParts(zone, now);
    out.zone = zone;
    out.zoneName = used === 'location' ? place.timezone : formatOffset(lp.offsetMin) + ' (estimated)';
    out.offsetMin = lp.offsetMin;
    out.offsetLabel = formatOffset(lp.offsetMin);
    out.timeNow = formatTime(zone, now);
    out.deltaText = describeDelta(lp.offsetMin, myLp.offsetMin);
    out.greeting = greetingFor(lp.hour);
    out.weekend = lp.weekday === 0 || lp.weekday === 6;
    out.localHour = lp.hour;

    // confidence
    let score;
    if (used === 'location') {
      score = place.precision >= 3 ? 3 : place.precision === 2 ? 2 : 1;
      if (hasPosts) {
        if (agree) score = Math.min(3, score + 1);
        else if (conflict) score = Math.max(1, score - 2);
      }
    } else {
      score = inferred.level === 'good' ? 2 : 1;
    }
    out.confidence = score >= 3 ? 'High' : score === 2 ? 'Medium' : 'Low';

    // posting histogram by *their* local hour
    const hist = new Array(24).fill(0);
    for (const t of times) hist[localParts(zone, new Date(t)).hour]++;
    out.hist = hist;

    // windows
    let windows = null;
    out.windowSource = 'default';
    if (input.useActivity !== false) {
      windows = windowsFromHist(hist);
      if (windows) out.windowSource = 'activity';
    }
    if (!windows) windows = parseWindows(input.windowsStr);
    out.windows = windows;
    out.windowsMine = windowsInMyTime(windows, lp.offsetMin, myLp.offsetMin);
    out.windowsTheirs = windowsInTheirTime(windows);
    out.status = windowStatus(zone, windows, now);
    if (out.status.state === 'later') {
      out.status.startsAtMine = formatTime(myZone, out.status.startsAt);
      out.status.startsAtTheirs = formatTime(zone, out.status.startsAt);
    }
    return out;
  }

  // ------------------------------------------------------------- helpers

  /** "12.3K", "1,234", "4.5M" -> number */
  function parseCount(text) {
    const m = /([\d][\d.,]*)\s*([KMB])?/i.exec(String(text || ''));
    if (!m) return null;
    const suffix = (m[2] || '').toUpperCase();
    // with a K/M/B suffix '.' is the decimal point ("1.2M"); without, separators are thousands ("1,234")
    const v = suffix ? parseFloat(m[1].replace(/,/g, '')) : parseFloat(m[1].replace(/[,.]/g, ''));
    if (Number.isNaN(v)) return null;
    return Math.round(v * ({ K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1));
  }

  const api = {
    DEFAULT_WINDOWS, WEEKDAYS,
    localParts, formatTime, formatOffset, formatDuration, describeDelta, greetingFor, fmtClock,
    parseWindows, windowsFromHist, windowStatus, windowsInMyTime, windowsInTheirTime,
    inferOffsetFromPosts, circDiffHours,
    parseLocation, pickPlace, placeLabel, flagCountry,
    analyze, parseCount,
  };
  root.RT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
