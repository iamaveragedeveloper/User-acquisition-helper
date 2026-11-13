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
    settings: { notionToken: '', databaseId: '', myTz: defaultTz, windowsStr: RT.DEFAULT_WINDOWS, myAwake: RT.DEFAULT_AWAKE, useActivity: true, showPanel: true },
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
    more: false, // "More details" section open
    lastSig: '',
    model: null,
  };

  // ---------------------------------------------------------- settings

  function loadSettings() {
    return chrome.storage.local
      .get(['notionToken', 'databaseId', 'myTz', 'windowsStr', 'myAwake', 'useActivity', 'showPanel'])
      .then((s) => {
        S.settings = {
          notionToken: s.notionToken || '',
          databaseId: s.databaseId || '',
          myTz: s.myTz || defaultTz,
          windowsStr: s.windowsStr || RT.DEFAULT_WINDOWS,
          myAwake: s.myAwake || RT.DEFAULT_AWAKE,
          useActivity: s.useActivity !== false,
          showPanel: s.showPanel !== false,
        };
      })
      .catch(() => {});
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (['notionToken', 'databaseId', 'myTz', 'windowsStr', 'myAwake', 'useActivity', 'showPanel'].some((k) => k in changes)) {
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

    const avatarImg = $('[data-testid^="UserAvatar-Container"] img');
    const avatar = avatarImg && /^https:\/\//.test(avatarImg.src) ? avatarImg.src.replace(/_(normal|bigger|mini)\./, '_200x200.') : null;

    return {
      handle: exact,
      avatar,
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
      const path = link ? link.getAttribute('href') : null;
      const body = text($('[data-testid="tweetText"]', art));
      S.samples.set(path || String(ms), {
        ms,
        pinned: /pinned/i.test(text($('[data-testid="socialContext"]', art))),
        reply: /(^|\n)Replying to /.test(art.innerText || ''),
        text: body.replace(/\s+/g, ' ').slice(0, 140),
        href: path && path.startsWith('/') ? 'https://x.com' + path : null,
      });
    });
  }

  // --------------------------------------------------------------- panel

  let host = null;
  let shadow = null;

  const CSS = window.RT_CSS;

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

  function compute() {
    const now = new Date();
    const posts = Array.from(S.samples.values());
    return RT.analyze({
      place: S.place,
      posts,
      sampleTimes: posts.map((p) => p.ms),
      myTz: S.settings.myTz,
      windowsStr: S.settings.windowsStr,
      myAwakeStr: S.settings.myAwake,
      useActivity: S.settings.useActivity,
      source: S.source,
      now,
    });
  }

  /** The card's HTML. `popup` ignores the minimised state (the toolbar popup is always expanded). */
  function buildHtml(popup) {
    const sc = S.scraped;
    if (!sc) return RT_UI.loading();
    const m = (S.model = compute());
    return RT_UI.card({
      sc, m,
      place: S.place,
      placeState: S.placeState,
      notion: S.notion,
      save: S.save,
      settings: S.settings,
      collapsed: S.collapsed && !popup,
      more: S.more,
    });
  }

  function render() {
    if (!S.settings.showPanel) {
      if (host) removePanel();
      return;
    }
    ensurePanel();
    shadow.lastElementChild.innerHTML = buildHtml(false);
  }

  function handleAct(act) {
    if (act === 'toggle') S.collapsed = !S.collapsed;
    else if (act === 'more') S.more = !S.more;
    else if (act === 'settings') send({ type: 'open-options' });
    else if (act === 'switch') S.source = S.model && S.model.used === 'location' ? 'posts' : 'location';
    else if (act === 'save') doSave();
    S.lastSig = '';
    render();
  }

  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (el) handleAct(el.getAttribute('data-act'));
  }

  // The toolbar popup asks this tab for the same card and forwards its button clicks.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || (msg.type !== 'rt-snapshot' && msg.type !== 'rt-act')) return false;
    if (!routeHandle()) {
      sendResponse({ ok: false, reason: 'not-profile' });
      return false;
    }
    if (msg.type === 'rt-act' && msg.act !== 'toggle' && msg.act !== 'settings') handleAct(msg.act);
    tick();
    sendResponse({ ok: true, html: buildHtml(true) });
    return false;
  });

  // -------------------------------------------------------------- Notion

  function buildProfilePayload() {
    const sc = S.scraped;
    const m = S.model || compute();
    const times = Array.from(S.samples.values()).filter((p) => !p.pinned).map((p) => p.ms);
    const pat = m.posts && m.posts.pattern;
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
      usualTimes: pat && pat.usualMineText ? pat.usualMineText + ' (my time)' : null,
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
      S.save = { state: 'done', created: res.created, wrote: res.wrote, missingCore: res.missingCore || [] };
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
      S.samples.size, S.placeState, S.place && S.place.timezone, S.notion, S.save, S.source, S.collapsed, S.more,
      Math.floor(Date.now() / 30000), S.settings.myTz, S.settings.windowsStr, S.settings.myAwake, S.settings.useActivity, S.settings.showPanel,
    ]);
    if (sig !== S.lastSig || (S.settings.showPanel && (!host || !host.isConnected))) {
      S.lastSig = sig;
      render();
    }
  }

  loadSettings().then(() => {
    tick();
    setInterval(tick, TICK_MS);
  });
})();
