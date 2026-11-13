/*
 * Toolbar popup: shows the same card as the on-page panel for the current tab.
 * The content script on the X tab owns all the data; this page only displays its HTML and forwards clicks.
 * Works with no Notion token at all.
 */
const msgEl = document.getElementById('msg');
const rootEl = document.getElementById('root');
const shadow = rootEl.attachShadow({ mode: 'open' });
const style = document.createElement('style');
// the card is shared with the on-page panel; in the popup it fills the window instead of floating
style.textContent =
  self.RT_CSS +
  '.card{position:static;width:auto;max-height:none;overflow:visible;border:0;border-radius:0;box-shadow:none}' +
  '[data-act="toggle"]{display:none}';
const mount = document.createElement('div');
shadow.append(style, mount);

let tabId = null;
let lastHtml = '';
let timer = null;

function showMessage(html) {
  rootEl.hidden = true;
  msgEl.hidden = false;
  msgEl.innerHTML = html;
}

function show(html) {
  msgEl.hidden = true;
  rootEl.hidden = false;
  if (html !== lastHtml) {
    lastHtml = html;
    mount.innerHTML = html;
  }
}

async function ask(msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    return null; // no content script in that tab
  }
}

async function refresh(msg) {
  const res = await ask(msg || { type: 'rt-snapshot' });
  if (!res) {
    clearInterval(timer);
    return showMessage('Open an <b>x.com</b> profile and click the icon again.<br>If you already have one open, refresh that tab once (the extension was installed or reloaded after it loaded).');
  }
  if (!res.ok) {
    return showMessage('This isn’t a profile page. Open someone’s profile on <b>x.com</b>, then click the icon.');
  }
  show(res.html);
}

shadow.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  if (act === 'settings') {
    chrome.runtime.openOptionsPage();
    return;
  }
  refresh({ type: 'rt-act', act });
});

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return showMessage('No active tab.');
  tabId = tab.id;
  await refresh();
  // keep the clock and a running save fresh while the popup is open
  timer = setInterval(() => refresh(), 1000);
})();
