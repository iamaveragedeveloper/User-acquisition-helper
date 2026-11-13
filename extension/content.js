/*
 * Reach Timing - content script. Runs on x.com / twitter.com profile pages.
 * Reads what is already on the page you are looking at (no extra requests to X),
 * shows a small panel, and can push the lead to Notion with one click.
 */
(function () {
  'use strict';
  if (window.__reachTimingLoaded) return;
  window.__reachTimingLoaded = true;

  const RT = window.RT;
  const TICK_MS = 1500;

  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings', 'compose', 'login',
    'signup', 'tos', 'privacy', 'jobs', 'hashtag', 'intent', 'share', 'account', 'logout',
    'download', 'about', 'help', 'lists', 'bookmarks', 'communities', 'premium', 'grok',
  ]);
  const PROFILE_SUBPAGES = new Set(['with_replies', 'media', 'highlights', 'articles', 'superfollows']);

  // ------------------------------------------------------------- state

  const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const S = {
    settings: { notionToken: '', databaseId: '', myTz: defaultTz, windowsStr: RT.DEFAULT_WINDOWS, useActivity: true },
    handle: null,
    runId: 0,
    samples: new Map(),
    scraped: null,
    lastLocation: undefined,
    placeState: 'idle', // idle | loading | done | error
    place: null,
    notion: { state: 'unknown' }, // unknown | checking | off | missing | found | error
    save: { state: 'idle' }, // idle | saving | done | error
    source: 'auto',
    collapsed: false,
    lastSig: '',
    model: null,
  };

  // ---------------------------------------------------------- settings

  function loadSettings() {
    return chrome.storage.local
      .get(['notionToken', 'databaseId', 'myTz', 'windowsStr', 'useActivity'])
      .then((s) => {
        S.settings = {
          notionToken: s.notionToken || '',
          databaseId: s.databaseId || '',
          myTz: s.myTz || defaultTz,
          windowsStr: s.windowsStr || RT.DEFAULT_WINDOWS,
          useActivity: s.useActivity !== false,
        };
      })
      .catch(() => {});
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (['notionToken', 'databaseId', 'myTz', 'windowsStr', 'useActivity'].some((k) => k in changes)) {
      loadSettings().then(() => {
        if ('notionToken' in changes || 'databaseId' in changes) S.notion = { state: 'unknown' };
        S.lastSig = '';
      });
    }
  });

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e.message || e) }));
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'The extension was reloaded. Refresh this tab.' });
    }
  }

  // ------------------------------------------------------------ routing

  function routeHandle() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    if (RESERVED.has(parts[0].toLowerCase()) || !/^\w{1,15}$/.test(parts[0])) return null;
    if (parts.length > 1 && !PROFILE_SUBPAGES.has(parts[1])) return null;
    return parts[0];
  }

  // ----------------------------------------------------------- scraping

  const $ = (sel, root) => (root || document).querySelector(sel);
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');

  function collectLinks() {
    const out = [];
    const add = (txt) => {
      txt = String(txt || '').trim().replace(/…$/, '');
      if (/^https?:\/\//i.test(txt) && !out.includes(txt)) out.push(txt);
      else if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(txt)) {
        const u = 'https://' + txt;
        if (!out.includes(u)) out.push(u);
      }
    };
    const anchorUrl = (a) => {
      const title = a.getAttribute('title');
      return title && /^https?:\/\//i.test(title) ? title : text(a);
    };
    const urlEl = $('[data-testid="UserUrl"]');
    if (urlEl) {
      const a = urlEl.matches('a') ? urlEl : $('a', urlEl);
      add(a ? anchorUrl(a) : text(urlEl));
    }
    document.querySelectorAll('[data-testid="UserDescription"] a').forEach((a) => add(anchorUrl(a)));
    return out;
  }

  function scrapeProfile(handle) {
    const nameEl = $('[data-testid="UserName"]');
    if (!nameEl) return null;
    const nameText = text(nameEl);
    if (!nameText.toLowerCase().includes('@' + handle.toLowerCase())) return null; // stale DOM from the previous profile
    const lines = nameText.split('\n').map((s) => s.trim()).filter(Boolean);
    const exact = (nameText.match(/@(\w{1,15})/) || [])[1] || handle;

    let followers = null;
    for (const a of document.querySelectorAll('a[href$="/verified_followers"], a[href$="/followers"]')) {
      if (a.getAttribute('href').toLowerCase().startsWith('/' + handle.toLowerCase() + '/')) {
        followers = RT.parseCount(text(a));
        if (followers != null) break;
      }
    }

    const bio = text($('[data-testid="UserDescription"]'));
    const email = (bio.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || null;
    const links = collectLinks();
    if (email) links.push('mailto:' + email);

    return {
      handle: exact,
      displayName: lines[0] || exact,
      followsMe: /follows you/i.test(nameText),
      location: text($('[data-testid="UserLocation"]')),
      bio,
      links,
      followers,
      dmOpen: !!$('[data-testid="sendDMFromProfile"]'),
    };
  }

  function scanTweets(handle) {
    const lh = handle.toLowerCase();
    document.querySelectorAll('article[data-testid="tweet"]').forEach((art) => {
      const author = $('[data-testid="User-Name"] a[href^="/"]', art);
      if (!author || author.getAttribute('href').split('/')[1].toLowerCase() !== lh) return; // reposts, replies by others
      const time = $('time', art);
      if (!time) return;
      const ms = Date.parse(time.getAttribute('datetime'));
      if (Number.isNaN(ms)) return;
      const link = time.closest('a');
      S.samples.set(link ? link.getAttribute('href') : String(ms), ms);
    });
  }

  // --------------------------------------------------------------- panel

  let host = null;
  let shadow = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card { position: fixed; right: 16px; bottom: 16px; width: 320px; max-height: calc(100vh - 32px); overflow: auto;
      z-index: 2147483647; background: #15181c; color: #e7e9ea; border: 1px solid #2f3336; border-radius: 14px;
      font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.45); }
    .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2f3336; }
    .hd b { font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hd button { background: none; border: 0; color: #8b98a5; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 6px; }
    .bd { padding: 12px; display: grid; gap: 10px; }
    .big { font-size: 22px; font-weight: 700; letter-spacing: -.3px; }
    .sub { color: #8b98a5; font-size: 12px; }
    .pill { display: block; padding: 8px 10px; border-radius: 10px; font-weight: 600; }
    .pill.go { background: #0f3d2a; color: #6ee7a8; }
    .pill.wait { background: #3d2f0a; color: #fbd56a; }
    .pill.na { background: #23282d; color: #aab4bd; }
    .row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .badge { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; }
    .badge.High { background: #0f3d2a; color: #6ee7a8; }
    .badge.Medium { background: #3d2f0a; color: #fbd56a; }
    .badge.Low, .badge.None { background: #4a1d1d; color: #ff9b9b; }
    .warn { background: #3a2410; color: #ffc48a; padding: 6px 8px; border-radius: 8px; font-size: 12px; }
    .err { color: #ff8f8f; font-size: 12px; }
    .bars { display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; align-items: end; height: 44px; }
    .bar { background: #3b4650; border-radius: 2px 2px 0 0; min-height: 2px; }
    .bar.good { background: #2f8f64; }
    .bar.now { outline: 1px solid #fff; }
    .axis { display: grid; grid-template-columns: repeat(4, 1fr); color: #6b7782; font-size: 10px; }
    a, .link { color: #6cb6ff; cursor: pointer; text-decoration: none; }
    a:hover, .link:hover { text-decoration: underline; }
    .btn { width: 100%; padding: 9px 12px; border: 0; border-radius: 999px; background: #eff3f4; color: #0f1419;
      font-weight: 700; font-size: 13px; cursor: pointer; }
    .btn:disabled { opacity: .6; cursor: default; }
    .btn.ghost { background: #23282d; color: #e7e9ea; }
    .pillbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
    hr { border: 0; border-top: 1px solid #2f3336; margin: 0; }
  `;

  function ensurePanel() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'reach-timing-root';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const mount = document.createElement('div');
    shadow.append(style, mount);
    shadow.addEventListener('click', onClick);
    document.documentElement.appendChild(host);
  }

  function removePanel() {
    if (host) host.remove();
    host = shadow = null;
    S.lastSig = '';
  }

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function compute() {
    const now = new Date();
    return RT.analyze({
      place: S.place,
      sampleTimes: Array.from(S.samples.values()),
      myTz: S.settings.myTz,
      windowsStr: S.settings.windowsStr,
      useActivity: S.settings.useActivity,
      source: S.source,
      now,
    });
  }

  function statusPill(m) {
    if (m.used === 'none') {
      return '<span class="pill na">Can’t tell their timezone yet</span>';
    }
    const st = m.status;
    if (st.state === 'now') {
      return '<span class="pill go">Good time to message · ' + RT.formatDuration(st.endsInMin) + ' left</span>';
    }
    if (st.state === 'later') {
      return (
        '<span class="pill wait">Next window in ' + RT.formatDuration(st.inMin) + ' · ' +
        esc(st.startsAtMine) + ' your time</span>'
      );
    }
    return '<span class="pill na">No message window found</span>';
  }

  function heatmap(m) {
    const max = Math.max(1, ...m.hist);
    const goodHours = new Set();
    for (let h = 0; h < 24; h++) if (m.windows.some((w) => h * 60 >= w[0] && h * 60 < w[1])) goodHours.add(h);
    const bars = m.hist
      .map((c, h) => {
        const cls = 'bar' + (goodHours.has(h) ? ' good' : '') + (h === m.localHour ? ' now' : '');
        return '<div class="' + cls + '" title="' + h + ':00 – ' + c + ' posts" style="height:' + Math.max(4, (c / max) * 100) + '%"></div>';
      })
      .join('');
    return '<div class="bars">' + bars + '</div><div class="axis"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span></div>';
  }

  function locationBlock(sc, m) {
    let line;
    if (!sc.location) line = '<span class="sub">No location on this profile.</span>';
    else if (S.placeState === 'loading') line = '<span class="sub">Looking up “' + esc(sc.location) + '”…</span>';
    else if (S.place) {
      line =
        '<span class="sub">“' + esc(sc.location) + '” → ' + esc(RT.placeLabel(S.place)) + '</span>';
    } else if (S.placeState === 'error') line = '<span class="err">Couldn’t look up “' + esc(sc.location) + '”.</span>';
    else line = '<span class="sub">Couldn’t place “' + esc(sc.location) + '”.</span>';

    let src = '';
    if (m.used === 'location') src = 'Based on their self-reported location.';
    else if (m.used === 'posts') src = 'Estimated from when they post (' + m.inferred.n + ' posts).';
    if (m.canSwitch) {
      src += ' <span class="link" data-act="switch">Use ' + (m.used === 'location' ? 'posts' : 'location') + ' instead</span>';
    }
    let warn = '';
    if (m.conflict) {
      warn =
        '<div class="warn">Location says ' + RT.formatOffset(m.locOffsetMin) + ' but their posts look like ' +
        RT.formatOffset(m.inferred.offsetHours * 60) + '. Double-check before you rely on it.</div>';
    }
    return line + (src ? '<div class="sub">' + src + '</div>' : '') + warn;
  }

  function notionBlock() {
    const n = S.notion;
    const configured = S.settings.notionToken && S.settings.databaseId;
    if (!configured) {
      return '<button class="btn ghost" data-act="settings">Set up Notion</button>';
    }
    let info = '';
    if (n.state === 'checking' || n.state === 'unknown') info = '<span class="sub">Checking Notion…</span>';
    else if (n.state === 'found') {
      info =
        '<span class="sub">In Notion' + (n.status ? ' · ' + esc(n.status) : '') + ' · <a href="' + esc(n.url) +
        '" target="_blank" rel="noopener">open</a></span>';
    } else if (n.state === 'error') info = '<span class="err">' + esc(n.error) + '</span>';

    const sv = S.save;
    let label = n.state === 'found' ? 'Update in Notion' : 'Save to Notion';
    if (sv.state === 'saving') label = 'Saving…';
    let result = '';
    if (sv.state === 'done') {
      result = '<span class="sub">' + (sv.created ? 'Saved ✓' : 'Updated ✓') + '</span>';
    } else if (sv.state === 'error') result = '<span class="err">' + esc(sv.error) + '</span>';
    return (
      (info ? '<div>' + info + '</div>' : '') +
      '<button class="btn" data-act="save"' + (sv.state === 'saving' ? ' disabled' : '') + '>' + label + '</button>' +
      (result ? '<div>' + result + '</div>' : '')
    );
  }

  function render() {
    const sc = S.scraped;
    ensurePanel();
    const mount = shadow.lastElementChild;
    if (!sc) {
      mount.innerHTML = '<div class="card"><div class="hd"><b>Reach Timing</b></div><div class="bd"><span class="sub">Reading profile…</span></div></div>';
      return;
    }
    const m = (S.model = compute());

    if (S.collapsed) {
      const t = m.used === 'none' ? 'timezone unknown' : m.timeNow + (m.status.state === 'now' ? ' · good time' : '');
      mount.innerHTML =
        '<div class="card"><div class="pillbar" data-act="toggle"><b>@' + esc(sc.handle) + '</b><span class="sub">' + esc(t) + '</span></div></div>';
      return;
    }

    let timeBlock;
    if (m.used === 'none') {
      timeBlock = '<div class="sub">Scroll their posts to load more, or check that the location is a real place.</div>';
    } else {
      timeBlock =
        '<div><div class="row"><span class="big">' + esc(m.timeNow) + '</span><span class="badge ' + m.confidence + '">' + m.confidence +
        ' confidence</span></div><div class="sub">' + esc(m.offsetLabel) + ' · ' + esc(m.deltaText) + ' · ' + esc(m.greeting) +
        (m.weekend ? ' · weekend there' : '') + '</div></div>';
    }

    const windowsBlock =
      m.used === 'none'
        ? ''
        : '<div class="sub"><b>Best windows (your time):</b> ' + esc(m.windowsMine) + '<br>Their time: ' + esc(m.windowsTheirs) +
          ' · ' + (m.windowSource === 'activity' ? 'from when they post' : 'your default windows') + '</div>';

    const heat =
      m.used === 'none'
        ? ''
        : heatmap(m) + '<div class="sub">' + m.samples + ' posts sampled' +
          (m.samples < 8 ? ' (need 8+ for an estimate; scroll to load more)' : '') + '</div>';

    mount.innerHTML =
      '<div class="card">' +
      '<div class="hd"><b>@' + esc(sc.handle) + (sc.displayName && sc.displayName !== sc.handle ? ' · ' + esc(sc.displayName) : '') +
      '</b><button data-act="settings" title="Settings">⚙</button><button data-act="toggle" title="Minimise">–</button></div>' +
      '<div class="bd">' + timeBlock + statusPill(m) + locationBlock(sc, m) +
      (heat ? '<hr>' + heat : '') + windowsBlock + '<hr>' + notionBlock() + '</div></div>';
  }

  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.getAttribute('data-act');
    if (act === 'toggle') {
      S.collapsed = !S.collapsed;
      S.lastSig = '';
      render();
    } else if (act === 'settings') send({ type: 'open-options' });
    else if (act === 'switch') {
      S.source = S.model && S.model.used === 'location' ? 'posts' : 'location';
      S.lastSig = '';
      render();
    } else if (act === 'save') doSave();
  }

  // -------------------------------------------------------------- Notion

  function buildProfilePayload() {
    const sc = S.scraped;
    const m = S.model || compute();
    const times = Array.from(S.samples.values());
    return {
      handle: sc.handle,
      displayName: sc.displayName,
      url: 'https://x.com/' + sc.handle,
      location: sc.location || null,
      place: S.place ? RT.placeLabel(S.place) : null,
      timezone: m.used === 'none' ? null : m.zoneName,
      utcOffset: m.used === 'none' ? null : m.offsetMin / 60,
      theirTime: m.used === 'none' ? null : m.timeNow + ' (' + m.offsetLabel + ')',
      bestWindow: m.used === 'none' ? null : m.windowsMine + ' (my time)',
      confidence: m.used === 'none' ? null : m.confidence,
      bio: sc.bio || null,
      links: sc.links.length ? sc.links.join(', ') : null,
      followers: sc.followers,
      lastPost: times.length ? new Date(Math.max.apply(null, times)).toISOString() : null,
      dmOpen: sc.dmOpen,
      followsMe: sc.followsMe,
    };
  }

  async function doSave() {
    if (!S.scraped) return;
    const run = S.runId;
    S.save = { state: 'saving' };
    S.lastSig = '';
    render();
    const res = await send({ type: 'notion-save', profile: buildProfilePayload() });
    if (run !== S.runId) return;
    if (res && res.ok) {
      S.save = { state: 'done', created: res.created };
      S.notion = { state: 'found', url: res.url, status: res.status };
    } else {
      S.save = { state: 'error', error: (res && res.error) || 'Save failed.' };
    }
    S.lastSig = '';
    render();
  }

  async function lookupNotion(handle) {
    const run = S.runId;
    S.notion = { state: 'checking' };
    const res = await send({ type: 'notion-lookup', handle });
    if (run !== S.runId) return;
    if (!res || !res.ok) S.notion = { state: 'error', error: (res && res.error) || 'Notion lookup failed.' };
    else if (!res.configured) S.notion = { state: 'off' };
    else if (res.found) S.notion = { state: 'found', url: res.url, status: res.status };
    else S.notion = { state: 'missing' };
    S.lastSig = '';
  }

  async function lookupPlace(loc) {
    const run = S.runId;
    S.place = null;
    if (!loc) {
      S.placeState = 'done';
      return;
    }
    S.placeState = 'loading';
    const res = await send({ type: 'geocode', location: loc });
    if (run !== S.runId) return;
    if (res && res.ok) {
      S.place = res.place || null;
      S.placeState = 'done';
    } else S.placeState = 'error';
    S.lastSig = '';
  }

  // ---------------------------------------------------------------- loop

  function resetFor(handle) {
    S.runId++;
    S.handle = handle;
    S.samples = new Map();
    S.scraped = null;
    S.lastLocation = undefined;
    S.place = null;
    S.placeState = 'idle';
    S.notion = { state: 'unknown' };
    S.save = { state: 'idle' };
    S.source = 'auto';
    S.lastSig = '';
  }

  function tick() {
    const handle = routeHandle();
    if (!handle) {
      if (S.handle) {
        S.handle = null;
        S.runId++;
      }
      removePanel();
      return;
    }
    if (handle !== S.handle) resetFor(handle);

    const sc = scrapeProfile(handle);
    if (sc) {
      S.scraped = sc;
      scanTweets(handle);
      if (sc.location !== S.lastLocation) {
        S.lastLocation = sc.location;
        lookupPlace(sc.location);
      }
      if (S.notion.state === 'unknown' && S.settings.notionToken && S.settings.databaseId) lookupNotion(sc.handle);
      else if (S.notion.state === 'unknown' && !(S.settings.notionToken && S.settings.databaseId)) S.notion = { state: 'off' };
    }

    const sig = JSON.stringify([
      S.handle, sc && [sc.displayName, sc.location, sc.bio, sc.followers, sc.dmOpen, sc.followsMe, sc.links],
      S.samples.size, S.placeState, S.place && S.place.timezone, S.notion, S.save, S.source, S.collapsed,
      Math.floor(Date.now() / 30000), S.settings.myTz, S.settings.windowsStr, S.settings.useActivity,
    ]);
    if (sig !== S.lastSig || !host || !host.isConnected) {
      S.lastSig = sig;
      render();
    }
  }

  loadSettings().then(() => {
    tick();
    setInterval(tick, TICK_MS);
  });
})();
