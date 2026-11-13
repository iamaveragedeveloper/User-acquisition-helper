/*
 * Reach Timing - card renderer. Pure: takes plain data, returns an HTML string.
 * The same card is shown in the on-page panel and (via the content script) in the toolbar popup.
 *
 * Glance view (always visible):  who -> VERDICT -> your clock vs theirs -> four short rows -> save.
 * Everything that needs a sentence lives under "More details" (collapsed).
 */
(function (root) {
  'use strict';
  const RT = root.RT;

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SUN =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#8fa8ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function compactCount(n) {
    if (n == null) return null;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  const safeUrl = (u) => (/^(https?:|mailto:)/i.test(u || '') ? u : null);

  // ----------------------------------------------------- glance view

  function header(sc) {
    const initial = esc((sc.displayName || sc.handle || '?').trim().charAt(0).toUpperCase());
    const avatar = sc.avatar && /^https:\/\//.test(sc.avatar) ? sc.avatar : null;
    const av = avatar ? '<div class="av" style="background-image:url(\'' + esc(avatar) + '\')"></div>' : '<div class="av">' + initial + '</div>';
    const name = sc.displayName && sc.displayName !== sc.handle ? sc.displayName : '@' + sc.handle;
    return (
      '<div class="hd">' + av + '<div class="id"><b>' + esc(name) + '</b><span>@' + esc(sc.handle) + '</span></div>' +
      '<button class="ib" data-act="settings" title="Settings">⚙</button>' +
      '<button class="ib" data-act="toggle" title="Minimise">–</button></div>'
    );
  }

  /** The verdict: a short title and one short line. */
  function verdict(m) {
    const P = m.posts;
    const f = P && P.fresh && P.latest[0];
    if (f) {
      const justNow = P.fresh === 'now';
      const cta = f.href ? '<a class="cta" href="' + esc(f.href) + '" target="_blank" rel="noopener">Open their post ↗</a>' : '';
      return (
        '<div class="hero go"><b>' + (justNow ? 'Reply now' : 'Reply soon') + '</b>' +
        '<span>They posted ' + esc(f.ageText) + '. Reply, then send a DM.</span>' + cta + '</div>'
      );
    }
    if (m.used === 'none') {
      return '<div class="hero na"><b>Can’t tell</b><span>I can’t work out where they are. See More details.</span></div>';
    }
    const st = m.status;
    if (st.state === 'now') {
      return '<div class="hero go"><b>Message now</b><span>It’s ' + esc(m.their.clock) + ' for them.</span></div>';
    }
    if (st.state === 'later') {
      return '<div class="hero wait"><b>Wait</b><span>Try ' + esc(st.startsAtMine) + ' your time · in ' + RT.formatDuration(st.inMin) + '</span></div>';
    }
    return '<div class="hero na"><b>No good time</b><span>Change your message hours in settings.</span></div>';
  }

  function clockCard(kind, side) {
    if (!side) return '<div class="clock"><span class="lbl">Them</span><div class="time">—</div></div>';
    const [t, ap] = side.clock.split(' ');
    return (
      '<div class="clock ' + kind + '"><div class="top"><span class="lbl">' + (kind === 'me' ? 'You' : 'Them') + '</span>' + (side.daytime ? SUN : MOON) + '</div>' +
      '<div class="time">' + esc(t) + '<small>' + esc(ap) + '</small></div>' +
      '<div class="meta">' + esc(side.name) + ' · ' + esc(side.dow) + '</div></div>'
    );
  }

  function gap(m) {
    if (m.used === 'none') return '';
    const text = m.deltaText === 'same time as you' ? 'Same time as you' : 'They’re ' + m.deltaText;
    return '<div class="delta">' + esc(text) + '</div>';
  }

  const row = (k, v) => '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';

  /** Four short label / value rows. No sentences. */
  function facts(sc, m) {
    const P = m.posts;
    const rows = [];
    if (P && P.latest.length) {
      const l = P.latest[0];
      const link = l.href ? ' <a href="' + esc(l.href) + '" target="_blank" rel="noopener">open ↗</a>' : '';
      rows.push(row('Last post', '<span class="' + (P.fresh ? 'hot' : '') + '">' + esc(l.ageText) + '</span>' + link));
    } else rows.push(row('Last post', '<span class="muted">none found yet</span>'));

    if (m.used !== 'none') {
      const pt = P && P.pattern;
      if (!pt || !pt.enough) rows.push(row('Usually posts', '<span class="muted">scroll down for more</span>'));
      else if (!pt.usual.length) rows.push(row('Usually posts', '<span class="muted">no clear pattern</span>'));
      else {
        rows.push(row('Usually posts', esc(pt.usualMineList.join(' · ')) + ' <small>your time</small>'));
        if (pt.next && pt.next.inside) rows.push(row('Next post', '<span class="hot">likely soon</span>'));
        else if (pt.next) rows.push(row('Next post', 'in ' + RT.formatDuration(pt.next.inMin) + ' <small>' + esc(pt.next.mine) + '</small>'));
      }
    }
    rows.push(row('DMs', (sc.dmOpen ? '<span class="hot">Open</span>' : 'Look closed') + (sc.followsMe ? ' <small>follows you</small>' : '')));
    return '<div class="rows">' + rows.join('') + '</div>';
  }

  // ----------------------------------------------- more details

  function latestPosts(m) {
    const P = m.posts;
    let body;
    if (!P || !P.latest.length) body = '<div class="muted">No posts found yet. Scroll down their profile.</div>';
    else {
      body = P.latest
        .map((p) => {
          const when = (p.theirTime ? esc(p.theirTime) + ' there · ' : '') + esc(p.myTime) + ' for you';
          const inner =
            '<div class="ago">' + esc(p.ageText) + '</div><div class="pbody"><div class="ptxt">' + (p.text ? esc(p.text) : '<i>(no text)</i>') +
            '</div><div class="when">' + when + '</div></div>';
          return p.href ? '<a class="post" href="' + esc(p.href) + '" target="_blank" rel="noopener">' + inner + '</a>' : '<div class="post">' + inner + '</div>';
        })
        .join('');
    }
    return '<div class="block"><span class="lbl">Latest posts</span>' + body + '<div class="muted">Refresh X to check for new posts.</div></div>';
  }

  function routine(m) {
    if (m.used === 'none') return '';
    const P = m.posts;
    const pt = P && P.pattern;
    let body;
    if (!pt || !pt.enough) {
      const have = pt ? pt.have : 0;
      body = '<div class="muted">Scroll down their profile to load more posts. Found ' + have + ', need about 8.</div>';
    } else if (!pt.usual.length) body = '<div class="muted">No clear routine. They post at all sorts of times.</div>';
    else {
      body =
        '<div>Around <b>' + esc(pt.usualTheirsText) + '</b> their time</div><div>Around <b>' + esc(pt.usualMineText) + '</b> your time</div>' +
        (pt.perDayText ? '<div class="muted">' + esc(pt.perDayText.charAt(0).toUpperCase() + pt.perDayText.slice(1)) + '</div>' : '');
    }
    return (
      '<div class="block"><span class="lbl">When they usually post</span>' + body +
      '<div class="tip">Tip: when they post, reply to it first, then DM within about 5 minutes.</div></div>'
    );
  }

  function ticks(list) {
    return list
      .map((t) => {
        const x = (t.pos / 24) * 100;
        return '<span style="left:clamp(0px, calc(' + x.toFixed(2) + '% - 28px), calc(100% - 56px))">' + esc(t.label) + '</span>';
      })
      .join('');
  }

  function timeline(m) {
    const tl = m.timeline;
    if (!tl) return '';
    const mine = tl.cells.map((c) => '<div class="cell' + (c.myAwake ? ' day' : '') + (c.both ? ' both' : '') + '"></div>').join('');
    const theirs = tl.cells.map((c) => '<div class="cell' + (c.theirGood ? ' good' : c.theirNight ? '' : ' day') + (c.both ? ' both' : '') + '"></div>').join('');
    return (
      '<div class="block"><span class="lbl">Next 24 hours, you vs them</span>' +
      '<div class="tl-body" style="--p:' + tl.nowPct.toFixed(2) + '"><span class="nowtag">now</span><i class="nowline"></i>' +
      '<div class="tl-row"><span class="who">You</span><div class="track">' + mine + '</div></div>' +
      '<div class="tl-row"><span></span><div class="ticks">' + ticks(tl.myTicks) + '</div></div>' +
      '<div class="tl-row"><span class="who">Them</span><div class="track">' + theirs + '</div></div>' +
      '<div class="tl-row"><span></span><div class="ticks">' + ticks(tl.theirTicks) + '</div></div></div>' +
      '<div class="legend"><span><i style="background:#2a9d74"></i>good time to message them</span><span><i style="background:#11151b;border:1px solid #2a323d"></i>night</span>' +
      '<span><i style="box-shadow:0 0 0 1.5px #34d399 inset"></i>good for both of you</span></div></div>'
    );
  }

  function where(sc, m, ctx) {
    let line;
    if (!sc.location) line = '<span class="muted">No location on their profile.</span>';
    else if (ctx.placeState === 'loading') line = '<span class="muted">Looking up “' + esc(sc.location) + '”…</span>';
    else if (ctx.place) line = '<b>' + esc(RT.placeLabel(ctx.place)) + '</b> <span class="muted">(from “' + esc(sc.location) + '”)</span>';
    else if (ctx.placeState === 'error') line = '<span class="err">Couldn’t look up “' + esc(sc.location) + '”.</span>';
    else line = '<span class="muted">Couldn’t find “' + esc(sc.location) + '” on the map.</span>';

    let sure = '';
    if (m.used !== 'none') {
      const word = { High: 'Pretty sure', Medium: 'Fairly sure', Low: 'Not sure' }[m.confidence] || '';
      sure = '<div class="muted">' + word + ', ' + (m.used === 'location' ? 'based on the location on their profile.' : 'guessed from when they post.') + '</div>';
    }
    const switcher = m.canSwitch
      ? '<div><span class="link" data-act="switch">' + (m.used === 'location' ? 'Looks wrong? Use their posting hours instead' : 'Use the location on their profile instead') + '</span></div>'
      : '';
    const warn = m.conflict ? '<div class="note">Their profile location and posting hours don’t match. Double-check.</div>' : '';
    const good =
      m.used === 'none'
        ? ''
        : '<div class="muted">Good times to message: <b>' + esc(m.windowsMine) + '</b> your time (' + (m.windowSource === 'activity' ? 'based on when they post' : 'your usual hours') + ')</div>';
    return '<div class="block"><span class="lbl">Where they are</span><div>' + line + '</div>' + sure + switcher + warn + good + '</div>';
  }

  function about(sc) {
    const links = sc.links
      .filter((l) => safeUrl(l))
      .map((l) => '<a href="' + esc(l) + '" target="_blank" rel="noopener">' + esc(l.replace(/^(https?:\/\/(www\.)?|mailto:)/i, '').replace(/\/$/, '')) + '</a>');
    const bio = sc.bio ? '<div class="bio">' + esc(sc.bio.length > 200 ? sc.bio.slice(0, 200) + '…' : sc.bio) + '</div>' : '';
    const followers = sc.followers != null ? '<div class="muted">' + compactCount(sc.followers) + ' followers</div>' : '';
    return '<div class="block"><span class="lbl">About them</span>' + followers + (links.length ? '<div class="links">' + links.join('') + '</div>' : '') + bio + '</div>';
  }

  function moreSection(sc, m, ctx) {
    const btn = '<button class="morebtn" data-act="more">' + (ctx.more ? 'Hide details ▴' : 'More details ▾') + '</button>';
    if (!ctx.more) return '<div class="sec">' + btn + '</div>';
    return '<div class="sec">' + btn + latestPosts(m) + routine(m) + where(sc, m, ctx) + timeline(m) + about(sc) + '</div>';
  }

  // -------------------------------------------------------- notion

  function notion(ctx) {
    const n = ctx.notion;
    const cfg = ctx.settings.notionToken && ctx.settings.databaseId;
    if (!cfg) return '<button class="btn ghost" data-act="settings">Connect Notion (optional)</button>';
    let info = '';
    if (n.state === 'checking' || n.state === 'unknown') info = '<span class="muted">Checking Notion…</span>';
    else if (n.state === 'found') {
      info = '<span class="muted">In Notion' + (n.status ? ' · ' + esc(n.status) : '') + ' · <a href="' + esc(n.url) + '" target="_blank" rel="noopener">open</a></span>';
    } else if (n.state === 'error') info = '<span class="err">' + esc(n.error) + '</span>';

    const sv = ctx.save;
    let label = n.state === 'found' ? 'Update in Notion' : 'Save to Notion';
    if (sv.state === 'saving') label = 'Saving…';
    let result = '';
    if (sv.state === 'done') {
      const verb = sv.created ? 'Saved' : 'Updated';
      if (sv.wrote === 0) {
        result = '<div class="note">' + verb + ' the handle only. Add columns in settings to keep more. <span class="link" data-act="settings">Open settings</span></div>';
      } else {
        result = '<span class="muted">' + verb + ' ✓</span>';
        if (sv.missingCore && sv.missingCore.length) {
          result += '<div class="muted">No column for: ' + esc(sv.missingCore.join(', ')) + ' · <span class="link" data-act="settings">add</span></div>';
        }
      }
    } else if (sv.state === 'error') result = '<span class="err">' + esc(sv.error) + '</span>';
    return (
      (info ? '<div>' + info + '</div>' : '') +
      '<button class="btn" data-act="save"' + (sv.state === 'saving' ? ' disabled' : '') + '>' + label + '</button>' +
      (result ? '<div>' + result + '</div>' : '')
    );
  }

  // --------------------------------------------------------- cards

  function loading() {
    return '<div class="card"><div class="sec first"><span class="muted">Reading profile…</span></div></div>';
  }

  /** ctx: { sc, m, place, placeState, notion, save, settings, collapsed, more } */
  function card(ctx) {
    const { sc, m } = ctx;
    if (ctx.collapsed) {
      const fresh = m.posts && m.posts.fresh;
      const cls = fresh ? 'go' : m.used === 'none' ? '' : m.status.state === 'now' ? 'go' : 'wait';
      const t = fresh ? (fresh === 'now' ? 'reply now' : 'reply soon') : m.used === 'none' ? 'unknown' : m.status.state === 'now' ? 'message now' : 'wait';
      return '<div class="card"><div class="pillbar" data-act="toggle"><i class="dot ' + cls + '"></i><b>@' + esc(sc.handle) + '</b><span class="sub">' + esc(t) + '</span></div></div>';
    }
    return (
      '<div class="card">' + header(sc) +
      '<div class="sec first" style="padding-top:0">' + verdict(m) + '</div>' +
      '<div class="sec first" style="padding-top:0"><div class="clocks">' + clockCard('me', m.my) + clockCard('them', m.their) + '</div>' + gap(m) + '</div>' +
      '<div class="sec first" style="padding-top:0">' + facts(sc, m) + '</div>' +
      moreSection(sc, m, ctx) +
      '<div class="sec foot">' + notion(ctx) + '</div></div>'
    );
  }

  root.RT_UI = { card, loading };
})(self);
