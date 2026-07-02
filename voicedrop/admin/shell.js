// VoiceDrop admin shell — the chrome every /voicedrop/admin page shares.
//
// One copy of: the water-drop logo, the appbar nav (概览 · 举报 · 账本 · 挖文 ·
// LLM), the token gate, and the token lifecycle (localStorage vd_admin_token,
// showGate / logout / enter, 刷新 / 退出 wiring). The five pages used to carry
// a hand-copied version of all of it — adding a nav tab meant editing 5 files.
//
// Page contract (load AFTER shared.js, BEFORE the page's own script):
//   <body> contains <div id="app" hidden><div class="wrap">…page content…</div></div>
//   VDAdmin.init({
//     active:  'usage',                    // which nav tab highlights
//     title:   '算力账本',                  // gate headline
//     intro:   '输入 master token …',       // gate description
//     onEnter: load,                       // called once authed (boot/load)
//     onRefresh: load,                     // 刷新 button (defaults to onEnter)
//   });
//   VDAdmin.token()     → current token for Authorization headers
//   VDAdmin.logout(msg) → clear token, show the gate again (e.g. on 401/403)

(function () {
  const TKEY = 'vd_admin_token';           // shared across /admin — token carries over
  let TOKEN = localStorage.getItem(TKEY) || '';
  let opts = {};

  const TABS = [
    ['./',             '概览',    'index'],
    ['./reports.html', '举报审核', 'reports'],
    ['./usage.html',   '算力账本', 'usage'],
    ['./mine.html',    '挖文日志', 'mine'],
    ['./llm.html',     'LLM 日志', 'llm'],
  ];

  // The water-drop mark (gradient id must be unique per instance on the page).
  const mark = (cls, gid) =>
    `<svg class="${cls}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E8714F"/><stop offset="1" stop-color="#C5431F"/></linearGradient></defs><path d="M16 2.5C16 2.5 6 13 6 20.2 6 25.9 10.5 30 16 30s10-4.1 10-9.8C26 13 16 2.5 16 2.5Z" fill="url(#${gid})"/><circle cx="12.2" cy="20.6" r="3" fill="#fff" opacity="0.34"/></svg>`;

  function gateHtml() {
    return `
      ${mark('gate-mark', 'vdGate')}
      <h1>${esc(opts.title || 'VoiceDrop 控制台')}</h1>
      <p>${esc(opts.intro || '输入 master token 进入。token 只存在本机浏览器，不上传。')}</p>
      <input id="tok" type="password" placeholder="FILES_TOKEN" autocomplete="off" spellcheck="false"/>
      <div class="err" id="gateErr"></div>
      <button class="btn primary block" id="enter">进入</button>`;
  }

  function appbarHtml() {
    const tabs = TABS.map(([href, label, key]) =>
      `<a class="nav-tab${key === opts.active ? ' active' : ''}" href="${href}">${label}</a>`).join('\n        ');
    return `
    <div class="appbar-in">
      <a class="brand" href="./">
        ${mark('mark', 'vdNav')}
        <span class="name">VoiceDrop</span><span class="sub">控制台</span>
      </a>
      <div class="nav-tabs">
        ${tabs}
      </div>
      <div class="nav-actions">
        <button class="btn ghost" id="refresh">刷新</button>
        <button class="btn ghost" id="logout">退出</button>
      </div>
    </div>`;
  }

  function showGate(msg) {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    $('#gateErr').textContent = msg || '';
    $('#tok').focus();
  }

  function logout(msg) {
    TOKEN = '';
    localStorage.removeItem(TKEY);
    showGate(msg);
  }

  function boot() {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    opts.onEnter && opts.onEnter();
  }

  function enter() {
    const v = $('#tok').value.trim();
    if (!v) { $('#gateErr').textContent = '请输入 token'; return; }
    TOKEN = v;
    localStorage.setItem(TKEY, v);
    boot();
  }

  function init(o) {
    opts = o || {};

    // Inject the gate before #app, and the appbar as #app's first child.
    const app = $('#app');
    const gate = el('div', null, gateHtml());
    gate.id = 'gate';
    gate.hidden = true;
    gate.style.maxWidth = '430px';
    app.parentNode.insertBefore(gate, app);

    const nav = el('nav', 'appbar', appbarHtml());
    app.insertBefore(nav, app.firstChild);

    $('#enter').addEventListener('click', enter);
    $('#tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
    $('#logout').addEventListener('click', () => logout());
    $('#refresh').addEventListener('click', () => (opts.onRefresh || opts.onEnter || (() => {}))());

    if (TOKEN) boot(); else showGate();
  }

  window.VDAdmin = { init, token: () => TOKEN, logout, showGate };
})();
