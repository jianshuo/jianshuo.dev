// Shared plumbing for the two log pages (llm.html · mine.html).
//
// Both are the same two-pane viewer: pick a date → page through the R2 log
// listing → download records 8-at-a-time → render a row list on the left and
// a detail pane on the right. That pipeline (api/encKey/fmtTime/loadDay/
// fetchRecords/select/loadDates/boot/refresh wiring) used to be hand-copied in
// both files and had already drifted. Pages provide ONLY what differs:
//
//   LogViewer.init({
//     log:        'llmlog' | 'minelog',      // list/dates endpoint prefix
//     active, title, intro,                  // passed through to VDAdmin.init
//     emptyText:  '还没有日志',                // no-dates message
//     prepare(records),                      // optional in-place ordering
//     renderList(records),                   // fill #list (rows carry data-i),
//                                            //   then call LogViewer.bindRows()
//     renderDetail(record),                  // fill #detail for one record
//   });
//
// Requires shared.js ($ / esc) and shell.js (VDAdmin) loaded first.

(function () {
  let cfg = {};
  let RECORDS = [];

  const encKey = (k) => k.split('/').map(encodeURIComponent).join('/');

  async function api(path) {
    const r = await fetch(`/files/api/${path}`, { headers: { Authorization: `Bearer ${VDAdmin.token()}` } });
    if (!r.ok) { let m = ''; try { m = (await r.json()).error || ''; } catch {} throw new Error(m || `HTTP ${r.status}`); }
    return r.json();
  }

  function fmtTime(ts) {
    const d = new Date(ts); const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // Load one day: fetch all listing pages, download the records, hand to the page.
  async function loadDay(date) {
    $('#list').innerHTML = `<div class="loading"><span class="spin"></span>加载 ${date} …</div>`;
    let objects = [], cursor = null;
    do {
      const q = `${cfg.log}/list?date=${encodeURIComponent(date)}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const r = await api(q);
      objects = objects.concat(r.objects || []);
      cursor = r.cursor;
    } while (cursor);
    RECORDS = await fetchRecords(objects);
    if (cfg.prepare) cfg.prepare(RECORDS);
    cfg.renderList(RECORDS);
  }

  async function fetchRecords(objects) {
    const out = []; const CONC = 8;
    for (let i = 0; i < objects.length; i += CONC) {
      const batch = objects.slice(i, i + CONC).map(async (o) => {
        try { const rec = await api(`download/${encKey(o.key)}`); rec._key = o.key; return rec; }
        catch { return { _key: o.key, _broken: true, ts: 0 }; }
      });
      out.push(...await Promise.all(batch));
    }
    return out;
  }

  function select(i, row) {
    $('#list').querySelectorAll('.row.sel').forEach((e) => e.classList.remove('sel'));
    if (row) row.classList.add('sel');
    cfg.renderDetail(RECORDS[i]);
  }

  // Call after renderList: binds click → select on every .row (data-i = index).
  function bindRows() {
    $('#list').querySelectorAll('.row').forEach((e) => e.addEventListener('click', () => select(+e.dataset.i, e)));
  }

  async function loadDates() {
    const { dates } = await api(`${cfg.log}/dates`);
    const sel = $('#date');
    if (!dates || !dates.length) {
      sel.innerHTML = `<option>无数据</option>`;
      $('#list').innerHTML = `<div class="empty-state">${esc(cfg.emptyText || '还没有日志')}</div>`;
      return;
    }
    sel.innerHTML = dates.map((d) => `<option value="${d}">${d}</option>`).join('');
    sel.value = dates[0];
    await loadDay(dates[0]);
  }

  async function boot() {
    try { await loadDates(); }
    catch (e) {
      if (String(e.message).match(/unauthorized|admin only|HTTP 401|HTTP 403/)) VDAdmin.logout('token 无效');
      else $('#list').innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
    }
  }

  function reload() {
    const d = $('#date').value;
    if (d && d !== '无数据') loadDay(d).catch((e) => { $('#list').innerHTML = `<div class="errbox">${esc(e.message)}</div>`; });
  }

  function init(o) {
    cfg = o;
    $('#date').addEventListener('change', reload);
    VDAdmin.init({ active: cfg.active, title: cfg.title, intro: cfg.intro, onEnter: boot, onRefresh: reload });
  }

  window.LogViewer = { init, api, fmtTime, bindRows, records: () => RECORDS };
})();
