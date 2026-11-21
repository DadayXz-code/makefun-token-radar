// Token Launch Radar — renders the ranked board, a filterable table, a per-protocol
// detail view with the model's own arithmetic, and the live-token view, from the
// sealed snapshot's data in ../data.js. No network, no framework: the page reads
// window.RADAR and nothing else. State lives in the URL hash, so a detail view or
// a filtered view is a link: #/p/<slug> opens a protocol, #/?q=&cat=&chain=&wl=1
// filters the board. Every number on the page comes from the data; nothing here
// is hardcoded to a protocol name.
(function () {
  'use strict';
  var DATA = window.RADAR || null;
  var app = document.getElementById('board');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(n);
  }
  function fmtUsdFull(n) {
    if (n == null || !isFinite(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n == null || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days == null) return 'unknown';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }
  function fmtMult(x) {
    if (x == null || !isFinite(x)) return '—';
    return '×' + x.toFixed(2);
  }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    });
    if (children != null) {
      if (!Array.isArray(children)) children = [children];
      children.forEach(function (c) { if (c) node.appendChild(c); });
    }
    return node;
  }

  // ---- state from the hash -------------------------------------------------
  var state = { tab: 'pre', q: '', cat: 'all', chain: 'all', wl: false, sig: 'all', sort: 'rank', dir: 1, slug: null };
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    state.slug = null;
    if (h.indexOf('/p/') === 0) { state.slug = decodeURIComponent(h.slice(3)); return; }
    var q = h.replace(/^\/?\?/, '');
    var p = new URLSearchParams(q);
    state.q = p.get('q') || '';
    state.cat = p.get('cat') || 'all';
    state.chain = p.get('chain') || 'all';
    state.wl = p.get('wl') === '1';
    state.sig = p.get('sig') || 'all';
    state.sort = p.get('sort') || 'rank';
    state.dir = p.get('dir') === '-1' ? -1 : 1;
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat !== 'all') p.set('cat', state.cat);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.wl) p.set('wl', '1');
    if (state.sig !== 'all') p.set('sig', state.sig);
    if (state.sort !== 'rank') p.set('sort', state.sort);
    if (state.dir === -1) p.set('dir', '-1');
    var s = p.toString();
    history.replaceState(null, '', s ? '#/?' + s : '#/');
  }

  // ---- filtering and sorting ----------------------------------------------
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.wl && DATA.watchlist.indexOf(r.slug) < 0 && !isWatchlist(r)) return false;
      if (state.sig !== 'all' && r.signal !== state.sig) return false;
      if (state.cat !== 'all' && (r.category || 'Other') !== state.cat) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  // The watchlist is the snapshot's own list; the board carries it in the data.
  var WL = null;
  function isWatchlist(r) {
    if (!WL) WL = new Set(DATA.watchlist_slugs || []);
    return WL.has(r.slug);
  }
  function sortedRows(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var va, vb;
      if (key === 'rank') { va = a.rank; vb = b.rank; }
      else if (key === 'tvl') { va = a.tvl_usd; vb = b.tvl_usd; }
      else if (key === 'change') { va = a.change_7d == null ? -1e9 : a.change_7d; vb = b.change_7d == null ? -1e9 : b.change_7d; }
      else if (key === 'age') { va = a.age_days == null ? -1 : a.age_days; vb = b.age_days == null ? -1 : b.age_days; }
      else if (key === 'fitted') { va = a.model.fitted_value_usd; vb = b.model.fitted_value_usd; }
      else if (key === 'odds') { va = a.model.token_odds; vb = b.model.token_odds; }
      else if (key === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
      else { va = a.implied_value_usd; vb = b.implied_value_usd; }
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.rank - b.rank;
    });
  }

  // ---- shared chrome --------------------------------------------------------
  function header() {
    var f = DATA.fit;
    var wrap = el('div', { class: 'wrap' });
    var head = el('header', { class: 'mast' }, [
      el('div', { class: 'eyebrow', text: 'Sealed snapshot · DefiLlama · as of ' + DATA.as_of }),
      el('h1', { text: 'Token Launch Radar' }),
      el('p', { class: 'lede', html: 'Every protocol that <b>records no token yet</b>, ranked by what its launch would be worth. ' +
        'The board covers the snapshot\u2019s whole watchlist of ' + DATA.watchlist_size + ' protocols and ' + DATA.early_size +
        ' more below its $50M floor — ' + DATA.board_size + ' pre-token protocols in all, each with a fitted value, token odds and a costed farm plan.' }),
    ]);
    wrap.appendChild(head);
    var kpis = el('section', { class: 'kpis' }, [
      kpi(fmtUsd(DATA.rows[0].implied_value_usd), 'Top implied value'),
      kpi(String(DATA.watchlist_size), 'Watchlist protocols'),
      kpi(String(DATA.board_size), 'Pre-token rows ranked'),
      kpi(String(f.n), 'Traded comps fitted'),
      kpi(f.cv_spearman.toFixed(2), '5-fold CV Spearman ρ'),
      kpi(fmtMult(f.median_multiple), 'Median mcap / TVL'),
    ]);
    wrap.appendChild(kpis);
    wrap.appendChild(methodBox());
    return wrap;
  }
  function kpi(v, l) {
    return el('div', { class: 'kpi' }, [el('div', { class: 'v', text: v }), el('div', { class: 'l', text: l })]);
  }
  function methodBox() {
    var f = DATA.fit;
    var det = el('details', { class: 'method' });
    det.appendChild(el('summary', { text: 'How the value is fitted — and what it cannot do' }));
    det.appendChild(el('p', { html: 'Implied value = <code>fitted value × growth tilt × token odds</code>. The fitted value is an OLS fit of ' +
      '<code>log10(market cap) = ' + f.intercept.toFixed(3) + ' + ' + f.slope.toFixed(3) + ' × log10(TVL)</code> plus a shrunk category offset (n / (n + 8)), ' +
      'fitted on the snapshot\u2019s own ' + f.n + ' traded protocols — no coefficient and no protocol name is hardcoded; the program refits from the snapshot on every run.' }));
    det.appendChild(el('p', { html: 'Growth tilt = <code>1 + clamp(7-day TVL change, −60%, +120%) × 0.25</code>. The freely fitted growth coefficient came out negative and unstable, ' +
      'so growth enters as a capped tilt (±30% at most) instead of a fitted driver. Token odds are the smoothed share of protocols that record a token among peers of the same age and size ' +
      '(age buckets &lt;1y, 1–2y, 2–4y, 4y+, unknown × TVL buckets &lt;$50M, $50–200M, $200M–1B, $1B+), shrunk toward the age bucket\u2019s own rate.' }));
    det.appendChild(el('p', { html: 'Held-out on the comps: 5-fold cross-validation Spearman <b>ρ = ' + f.cv_spearman.toFixed(3) + '</b> (folds ' +
      f.cv_folds.map(function (x) { return x.toFixed(2); }).join(', ') + '), leave-one-out ρ = ' + f.loo_spearman.toFixed(3) +
      ', time split (train listed before 2024-06-01, n=' + f.time_split_n_train + '; test after, n=' + f.time_split_n_test + ') ρ = ' +
      (f.time_split_spearman == null ? 'n/a' : f.time_split_spearman.toFixed(3)) + '. Residual spread ' + f.residual_sd_log10.toFixed(2) +
      ' in log10 — a typical error near <b>×' + Math.pow(10, f.residual_sd_log10).toFixed(1) + '</b> on the value itself.' }));
    det.appendChild(el('p', { html: '<span class="warn">Read the ranking, not the dollars.</span> The model orders protocols moderately well and prices them badly: ' +
      'treat the implied value as a relative score, never as a prediction of a listing price or date. Nothing here predicts whether or when a token is issued.' }));
    return det;
  }

  // ---- board tab ------------------------------------------------------------
  function boardView(wrap) {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains); }, []))).sort();
    var tabs = el('div', { class: 'tabs' }, [
      el('button', { type: 'button', class: 'tab', 'aria-pressed': 'true', text: 'Pre-token board (' + DATA.board_size + ')', onclick: function () {} }),
      el('button', { type: 'button', class: 'tab', 'aria-pressed': 'false', text: 'Live tokens (' + DATA.live_size + ')', onclick: function () { state.tab = 'live'; state.slug = null; render(); } }),
    ]);
    wrap.appendChild(tabs);
    var search = el('input', { type: 'search', placeholder: 'Search name or slug…', value: state.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); renderTable(); });
    var catSel = el('select', { 'aria-label': 'Category' }, [el('option', { value: 'all', text: 'All categories' })].concat(cats.map(function (c) {
      return el('option', { value: c, text: c, selected: c === state.cat ? 'selected' : null });
    })));
    catSel.addEventListener('change', function () { state.cat = catSel.value; writeHash(); renderTable(); });
    var chainSel = el('select', { 'aria-label': 'Chain' }, [el('option', { value: 'all', text: 'All chains' })].concat(chains.map(function (c) {
      return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null });
    })));
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); renderTable(); });
    var sigSel = el('select', { 'aria-label': 'Signal' }, ['all', 'Farm', 'Watch', 'Early'].map(function (s) {
      return el('option', { value: s, text: s === 'all' ? 'Any signal' : s, selected: s === state.sig ? 'selected' : null });
    }));
    sigSel.addEventListener('change', function () { state.sig = sigSel.value; writeHash(); renderTable(); });
    var wlBox = el('label', { class: 'chk' }, [
      el('input', { type: 'checkbox', checked: state.wl ? 'checked' : null }),
      document.createTextNode(' Watchlist only'),
    ]);
    wlBox.querySelector('input').addEventListener('change', function (e) { state.wl = e.target.checked; writeHash(); renderTable(); });
    wrap.appendChild(el('div', { class: 'controls' }, [search, catSel, chainSel, sigSel, wlBox]));
    wrap.appendChild(el('p', { class: 'count', id: 'count' }));
    wrap.appendChild(el('div', { id: 'tablehost' }));
    renderTable();
  }
  function sortHeader(key, label) {
    var arrow = state.sort === key ? (state.dir === 1 ? ' ▲' : ' ▼') : '';
    return el('th', {}, [el('button', {
      type: 'button', text: label + arrow, onclick: function () {
        if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = (key === 'name' || key === 'rank') ? 1 : -1; }
        writeHash(); renderTable();
      },
    })]);
  }
  function renderTable() {
    var host = document.getElementById('tablehost');
    var count = document.getElementById('count');
    if (!host) return;
    host.innerHTML = '';
    var list = sortedRows(filteredRows());
    count.innerHTML = 'Showing <b>' + list.length + '</b> of ' + DATA.board_size + ' pre-token protocols' +
      (state.wl ? ' on the watchlist' : '') + '. Click a row for its model breakdown and farm plan.';
    if (list.length === 0) { host.appendChild(el('div', { class: 'empty', text: 'No protocol matches these filters.' })); return; }
    var table = el('table', { class: 'board' });
    var thead = el('thead', {}, [el('tr', {}, [
      sortHeader('rank', '#'),
      sortHeader('name', 'Protocol'),
      el('th', { text: 'Category' }),
      sortHeader('tvl', 'TVL'),
      sortHeader('change', '7d'),
      sortHeader('age', 'Age, no token'),
      sortHeader('fitted', 'Fitted value'),
      sortHeader('odds', 'Token odds'),
      sortHeader('implied', 'Implied value'),
      el('th', { text: 'Signal' }),
    ])]);
    table.appendChild(thead);
    var tbody = el('tbody', {});
    list.forEach(function (r) {
      var tr = el('tr', { tabindex: '0', onclick: function () { openDetail(r.slug); }, onkeydown: function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); }
      } });
      tr.appendChild(el('td', { class: 'num rank', text: String(r.rank) }));
      var nameTd = el('td', {});
      nameTd.appendChild(el('span', { class: 'name', text: r.name }));
      if (isWatchlist(r)) nameTd.appendChild(el('span', { class: 'pill wl', text: 'WATCHLIST' }));
      nameTd.appendChild(el('div', { class: 'sub', text: r.slug + ' · ' + (r.chains.slice(0, 3).join(', ') || 'no chain listed') }));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', { class: 'cat', text: r.category || '—' }));
      tr.appendChild(el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }));
      var ch = el('td', { class: 'num ' + (r.change_7d == null ? '' : r.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) });
      tr.appendChild(ch);
      tr.appendChild(el('td', { class: 'num', text: fmtAge(r.age_days) }));
      tr.appendChild(el('td', { class: 'num', text: fmtUsd(r.model.fitted_value_usd) }));
      tr.appendChild(el('td', { class: 'num', text: (r.model.token_odds * 100).toFixed(0) + '%' }));
      tr.appendChild(el('td', { class: 'num', html: '<b>' + esc(fmtUsd(r.implied_value_usd)) + '</b>' }));
      tr.appendChild(el('td', {}, [el('span', { class: 'pill ' + r.signal.toLowerCase(), text: r.signal.toUpperCase() })]));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }
  function openDetail(slug) {
    state.slug = slug;
    history.replaceState(null, '', '#/p/' + encodeURIComponent(slug));
    render();
  }

  // ---- detail view ----------------------------------------------------------
  function ageBucket(age) {
    if (age == null) return 'unknown';
    if (age < 365) return '<1y';
    if (age < 730) return '1-2y';
    if (age < 1460) return '2-4y';
    return '4y+';
  }
  function tvlBucket(tvl) {
    if (tvl < 50e6) return '<50M';
    if (tvl < 200e6) return '50-200M';
    if (tvl < 1e9) return '200M-1B';
    return '1B+';
  }
  function detailView(wrap, row) {
    var back = el('button', { type: 'button', class: 'back', text: '← Back to the board', onclick: function () { state.slug = null; history.replaceState(null, '', '#/'); render(); } });
    wrap.appendChild(back);
    var d = el('section', { class: 'detail' });
    d.appendChild(el('h2', { text: row.name }));
    var wlNote = isWatchlist(row)
      ? ' · <span class="pill wl">ON THE WATCHLIST</span>'
      : row.tvl_usd >= DATA.floor_usd
        ? ' · not on the watchlist (the snapshot\u2019s watchlist rule leaves it out: a parent protocol, a version marker or a wrapped / staked product in DefiLlama\u2019s record)'
        : ' · below the $50M watchlist floor';
    d.appendChild(el('p', { class: 'meta', html: esc(row.slug) + ' · ' + esc(row.category || 'Uncategorised') + ' · ' + esc(row.chains.join(', ') || 'no chain listed') +
      ' · ranked <b>#' + row.rank + '</b> of ' + DATA.board_size + wlNote +
      ' · signal <span class="pill ' + row.signal.toLowerCase() + '">' + row.signal.toUpperCase() + '</span>' }));
    d.appendChild(el('div', { class: 'kv' }, [
      kvCell(fmtUsd(row.implied_value_usd), 'Implied launch value'),
      kvCell(fmtUsd(row.tvl_usd), 'TVL'),
      kvCell(fmtPct(row.change_7d), 'TVL change, 7 days'),
      kvCell(fmtAge(row.age_days), 'Running with no token'),
    ]));
    d.appendChild(el('h3', { text: 'How the value is built' }));
    var cellKey = ageBucket(row.age_days) + '|' + tvlBucket(row.tvl_usd);
    var cell = DATA.odds.cells[cellKey];
    d.appendChild(el('div', { class: 'formula', html: '<b>' + esc(fmtUsdFull(row.implied_value_usd)) + '</b> = ' + esc(fmtUsdFull(row.model.fitted_value_usd)) + ' fitted × ' +
      row.model.growth_multiplier.toFixed(2) + ' growth × ' + row.model.token_odds.toFixed(2) + ' odds' }));
    d.appendChild(el('p', { class: 'note', html: 'Fitted value: <code>10^(' + DATA.fit.intercept.toFixed(3) + ' + ' + DATA.fit.slope.toFixed(3) + ' × log10(TVL))</code> with a ' +
      (row.model.category_offset_log10 >= 0 ? '+' : '') + row.model.category_offset_log10.toFixed(2) + ' category offset in log10 for ' + esc(row.category || 'Other') +
      '. Growth tilt from a ' + fmtPct(row.model.growth_pct) + ' seven-day move. Token odds from ' + (cell ? cell.with_token + ' of ' + cell.n + ' peer protocols' : 'its age bucket') +
      ' in the ' + esc(cellKey) + ' cell that record a token, smoothed toward the age bucket\u2019s rate. ' +
      'This is an expected value — the fitted value if a token lists, weighted by how often peers like it have one — not a price forecast.' }));
    d.appendChild(el('h3', { text: 'Farm plan — six steps, costed' }));
    d.appendChild(el('div', { class: 'econ' }, [
      el('span', { html: 'Capital <b>$' + row.farm_econ.capital_usd + '</b>' }),
      el('span', { html: 'Gas ≈ <b>$' + row.farm_econ.gas_per_tx_usd + '</b> / tx on ' + esc(row.chains[0] || 'its main chain') }),
      el('span', { html: 'Hold <b>' + row.farm_econ.hold_days + ' days</b>' }),
      el('span', { html: 'Weekly upkeep ≈ <b>$' + row.farm_econ.weekly_gas_usd + '</b> gas' }),
    ]));
    var ol = el('ol', { class: 'steps' });
    row.farm_steps.forEach(function (s) {
      var m = s.match(/^(.*?)\s*Cost:\s*(.*?)\s*Time:\s*(.*?)\.?$/);
      var li = el('li', {});
      if (m) {
        li.appendChild(document.createTextNode(m[1]));
        li.appendChild(el('span', { class: 'tags', html: 'Cost: <b>' + esc(m[2]) + '</b> · Time: <b>' + esc(m[3]) + '</b>' }));
      } else li.appendChild(document.createTextNode(s));
      ol.appendChild(li);
    });
    d.appendChild(ol);
    d.appendChild(el('p', { class: 'note', text: 'Gas figures are rough estimates for the chain named. A farm plan is a plan, not a promise: a protocol may never issue a token, and points systems change without notice.' }));
    var sameCat = DATA.live.filter(function (l) { return l.category === row.category; }).slice(0, 3);
    var comps = sameCat.length ? sameCat : DATA.live.slice(0, 3);
    d.appendChild(el('h3', { text: sameCat.length ? 'Traded comps in the same category' : 'Traded comps for reference' }));
    var ct = el('table', { class: 'comps' });
    ct.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Protocol' }), el('th', { class: 'num', text: 'Market cap' }),
      el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: 'mcap / TVL' }),
    ])]));
    var cb = el('tbody', {});
    comps.forEach(function (l) {
      cb.appendChild(el('tr', {}, [
        el('td', { text: l.name }), el('td', { class: 'num', text: fmtUsd(l.mcap_usd) }),
        el('td', { class: 'num', text: fmtUsd(l.tvl_usd) }), el('td', { class: 'num', text: fmtMult(l.multiple) }),
      ]));
    });
    ct.appendChild(cb);
    d.appendChild(ct);
    d.appendChild(el('p', { class: 'note', text: 'These protocols already trade, so the board shows their market\u2019s own values — never a model\u2019s — and keeps them out of the ranking.' }));
    wrap.appendChild(d);
  }
  function kvCell(v, l) {
    return el('div', { class: 'cell' }, [el('div', { class: 'v', text: v }), el('div', { class: 'l', text: l })]);
  }

  // ---- live tab ---------------------------------------------------------------
  function liveView(wrap) {
    var tabs = el('div', { class: 'tabs' }, [
      el('button', { type: 'button', class: 'tab', 'aria-pressed': 'false', text: 'Pre-token board (' + DATA.board_size + ')', onclick: function () { state.tab = 'pre'; render(); } }),
      el('button', { type: 'button', class: 'tab', 'aria-pressed': 'true', text: 'Live tokens (' + DATA.live_size + ')', onclick: function () {} }),
    ]);
    wrap.appendChild(tabs);
    wrap.appendChild(el('p', { class: 'lede', text: 'Protocols whose token already trades, by market cap. They anchor the comps model — the board ranks only the pre-token ones, and never mixes a market value into a modelled one.' }));
    var table = el('table', { class: 'board' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { class: 'num', text: '#' }), el('th', { text: 'Protocol' }), el('th', { text: 'Category' }),
      el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: 'mcap / TVL' }), el('th', { class: 'num', text: '7d' }),
    ])]));
    var tbody = el('tbody', {});
    DATA.live.forEach(function (l, i) {
      var tr = el('tr', {});
      tr.appendChild(el('td', { class: 'num rank', text: String(i + 1) }));
      tr.appendChild(el('td', {}, [el('span', { class: 'name', text: l.name }), el('div', { class: 'sub', text: l.slug })]));
      tr.appendChild(el('td', { class: 'cat', text: l.category || '—' }));
      tr.appendChild(el('td', { class: 'num', html: '<b>' + esc(fmtUsd(l.mcap_usd)) + '</b>' }));
      tr.appendChild(el('td', { class: 'num', text: fmtUsd(l.tvl_usd) }));
      tr.appendChild(el('td', { class: 'num', text: fmtMult(l.multiple) }));
      tr.appendChild(el('td', { class: 'num ' + (l.change_7d == null ? '' : l.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(l.change_7d) }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---- render -------------------------------------------------------------------
  function render() {
    readHash();
    app.innerHTML = '';
    app.removeAttribute('aria-busy');
    if (!DATA) {
      app.appendChild(el('div', { class: 'wrap' }, [el('p', { text: 'No radar data loaded.' })]));
      return;
    }
    var wrap = header();
    app.appendChild(wrap);
    if (state.slug) {
      var row = null;
      for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === state.slug) { row = DATA.rows[i]; break; }
      if (row) detailView(wrap, row);
      else wrap.appendChild(el('p', { class: 'note', text: 'No protocol with that slug is on the board.' }));
    } else if (state.tab === 'live') {
      liveView(wrap);
    } else {
      boardView(wrap);
    }
    wrap.appendChild(el('footer', {}, [
      el('p', { text: 'Snapshot: ' + DATA.source + ' · Watchlist floor $' + DATA.floor_usd.toLocaleString('en-US') + ' · Model ' + DATA.model_version + ' · ' +
        'A protocol is called pre-token when its DefiLlama record carries no token — a record is not proof it has none.' }),
      el('p', { text: 'Static page: no network, no tracking. Implied values are the entry\u2019s own claim, fitted from the snapshot, and not a prediction of any listing.' }),
    ]));
    app.appendChild(wrap);
  }
  window.addEventListener('hashchange', render);
  render();
})();
