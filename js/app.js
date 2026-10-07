// Rendering, routing and navigation memory.

const TAG_NAMES = { C: 'Concept', M: 'Method or calculation', X: 'Exam trap', E: 'Extension outside the BOK' };
const BLOOM_NAMES = { Rem: 'Remember', Und: 'Understand', App: 'Apply', Ana: 'Analyze', Eva: 'Evaluate' };
const PASS_PERCENT = 70;
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // only ever build-time HTML from tools/build.py
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) node.setAttribute(k, v);
  for (const c of children.flat(Infinity)) if (c != null) node.append(c instanceof Node ? c : String(c));
  return node;
}

// replaceChildren() does not skip nulls or flatten arrays the way el() does.
function nodes(...children) {
  return children.flat(Infinity).filter((c) => c != null && c !== false);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------- navigation memory ----------
// "Came from" lives on the browser history entry itself (history.state), so every step of a
// guide -> questions -> guide round trip keeps its own Back target, including after a reload
// and through the browser's own back/forward buttons.
// Scroll positions are per page address in sessionStorage; returning to a page restores it.

function readSession(key, fallback) {
  try {
    return JSON.parse(sessionStorage.getItem(key)) || fallback;
  } catch (e) {
    return fallback;
  }
}

function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

const scrollPositions = readSession('gb-scroll', {}); // hash -> scrollY
const pendingFlash = readSession('gb-flash', {});     // hash -> element id to highlight on return
let currentHash = null;
let pendingOrigin = null;
let renderToken = 0;
let examTimer = null;
let restoringScroll = false;
let scrollSaveTimer = null;

function saveNavMemory() {
  writeSession('gb-scroll', scrollPositions);
  writeSession('gb-flash', pendingFlash);
}

// Links marked data-back record where they were tapped from, so the target page can offer an
// exact "Back to ..." and the origin item gets highlighted when the reader returns.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-back]');
  if (!link) return;
  const target = link.getAttribute('href');
  const anchor = link.closest('[id]');
  pendingOrigin = { target, label: link.dataset.back };
  if (anchor) pendingFlash[currentHash] = anchor.id;
  delete scrollPositions[target];
  saveNavMemory();
});

window.addEventListener('scroll', () => {
  if (restoringScroll || !currentHash) return;
  scrollPositions[currentHash] = Math.round(window.scrollY);
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveNavMemory, 250);
}, { passive: true });

// Changes the address without a new history entry (filters, search text), then redraws.
function replaceRoute(hash, redraw = true) {
  if (hash === location.hash) return;
  history.replaceState(history.state, '', hash);
  currentHash = hash;
  if (redraw) render();
}

function currentOrigin() {
  return history.state && history.state.origin ? history.state.origin : null;
}

// ---------- routing ----------

function currentRoute() {
  const hash = location.hash && location.hash !== '#' ? location.hash : '#/';
  const [path, qs] = hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  let target = null;
  if (parts[0] === 'guide' && query.fp) target = 'fp-' + query.fp;
  else if (parts[0] === 'outline' && query.fp) target = 'ol-' + query.fp;
  else if (parts[0] === 'guide' && query.t) target = 't-' + query.t;
  else if (query.d) target = 'd-' + query.d;
  return { hash, parts, query, target };
}

async function viewFor(route) {
  const [section, id] = route.parts;
  if (!section) return dashboardView();
  if (section === 'outline' && !id) return outlineView();
  if (section === 'outline' && manifest.categories[id]) return outlineCategoryView(id);
  if (section === 'guide' && manifest.categories[id]) return guideView(id);
  if (section === 'read' && manifest.topics[id] && manifest.topics[id].readMin) return readingView(id);
  if (section === 'practice') return practiceView();
  if ((section === 'qa' || section === 'wb') && manifest.categories[id]) {
    const scope = practiceScope(id, route.query);
    if (scope) return section === 'qa' ? questionsView(id, scope, route.query) : workbookView(id, scope, route.query);
  }
  if (section === 'exam' && !id) return examView();
  if (section === 'exam' && id === 'run') return examRunView();
  if (section === 'exam' && id === 'result' && progress.exams[route.parts[2]]) return examResultView(Number(route.parts[2]), route.query);
  if (section === 'review') return reviewView();
  if (section === 'search') return searchView(route.query);
  if (section === 'toolkit') return toolkitView();
  if (section === 'settings') return settingsView();
  return {
    title: 'Page not found',
    tab: null,
    body: [el('p', {}, 'There is no page at this address.'), el('a', { class: 'button-link', href: '#/' }, 'Open the dashboard')],
  };
}

async function render() {
  const token = ++renderToken;
  const route = currentRoute();
  clearInterval(examTimer);
  examTimer = null;
  let view;
  try {
    await loadManifest();
    view = await viewFor(route);
  } catch (err) {
    view = {
      title: 'Content did not load',
      tab: null,
      body: el('div', { class: 'error' },
        el('p', {}, err.message),
        location.protocol === 'file:'
          ? el('p', {}, 'Open the app through a web server. Opening index.html as a file cannot load the study content.')
          : el('p', {}, 'Check the connection and reload the page.')),
    };
  }
  if (token !== renderToken) return;

  restoringScroll = true;
  document.getElementById('app').replaceChildren(headerBar(view), el('main', { class: 'main' }, view.body), navBar(view.tab));
  document.title = view.tab === 'home' ? 'Green Belt Study' : `${view.title} | Green Belt Study`;
  if (manifest) refreshRollups();
  placeScroll(route);
  requestAnimationFrame(() => { restoringScroll = false; });
}

function placeScroll(route) {
  const saved = scrollPositions[route.hash];
  const target = route.target && document.getElementById(route.target);
  if (saved != null) window.scrollTo(0, saved);
  else if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);

  const flashId = pendingFlash[route.hash];
  if (flashId) {
    delete pendingFlash[route.hash];
    saveNavMemory();
    flash(document.getElementById(flashId));
  } else if (saved == null && target) {
    flash(target);
  }
}

function flash(node) {
  if (!node) return;
  node.classList.remove('flash');
  void node.offsetWidth; // restart the animation if it is already applied
  node.classList.add('flash');
}

function onNavigate() {
  const hash = currentRoute().hash;
  // The old page is still on screen when hashchange fires, so this is its true final position.
  // Scroll events alone are not enough: browsers skip them in background tabs.
  if (currentHash !== null) scrollPositions[currentHash] = Math.round(window.scrollY);
  if (pendingOrigin && pendingOrigin.target === hash) {
    history.replaceState({ origin: { from: currentHash, label: pendingOrigin.label } }, '');
  }
  pendingOrigin = null;
  currentHash = hash;
  saveNavMemory();
  render();
}

// ---------- shared pieces ----------

function headerBar(view) {
  const origin = currentOrigin();
  return el('header', { class: 'header' },
    // The origin entry is always directly behind an entry that carries one, so plain history.back() is exact.
    origin ? el('button', { class: 'back-btn', type: 'button', onclick: () => history.back() }, `‹ Back to ${origin.label}`) : null,
    el('h1', { class: 'header-title' }, origin ? '' : view.title));
}

function navBar(active) {
  const tabs = [['home', '#/', 'Home'], ['outline', '#/outline', 'Outline'], ['practice', '#/practice', 'Practice'], ['toolkit', '#/toolkit', 'Toolkit'], ['settings', '#/settings', 'Settings']];
  return el('nav', { class: 'nav', 'aria-label': 'Main' },
    tabs.map(([key, href, label]) => el('a', { href, class: key === active ? 'active' : null, 'aria-current': key === active ? 'page' : null }, label)));
}

// A labeled progress bar. Shows the percent by default, or "n of m" with count: true.
function rollupRow(scope, opts = {}) {
  const figure = opts.count ? el('span', { 'data-count': scope }) : el('span', { 'data-pct': scope });
  return el(opts.href ? 'a' : 'div', { class: `rollup${opts.plain ? ' plain' : ''}`, href: opts.href, id: opts.id },
    el('div', { class: 'rollup-head' },
      el('span', { class: 'rollup-label' },
        opts.showId ? el('span', { class: 'rollup-id' }, scope) : null,
        opts.label || scopeTitle(scope)),
      el('span', { class: 'rollup-pct' }, figure)),
    el('div', { class: 'bar', role: 'presentation' }, el('div', { class: 'bar-fill', 'data-bar': scope })));
}

function refreshRollups() {
  const cache = {};
  const get = (scope) => cache[scope] || (cache[scope] = rollup(scope));
  document.querySelectorAll('[data-count]').forEach((n) => { const r = get(n.dataset.count); n.textContent = `${r.done} of ${r.total}`; });
  document.querySelectorAll('[data-pct]').forEach((n) => { n.textContent = `${get(n.dataset.pct).pct}%`; });
  document.querySelectorAll('[data-bar]').forEach((n) => { n.style.width = `${get(n.dataset.bar).pct}%`; });
}

function focusCheck(fid) {
  const input = el('input', {
    type: 'checkbox',
    'data-fp': fid,
    'aria-label': `Mark ${fid} as studied`,
    onchange: (e) => toggleFocus(fid, e.target.checked),
  });
  input.checked = isDone(fid);
  return el('label', { class: 'check' }, input);
}

function toggleFocus(fid, done) {
  setDone(fid, done);
  document.querySelectorAll(`input[data-fp="${fid}"]`).forEach((n) => { n.checked = done; });
  document.querySelectorAll(`[data-fp-row="${fid}"]`).forEach((n) => n.classList.toggle('done', done));
  refreshRollups();
}

function tagBadge(tag) {
  return el('span', { class: `tag tag-${tag}`, title: TAG_NAMES[tag], 'aria-label': TAG_NAMES[tag] }, tag);
}

function tagLegend() {
  return el('div', { class: 'legend' }, Object.entries(TAG_NAMES).map(([t, name]) => el('span', {}, tagBadge(t), ' ', name)));
}

function bloomName(code) {
  return BLOOM_NAMES[code] || code;
}

function pager(cid, base) {
  const prev = neighborCategory(cid, -1);
  const next = neighborCategory(cid, 1);
  return el('nav', { class: 'pager', 'aria-label': 'Categories' },
    prev ? el('a', { href: `#/${base}/${prev}` }, el('span', {}, 'Previous'), `${prev} ${manifest.categories[prev].title}`) : null,
    next ? el('a', { class: 'next', href: `#/${base}/${next}` }, el('span', {}, 'Next'), `${next} ${manifest.categories[next].title}`) : null);
}

// Practice mastery for one focus point: the share of its questions whose latest answer was right.
function ring(right, total) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return svg('svg', { class: 'ring', viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    svg('circle', { class: 'ring-track', cx: 12, cy: 12, r }),
    right ? svg('circle', { class: 'ring-fill', cx: 12, cy: 12, r, 'stroke-dasharray': `${(c * right) / total} ${c}`, transform: 'rotate(-90 12 12)' }) : null);
}

// Links from a question or problem back to each focus point it tests.
function testsRow(tests, backLabel) {
  return el('p', { class: 'tests' },
    el('span', { class: 'tests-label' }, 'Tests'),
    tests.map((fid) => el('a', { class: 'chip', href: `#/guide/${fid.slice(0, 3)}?fp=${fid}`, 'data-back': backLabel }, fid)));
}

// Dashboard hero: the 18 categories as a run chart in DMAIC order, with the 70% pass line
// drawn like a control limit. Weak categories show up as dips, the way a process shift would.
function runChart() {
  const W = 340, H = 196, L = 26, R = 4, T = 8, B = 30;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const cats = categoryIds();
  const step = plotW / cats.length;
  const y = (pct) => T + plotH * (1 - pct / 100);
  const xOf = (i) => L + (i + 0.5) * step;
  const pts = cats.map((c, i) => ({ c, x: xOf(i), y: y(rollup(c).pct), pct: rollup(c).pct }));

  const bands = [];
  let i = 0;
  domainIds().forEach((d, di) => {
    const n = manifest.domains[d].categories.length;
    const x0 = L + i * step;
    if (di % 2 === 0) bands.push(svg('rect', { class: 'band', x: x0, y: T, width: n * step, height: plotH }));
    bands.push(svg('text', { class: 'phase-label', x: x0 + (n * step) / 2, y: H - 9, 'text-anchor': 'middle' }, manifest.domains[d].title[0]));
    i += n;
  });

  const summary = pts.map((p) => `${p.c} ${p.pct}%`).join(', ');
  return svg('svg', { class: 'run-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Percent studied by category in DMAIC order: ${summary}` },
    bands,
    [0, 50, 100].map((v) => [
      svg('line', { class: 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) }),
      svg('text', { class: 'axis-label', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v),
    ]),
    svg('line', { class: 'limit', x1: L, x2: W - R, y1: y(PASS_PERCENT), y2: y(PASS_PERCENT) }),
    svg('text', { class: 'limit-label', x: L - 6, y: y(PASS_PERCENT) + 4, 'text-anchor': 'end' }, PASS_PERCENT),
    svg('polyline', { class: 'series', points: pts.map((p) => `${p.x},${p.y}`).join(' ') }),
    pts.map((p) => svg('circle', { class: 'point', cx: p.x, cy: p.y, r: 3.6 })),
    pts.map((p, idx) => svg('a', { href: `#/outline/${p.c}`, 'aria-label': `${p.c} ${manifest.categories[p.c].title}, ${p.pct}%` },
      svg('title', {}, `${p.c} ${manifest.categories[p.c].title}: ${p.pct}%`),
      svg('rect', { class: 'hit', x: L + idx * step, y: T, width: step, height: plotH }))));
}

// ---------- views: reading ----------

function dashboardView() {
  const last = settings.lastRoute;
  const lastCat = last && last.match(/^#\/(?:guide|read)\/(\d\.\d)/);
  const resume = lastCat && manifest.categories[lastCat[1]] ? lastCat[1] : null;
  const lastTopic = last && last.match(/^#\/read\/(\d\.\d\.\d+)/);
  const qs = tally(allItemIds('q'), questionStatus);
  return {
    title: 'Green Belt Study',
    tab: 'home',
    body: [
      el('div', { class: 'hero' },
        el('span', { class: 'hero-pct', 'data-pct': 'all' }),
        el('div', { class: 'hero-caption' }, el('strong', { 'data-count': 'all' }), 'focus points studied')),
      runChart(),
      el('p', { class: 'chart-note' }, `Each point is one category, in DMAIC order. The dashed line is ${PASS_PERCENT}%, the exam's pass mark. Tap a point to open that category.`),
      installHint(),
      backupReminder(),
      resume
        ? el('a', { class: 'continue', href: last },
          el('div', {}, el('span', {}, 'Continue reading'), el('strong', {}, lastTopic && manifest.topics[lastTopic[1]]
            ? `${lastTopic[1]} ${manifest.topics[lastTopic[1]].title}`
            : `${resume} ${manifest.categories[resume].title}`)),
          el('span', { class: 'continue-go' }, 'Open'))
        : el('a', { class: 'continue', href: '#/outline' },
          el('div', {}, el('span', {}, 'Start studying'), el('strong', {}, 'Pick a focus point from the outline')),
          el('span', { class: 'continue-go' }, 'Open')),
      el('a', { class: 'continue', href: '#/practice' },
        el('div', {},
          el('span', {}, 'Practice questions'),
          el('strong', {}, qs.right + qs.wrong ? `${qs.right} of ${qs.total} answered right` : `${qs.total} questions, none tried yet`)),
        el('span', { class: 'continue-go' }, 'Open')),
      reviewCard(true),
      examCard(),
      el('h2', { class: 'section-title' }, 'By phase'),
      el('div', { class: 'rows' }, domainIds().map((d) => rollupRow(d, { href: `#/outline?d=${d}` }))),
      el('h2', { class: 'section-title' }, 'By category'),
      domainIds().map((d) => [
        el('p', { class: 'phase-group' }, manifest.domains[d].title),
        el('div', { class: 'rows' }, manifest.domains[d].categories.map((c) => rollupRow(c, { href: `#/outline/${c}`, showId: true }))),
      ]),
    ],
  };
}

function outlineView() {
  return {
    title: 'Outline',
    tab: 'outline',
    body: [
      el('h1', { class: 'page-title' }, 'Master outline'),
      el('p', { class: 'page-sub' }, `${manifest.counts.topics} topics and ${manifest.counts.focus} focus points, from content version ${manifest.contentVersion}.`),
      el('a', { class: 'search-link', href: '#/search' }, `Search all ${manifest.counts.focus} focus points`),
      tagLegend(),
      domainIds().map((d) => [
        el('h2', { class: 'domain-title', id: `d-${d}` }, `Domain ${d}: ${manifest.domains[d].title}`),
        rollupRow(d, { label: 'Studied', count: true, plain: true }),
        el('div', { class: 'rows' }, manifest.domains[d].categories.map((c) => rollupRow(c, { href: `#/outline/${c}`, id: `c-${c}`, showId: true }))),
      ]),
    ],
  };
}

function outlineCategoryView(cid) {
  const cat = manifest.categories[cid];
  return {
    title: `Outline ${cid}`,
    tab: 'outline',
    body: [
      el('h1', { class: 'page-title' }, `${cid} ${cat.title}`),
      el('p', { class: 'page-sub' }, `Domain ${cat.domain}: ${manifest.domains[cat.domain].title}`),
      rollupRow(cid, { label: 'Studied', count: true, plain: true }),
      el('p', {}, el('a', { class: 'button-link', href: `#/guide/${cid}`, 'data-back': `outline ${cid}` }, 'Read the study guide')),
      tagLegend(),
      cat.topics.map((tid) => {
        const topic = manifest.topics[tid];
        return [
          el('div', { class: 'topic-head', id: `t-${tid}` },
            el('h2', {}, `${tid} ${topic.title}`),
            el('p', { class: 'topic-meta' },
              el('span', {}, `Bloom level: ${bloomName(topic.bloom)}`),
              el('span', {}, el('span', { 'data-count': tid }), ' studied')),
            readLink(tid, `outline ${tid}`)),
          el('ul', { class: 'fp-list' }, topic.focus.map((fid) => {
            const fp = manifest.focus[fid];
            return el('li', { class: `fp-row${isDone(fid) ? ' done' : ''}`, id: `ol-${fid}`, 'data-fp-row': fid },
              focusCheck(fid),
              el('a', { class: 'fp-link', href: `#/guide/${cid}?fp=${fid}`, 'data-back': `outline ${fid}` },
                el('span', { class: 'fp-id' }, fid), ' ', tagBadge(fp.tag), ' ',
                el('span', { class: 'fp-text', html: fp.text })));
          })),
        ];
      }),
      pager(cid, 'outline'),
    ],
  };
}

// Link from a topic heading to its in-depth reading, when one exists.
function readLink(tid, backLabel) {
  const min = manifest.topics[tid].readMin;
  if (!min) return null;
  return el('a', { class: 'read-link', href: `#/read/${tid}`, 'data-back': backLabel }, `Read the in-depth explanation (${min} min)`);
}

function focusPractice(cid, fid) {
  const fp = manifest.focus[fid];
  if (!fp.q.length && !fp.p.length) {
    return el('p', { class: 'practice' }, 'No practice items. This section is the study material.');
  }
  const m = mastery(fid);
  return el('div', { class: 'practice' },
    fp.q.length ? el('span', { class: 'mastery', title: 'Questions answered right on the latest try' },
      ring(m.right, m.total), `${m.right} of ${m.total} right`) : null,
    fp.q.length ? el('a', { class: 'chip', href: `#/qa/${cid}?fp=${fid}`, 'data-back': `guide ${fid}` }, `Questions (${fp.q.length})`) : null,
    fp.p.length ? el('a', { class: 'chip', href: `#/wb/${cid}?fp=${fid}`, 'data-back': `guide ${fid}` }, `Workbook (${fp.p.length})`) : null);
}

async function guideView(cid) {
  const chunk = await loadCategory(cid);
  const cat = manifest.categories[cid];
  settings.lastRoute = location.hash;
  saveSettings();
  return {
    title: `Study guide ${cid}`,
    tab: 'outline',
    body: [
      el('h1', { class: 'page-title' }, `${cid} ${cat.title}`),
      el('p', { class: 'page-sub' }, `Study guide for Domain ${cat.domain}: ${manifest.domains[cat.domain].title}`),
      rollupRow(cid, { label: 'Studied', count: true, plain: true }),
      el('div', { class: 'jump' },
        cat.topics.map((tid) => el('a', {
          href: `#/guide/${cid}?t=${tid}`,
          onclick: (e) => { e.preventDefault(); document.getElementById(`t-${tid}`).scrollIntoView(); },
        }, tid)),
        el('a', { href: `#/outline/${cid}` }, 'Outline')),
      cat.topics.map((tid) => {
        const topic = manifest.topics[tid];
        const extra = chunk.topics[tid];
        const nq = itemIdsIn('q', tid).length;
        const np = itemIdsIn('p', tid).length;
        return el('section', { class: 'topic', id: `t-${tid}` },
          el('div', { class: 'topic-head' },
            el('h2', {}, `${tid} ${topic.title}`),
            el('p', { class: 'topic-meta' },
              el('span', {}, `Bloom target: ${bloomName(topic.bloom)}`),
              el('span', {}, el('span', { 'data-count': tid }), ' studied')),
            readLink(tid, `guide ${tid}`)),
          extra.examLens ? el('div', { class: 'lens' }, el('strong', {}, 'Exam lens. '), el('span', { html: extra.examLens })) : null,
          topic.focus.map((fid) => {
            const fp = manifest.focus[fid];
            return el('article', { class: `fp${isDone(fid) ? ' done' : ''}`, id: `fp-${fid}`, 'data-fp-row': fid },
              el('div', { class: 'fp-head' },
                focusCheck(fid),
                el('h3', {}, el('span', { class: 'fp-id' }, fid), ' ', tagBadge(fp.tag), ' ', el('span', { html: chunk.guide[fid].title }))),
              el('div', { class: 'prose', html: chunk.guide[fid].html }),
              focusPractice(cid, fid));
          }),
          el('div', { class: 'worked' },
            el('h3', {}, `Worked example ${tid}`),
            el('div', { class: 'prose', html: extra.worked.question }),
            el('details', {},
              el('summary', {}, 'Show solution'),
              el('div', { class: 'prose', html: extra.worked.solution }))),
          nq || np
            ? el('div', { class: 'practice-set', id: `ps-${tid}` },
              el('span', {}, `Practice set for ${tid}`),
              nq ? el('a', { class: 'chip', href: `#/qa/${cid}?t=${tid}`, 'data-back': `guide ${tid}` }, `All questions (${nq})`) : null,
              np ? el('a', { class: 'chip', href: `#/wb/${cid}?t=${tid}`, 'data-back': `guide ${tid}` }, `All workbook (${np})`) : null)
            : null);
      }),
      pager(cid, 'guide'),
    ],
  };
}

async function toolkitView() {
  const tk = await loadToolkit();
  return {
    title: 'Exam toolkit',
    tab: 'toolkit',
    body: [
      el('h1', { class: 'page-title' }, tk.title.replace(/^SG-0\s*/, '')),
      el('p', { class: 'page-sub' }, 'Formulas, selection trees, rules and traps for the whole exam.'),
      el('div', { class: 'lens' },
        'Open the official IASSC Examination Reference Document from PeopleCert or your exam provider next to this page while you practice. It is not included in this app.'),
      el('div', { class: 'prose', html: tk.html }),
    ],
  };
}

async function readingView(tid) {
  const topic = manifest.topics[tid];
  const cid = topic.category;
  const html = (await loadReadings(cid))[tid];
  settings.lastRoute = location.hash;
  saveSettings();
  const order = readingTopicIds();
  const prev = order[order.indexOf(tid) - 1];
  const next = order[order.indexOf(tid) + 1];
  const nq = itemIdsIn('q', tid).length;
  const np = itemIdsIn('p', tid).length;
  return {
    title: `Reading ${tid}`,
    tab: 'outline',
    body: [
      el('h1', { class: 'page-title' }, `${tid} ${topic.title}`),
      el('p', { class: 'page-sub' }, `In-depth reading for ${cid} ${manifest.categories[cid].title}. About ${topic.readMin} minutes.`),
      el('div', { class: 'jump' },
        el('a', { href: `#/guide/${cid}?t=${tid}`, 'data-back': `reading ${tid}` }, 'Study guide'),
        nq ? el('a', { href: `#/qa/${cid}?t=${tid}`, 'data-back': `reading ${tid}` }, `Questions (${nq})`) : null,
        np ? el('a', { href: `#/wb/${cid}?t=${tid}`, 'data-back': `reading ${tid}` }, `Workbook (${np})`) : null),
      el('article', { class: 'prose reading', html }),
      el('h2', { class: 'section-title' }, 'Focus points in this topic'),
      el('p', { class: 'muted small' }, 'Check off what you now understand. Tap one to open its study guide section.'),
      el('ul', { class: 'fp-list' }, topic.focus.map((fid) => {
        const fp = manifest.focus[fid];
        return el('li', { class: `fp-row${isDone(fid) ? ' done' : ''}`, id: `rf-${fid}`, 'data-fp-row': fid },
          focusCheck(fid),
          el('a', { class: 'fp-link', href: `#/guide/${cid}?fp=${fid}`, 'data-back': `reading ${tid}` },
            el('span', { class: 'fp-id' }, fid), ' ', tagBadge(fp.tag), ' ', el('span', { class: 'fp-text', html: fp.text })));
      })),
      el('nav', { class: 'pager', 'aria-label': 'Readings' },
        prev ? el('a', { href: `#/read/${prev}` }, el('span', {}, 'Previous reading'), `${prev} ${manifest.topics[prev].title}`) : null,
        next ? el('a', { class: 'next', href: `#/read/${next}` }, el('span', {}, 'Next reading'), `${next} ${manifest.topics[next].title}`) : null),
    ],
  };
}

// ---------- views: practice ----------

function practiceView() {
  const qAll = tally(allItemIds('q'), questionStatus);
  const pAll = tally(allItemIds('p'), problemStatus);
  return {
    title: 'Practice',
    tab: 'practice',
    body: [
      el('h1', { class: 'page-title' }, 'Practice'),
      el('p', { class: 'page-sub' },
        `${qAll.right} of ${qAll.total} questions answered right. ${pAll.right} of ${pAll.total} workbook problems marked got it.`),
      examCard(true),
      reviewCard(false),
      domainIds().map((d) => [
        el('h2', { class: 'domain-title' }, `Domain ${d}: ${manifest.domains[d].title}`),
        el('div', { class: 'rows' }, manifest.domains[d].categories.map((c) => {
          const q = tally(itemIdsIn('q', c), questionStatus);
          const p = tally(itemIdsIn('p', c), problemStatus);
          return el('div', { class: 'practice-row' },
            el('p', { class: 'practice-row-title' }, el('span', { class: 'rollup-id' }, c), manifest.categories[c].title),
            el('div', { class: 'practice-row-links' },
              el('a', { class: 'chip', href: `#/qa/${c}` }, `Questions (${q.total})`),
              el('span', { class: 'muted small' }, q.right + q.wrong ? `${q.right} right, ${q.wrong} missed` : 'Not started'),
              el('a', { class: 'chip', href: `#/wb/${c}` }, `Workbook (${p.total})`),
              el('span', { class: 'muted small' }, p.right + p.wrong ? `${p.right} got it, ${p.wrong} missed` : 'Not started')));
        })),
      ]),
    ],
  };
}

// A practice list covers one focus point (?fp=), one topic (?t=), or the whole category.
function practiceScope(cid, query) {
  if (query.fp) return manifest.focus[query.fp] ? { kind: 'fp', id: query.fp } : null;
  if (query.t) return manifest.topics[query.t] && query.t.startsWith(`${cid}.`) ? { kind: 'topic', id: query.t } : null;
  return { kind: 'category', id: cid };
}

function scopeIds(kind, scope) {
  if (scope.kind === 'fp') return manifest.focus[scope.id][kind];
  return itemIdsIn(kind, scope.id);
}

function scopeHeading(scope) {
  if (scope.kind === 'fp') return `Focus point ${scope.id}: ${manifest.focus[scope.id].title.replace(/<[^>]+>/g, '')}`;
  if (scope.kind === 'topic') return `Topic ${scope.id} ${manifest.topics[scope.id].title}`;
  return `${scope.id} ${manifest.categories[scope.id].title}`;
}

// Chips to widen or narrow the list: focus point, its topic, its category.
function scopeSwitch(section, cid, scope) {
  const options = [];
  if (scope.kind === 'fp') options.push([scope.id, `#/${section}/${cid}?fp=${scope.id}`, true]);
  const tid = scope.kind === 'fp' ? manifest.focus[scope.id].topic : scope.kind === 'topic' ? scope.id : null;
  if (tid) options.push([`Topic ${tid}`, `#/${section}/${tid.slice(0, 3)}?t=${tid}`, scope.kind === 'topic']);
  const catId = tid ? tid.slice(0, 3) : cid;
  options.push([`All of ${catId}`, `#/${section}/${catId}`, scope.kind === 'category']);
  const other = section === 'qa' ? 'wb' : 'qa';
  const otherHref = scope.kind === 'fp' ? `#/${other}/${cid}?fp=${scope.id}` : scope.kind === 'topic' ? `#/${other}/${cid}?t=${scope.id}` : `#/${other}/${cid}`;
  const otherCount = scopeIds(other === 'qa' ? 'q' : 'p', scope).length;
  return el('div', { class: 'jump' },
    options.map(([label, href, current]) => el('a', { href, class: current ? 'current' : null, 'aria-current': current ? 'page' : null }, label)),
    otherCount ? el('a', { href: otherHref }, other === 'qa' ? `Questions (${otherCount})` : `Workbook (${otherCount})`) : null);
}

function summaryLine(ids, statusFn, words) {
  const t = tally(ids, statusFn);
  const untried = t.total - t.right - t.wrong;
  return `${plural(t.total, words[0])}. ${t.right} ${words[1]}, ${t.wrong} missed, ${untried} not tried.`;
}

const FORMAT_KEYS = { 'Multiple choice': 'mc', 'True/False': 'tf', 'Select two': 's2' };

function filterItems(kind, items, query) {
  const statusFn = kind === 'q' ? questionStatus : problemStatus;
  return items.filter((it) => {
    const status = statusFn(it.id);
    if (query.show === 'new' && status) return false;
    if (query.show === 'missed' && status !== 'wrong') return false;
    if (query.tag && !it.tests.some((f) => manifest.focus[f].tag === query.tag)) return false;
    if (kind === 'q' && query.format && FORMAT_KEYS[it.format] !== query.format) return false;
    if (kind === 'q' && query.bloom && it.bloom !== query.bloom) return false;
    return true;
  });
}

function filterBar(kind, query) {
  const set = (key, value) => {
    const next = { ...currentRoute().query };
    if (value) next[key] = value;
    else delete next[key];
    const path = location.hash.split('?')[0];
    const qs = new URLSearchParams(next).toString();
    replaceRoute(qs ? `${path}?${qs}` : path);
  };
  const select = (label, key, options) => el('label', { class: 'select' },
    el('span', { class: 'visually-hidden' }, label),
    el('select', { onchange: (e) => set(key, e.target.value) },
      options.map(([value, text]) => {
        const option = el('option', { value }, text);
        option.selected = (query[key] || '') === value;
        return option;
      })));
  const missedLabel = kind === 'q' ? 'Missed' : 'Missed it';
  return el('div', { class: 'filters' },
    el('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' },
      [['', 'All'], ['new', 'Not tried'], ['missed', missedLabel]].map(([value, text]) => el('button', {
        type: 'button',
        'aria-pressed': String((query.show || '') === value),
        onclick: () => set('show', value),
      }, text))),
    el('div', { class: 'filter-selects' },
      select('Focus point tag', 'tag', [['', 'Any tag'], ...Object.entries(TAG_NAMES)]),
      kind === 'q' ? select('Format', 'format', [['', 'Any format'], ['mc', 'Multiple choice'], ['tf', 'True or false'], ['s2', 'Select two']]) : null,
      kind === 'q' ? select('Bloom level', 'bloom', [['', 'Any Bloom level'], ...Object.values(BLOOM_NAMES).map((b) => [b, b])]) : null));
}

function isFiltered(query) {
  return !!(query.show || query.tag || query.format || query.bloom);
}

async function questionsView(cid, scope, query = {}) {
  const ids = scopeIds('q', scope);
  const questions = filterItems('q', await loadItems('q', ids), query);
  const summary = el('p', { class: 'page-sub' });
  const refresh = () => {
    summary.textContent = summaryLine(ids, questionStatus, ['question', 'right'])
      + (isFiltered(query) ? ` Showing ${questions.length} that match the filters.` : '');
  };
  refresh();
  return {
    title: `Questions ${cid}`,
    tab: 'practice',
    body: [
      el('h1', { class: 'page-title' }, 'Questions'),
      el('p', { class: 'scope-heading' }, scopeHeading(scope)),
      summary,
      scopeSwitch('qa', cid, scope),
      ids.length ? filterBar('q', query) : null,
      !ids.length
        ? el('p', { class: 'empty' }, 'No questions test this yet. Use the workbook or the study guide for it.')
        : questions.length
          ? el('div', { class: 'items' }, questions.map((q) => questionCard(q, refresh)))
          : el('p', { class: 'empty' }, 'No questions match these filters. Change a filter above to see more.'),
    ],
  };
}

async function workbookView(cid, scope, query = {}) {
  const ids = scopeIds('p', scope);
  const problems = filterItems('p', await loadItems('p', ids), query);
  const summary = el('p', { class: 'page-sub' });
  const refresh = () => {
    summary.textContent = summaryLine(ids, problemStatus, ['problem', 'got it'])
      + (isFiltered(query) ? ` Showing ${problems.length} that match the filters.` : '');
  };
  refresh();
  return {
    title: `Workbook ${cid}`,
    tab: 'practice',
    body: [
      el('h1', { class: 'page-title' }, 'Workbook'),
      el('p', { class: 'scope-heading' }, scopeHeading(scope)),
      summary,
      scopeSwitch('wb', cid, scope),
      ids.length ? filterBar('p', query) : null,
      el('p', { class: 'muted small' }, 'Work each problem on paper with a calculator, then show the answer and mark how you did.'),
      !ids.length
        ? el('p', { class: 'empty' }, 'No workbook problems practice this yet. Try the questions or the study guide.')
        : problems.length
          ? el('div', { class: 'items' }, problems.map((p) => problemCard(p, refresh)))
          : el('p', { class: 'empty' }, 'No problems match these filters. Change a filter above to see more.'),
    ],
  };
}

function formatLabel(q) {
  if (q.format === 'Select two') return 'Select two';
  if (q.format === 'True/False') return 'True or false';
  return 'Multiple choice';
}

// fresh: always start unanswered (the review queue), even if there is an earlier answer.
function questionCard(q, onChange, fresh) {
  const card = el('article', { class: 'item', id: `q-${q.id}` });
  const prior = fresh ? null : progress.question[q.id];
  drawQuestion(card, q, prior ? { answered: prior.lastAnswer } : { chosen: [] }, onChange);
  return card;
}

// Answered state shows the result and explanation; "Try again" redraws the open state.
function drawQuestion(card, q, st, onChange) {
  const need = q.format === 'Select two' ? 2 : 1;
  const answered = st.answered || null;
  const chosen = answered || st.chosen;
  const correct = answered && sameLetters(answered, q.answer);

  const submit = (letters) => {
    recordAnswer(q.id, letters, sameLetters(letters, q.answer));
    drawQuestion(card, q, { answered: [...letters].sort() }, onChange);
    onChange();
    const result = card.querySelector('.result');
    if (result) result.focus({ preventScroll: true });
  };
  const pick = (letter) => {
    if (need === 1) return submit([letter]);
    const next = chosen.includes(letter) ? chosen.filter((l) => l !== letter) : chosen.length < need ? [...chosen, letter] : chosen;
    drawQuestion(card, q, { chosen: next }, onChange);
  };

  card.replaceChildren(...nodes(
    el('div', { class: 'item-head' },
      el('h3', {}, `Question ${q.id}`),
      el('span', { class: 'item-meta' }, `${formatLabel(q)}, ${q.bloom}`)),
    el('div', { class: 'prose', html: q.stem }),
    need > 1 && !answered ? el('p', { class: 'hint' }, `Choose two answers, then check. ${chosen.length} of 2 chosen.`) : null,
    el('div', { class: 'options', role: 'group', 'aria-label': `Answers for question ${q.id}` },
      q.options.map((o) => {
        const picked = chosen.includes(o.letter);
        const isRight = q.answer.includes(o.letter);
        let cls = 'option';
        let note = null;
        if (answered) {
          if (isRight) { cls += ' right'; note = picked ? 'Correct answer, your pick' : 'Correct answer'; }
          else if (picked) { cls += ' wrong'; note = 'Your pick'; }
        } else if (picked) {
          cls += ' picked';
        }
        return el('button', {
          type: 'button',
          class: cls,
          'aria-pressed': answered ? null : String(picked),
          disabled: !!answered,
          onclick: () => pick(o.letter),
        },
        el('span', { class: 'option-letter' }, o.letter),
        el('span', { class: 'option-body' }, el('span', { html: o.html }), note ? el('span', { class: 'option-note' }, note) : null));
      })),
    need > 1 && !answered
      ? el('button', { type: 'button', class: 'button-link', disabled: chosen.length !== need, onclick: () => submit(chosen) }, 'Check answer')
      : null,
    answered
      ? [
        el('p', { class: `result ${correct ? 'is-right' : 'is-wrong'}`, tabindex: '-1' },
          correct ? 'Correct.' : `Missed. The answer is ${q.answer.join(' and ')}.`),
        el('div', { class: 'prose explanation', html: q.explanation }),
        el('button', { type: 'button', class: 'text-button', onclick: () => drawQuestion(card, q, { chosen: [] }, onChange) }, 'Try again'),
      ]
      : null,
    testsRow(q.tests, `question ${q.id}`)));
}

function problemCard(p, onChange) {
  const card = el('article', { class: 'item', id: `p-${p.id}` });
  drawProblem(card, p, false, onChange);
  return card;
}

function drawProblem(card, p, shown, onChange) {
  const grade = problemStatus(p.id);
  const gradeButton = (value, label) => el('button', {
    type: 'button',
    class: `grade-btn${grade === value ? ` selected ${value === 'wrong' ? 'is-wrong' : 'is-right'}` : ''}`,
    'aria-pressed': String(grade === value),
    onclick: () => { recordGrade(p.id, value); drawProblem(card, p, true, onChange); onChange(); },
  }, label);

  card.replaceChildren(...nodes(
    el('div', { class: 'item-head' },
      el('h3', {}, `Problem ${p.id}`),
      grade ? el('span', { class: `item-meta${grade === 'wrong' ? ' is-wrong' : ''}` }, grade === 'right' ? 'Last time: got it' : 'Last time: missed it') : null),
    el('div', { class: 'prose', html: p.text }),
    shown
      ? [
        el('div', { class: 'answer' }, el('p', { class: 'answer-label' }, 'Answer'), el('div', { class: 'prose', html: p.answer })),
        el('div', { class: 'grade', role: 'group', 'aria-label': 'How did you do?' }, gradeButton('right', 'Got it'), gradeButton('wrong', 'Missed it')),
      ]
      : el('button', { type: 'button', class: 'button-link', onclick: () => { recordReveal(p.id); drawProblem(card, p, true, onChange); } }, 'Show answer'),
    testsRow(p.tests, `problem ${p.id}`)));
}

// ---------- views: practice exams ----------

function fmtClock(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function fmtDate(t) {
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function examItems(examId, itemIds) {
  if (itemIds) return (await loadItems('q', itemIds)).map((q) => ({ ...q, domain: q.id[0] }));
  return (await loadExam(examId)).items;
}

// Scores an exam whose time ran out while the app was closed, then shows its result.
async function finishExpiredExam() {
  const a = progress.activeExam;
  const index = finishExam(await examItems(a.examId, a.itemIds), true);
  location.replace(`#/exam/result/${index}`);
  return { title: 'Practice exam', tab: 'practice', body: el('p', { class: 'loading' }, 'Time is up. Scoring the exam…') };
}

function examCard(alwaysShow) {
  const a = progress.activeExam;
  if (a) {
    const left = examTimeLeft();
    return el('a', { class: 'continue', href: '#/exam/run' },
      el('div', {},
        el('span', {}, 'Exam in progress'),
        el('strong', {}, left ? `${a.title}: ${fmtClock(left)} left` : `${a.title}: time is up, see your score`)),
      el('span', { class: 'continue-go' }, left ? 'Resume' : 'Open'));
  }
  const last = progress.exams[progress.exams.length - 1];
  if (!alwaysShow && !last) return null;
  return el('a', { class: 'continue', href: '#/exam' },
    el('div', {},
      el('span', {}, 'Practice exams'),
      el('strong', {}, last ? `Last score ${last.score}% on ${fmtDate(last.finished)}` : '100 questions, 3 hours, 70% to pass')),
    el('span', { class: 'continue-go' }, 'Open'));
}

function examView() {
  const active = progress.activeExam;
  if (active && !examTimeLeft()) return finishExpiredExam();
  const attempts = progress.exams.map((r, i) => ({ ...r, index: i })).reverse();
  return {
    title: 'Practice exams',
    tab: 'practice',
    body: [
      el('h1', { class: 'page-title' }, 'Practice exams'),
      el('p', { class: 'page-sub' }, 'Set up like the real exam: 100 questions, 3 hours, 70% to pass. Use a calculator and open the IASSC Reference Document alongside. The timer keeps running if you leave or close the app.'),
      active
        ? el('div', { class: 'notice' },
          el('p', {}, el('strong', {}, `In progress: ${active.title}. `),
            `${examAnswered(active)} answered, ${fmtClock(examTimeLeft())} left.`),
          el('div', { class: 'button-row' },
            el('a', { class: 'button-link', href: '#/exam/run' }, 'Resume exam'),
            el('button', {
              type: 'button',
              class: 'button-secondary',
              onclick: () => {
                if (!confirm('Abandon this exam? Your answers so far will not be scored or saved.')) return;
                abandonExam();
                render();
              },
            }, 'Abandon exam')),
          el('p', {}))
        : el('div', { class: 'rows' }, examDefs().map((def) => {
          const mine = progress.exams.filter((r) => r.id === def.id);
          const best = mine.length ? Math.max(...mine.map((r) => r.score)) : null;
          return el('div', { class: 'exam-choice' },
            el('p', { class: 'practice-row-title' }, def.title),
            el('p', { class: 'muted small' }, def.id === 'random'
              ? `${def.count} questions drawn at random from the ${allItemIds('q').length} practice questions, 20 per phase. Questions repeat across attempts, and you may have seen them in Practice.`
              : `A fixed set of ${def.count} original questions, 20 per phase, with explanations after you finish.`),
            el('p', { class: 'muted small' }, best == null ? 'Not taken yet.' : `Taken ${plural(mine.length, 'time')}. Best score ${best}%.`),
            el('button', {
              type: 'button',
              class: 'button-link',
              onclick: () => {
                if (!confirm(`Start ${def.title}?\n\nThe ${def.minutes / 60}-hour timer starts now and keeps running even if you close the app.`)) return;
                startExam(def, def.id === 'random' ? randomExamIds() : null);
                location.hash = '#/exam/run';
              },
            }, 'Start exam'));
        })),
      attempts.length ? el('h2', { class: 'section-title' }, 'Past attempts') : null,
      attempts.length
        ? el('div', { class: 'rows' }, attempts.map((r) => el('a', { class: 'attempt', href: `#/exam/result/${r.index}` },
          el('span', {}, el('strong', {}, r.title), el('span', { class: 'muted small' }, fmtDate(r.finished))),
          el('span', { class: `attempt-score ${r.score >= r.passPercent ? 'is-right' : 'is-wrong'}` }, `${r.score}%`))))
        : null,
    ],
  };
}

async function examRunView() {
  const active = progress.activeExam;
  if (!active) {
    return {
      title: 'Practice exam',
      tab: 'practice',
      body: [el('p', { class: 'empty' }, 'No exam is running.'), el('a', { class: 'button-link', href: '#/exam' }, 'Choose an exam')],
    };
  }
  if (!examTimeLeft()) return finishExpiredExam();
  const items = await examItems(active.examId, active.itemIds);
  let mode = 'question';
  const clock = el('span', { class: 'exam-clock', role: 'timer', 'aria-label': 'Time left' });
  const counter = el('span', { class: 'exam-count' });
  const toggle = el('button', { type: 'button', class: 'text-button', onclick: () => { mode = mode === 'grid' ? 'question' : 'grid'; draw(); } });
  const stage = el('div', { class: 'exam-stage' });

  const submit = (timedOut) => {
    clearInterval(examTimer);
    const index = finishExam(items, timedOut);
    location.replace(`#/exam/result/${index}`);
  };
  const tick = () => {
    const left = examTimeLeft();
    clock.textContent = fmtClock(left);
    if (!left) submit(true);
  };
  const go = (i) => { setExamCurrent(i); mode = 'question'; draw(); window.scrollTo(0, 0); };

  function draw() {
    counter.textContent = `${examAnswered(active)} of ${items.length} answered`;
    toggle.textContent = mode === 'grid' ? 'Back to question' : 'All questions';
    if (mode === 'grid') return stage.replaceChildren(...nodes(drawGrid()));
    if (mode === 'finish') return stage.replaceChildren(...nodes(drawFinish()));
    return stage.replaceChildren(...nodes(drawItem()));
  }

  function drawItem() {
    const i = active.current;
    const it = items[i];
    const need = it.answer.length > 1 ? 2 : 1;
    const chosen = active.answers[i] || [];
    const flagged = active.flagged.includes(i);
    const pick = (letter) => {
      let next;
      if (need === 1) next = chosen.includes(letter) ? [] : [letter];
      else next = chosen.includes(letter) ? chosen.filter((l) => l !== letter) : chosen.length < need ? [...chosen, letter] : chosen;
      setExamAnswer(i, next);
      draw();
    };
    const last = i === items.length - 1;
    return [
      el('div', { class: 'item-head' },
        el('h3', {}, `Question ${i + 1} of ${items.length}`),
        el('span', { class: 'item-meta' }, manifest.domains[it.domain].title)),
      el('div', { class: 'prose', html: it.stem }),
      need > 1 ? el('p', { class: 'hint' }, `Choose two answers. ${chosen.length} of 2 chosen.`) : null,
      el('div', { class: 'options', role: 'group', 'aria-label': `Answers for question ${i + 1}` },
        it.options.map((o) => el('button', {
          type: 'button',
          class: `option${chosen.includes(o.letter) ? ' picked' : ''}`,
          'aria-pressed': String(chosen.includes(o.letter)),
          onclick: () => pick(o.letter),
        }, el('span', { class: 'option-letter' }, o.letter), el('span', { class: 'option-body' }, el('span', { html: o.html }))))),
      el('button', {
        type: 'button',
        class: `text-button flag${flagged ? ' on' : ''}`,
        'aria-pressed': String(flagged),
        onclick: () => { toggleExamFlag(i); draw(); },
      }, flagged ? 'Flagged for review. Tap to clear.' : 'Flag for review'),
      el('div', { class: 'exam-pager' },
        el('button', { type: 'button', class: 'button-secondary', disabled: i === 0, onclick: () => go(i - 1) }, 'Previous'),
        last
          ? el('button', { type: 'button', class: 'button-link', onclick: () => { mode = 'finish'; draw(); window.scrollTo(0, 0); } }, 'Review and submit')
          : el('button', { type: 'button', class: 'button-link', onclick: () => go(i + 1) }, 'Next')),
    ];
  }

  function drawGrid() {
    return [
      el('p', { class: 'legend' },
        el('span', {}, el('span', { class: 'cell-key answered' }), 'Answered'),
        el('span', {}, el('span', { class: 'cell-key' }), 'Not answered'),
        el('span', {}, el('span', { class: 'cell-key flagged' }), 'Flagged')),
      el('div', { class: 'exam-grid' }, items.map((it, i) => {
        const answered = (active.answers[i] || []).length > 0;
        const flagged = active.flagged.includes(i);
        return el('button', {
          type: 'button',
          class: `cell${answered ? ' answered' : ''}${flagged ? ' flagged' : ''}${i === active.current ? ' current' : ''}`,
          'aria-label': `Question ${i + 1}, ${answered ? 'answered' : 'not answered'}${flagged ? ', flagged' : ''}`,
          onclick: () => go(i),
        }, String(i + 1));
      })),
      el('button', { type: 'button', class: 'button-link', onclick: () => { mode = 'finish'; draw(); } }, 'Review and submit'),
    ];
  }

  function drawFinish() {
    const unanswered = items.map((_, i) => i).filter((i) => !(active.answers[i] || []).length);
    const flagged = [...active.flagged].sort((a, b) => a - b);
    const jumpList = (list) => el('div', { class: 'jump' }, list.map((i) => el('button', { type: 'button', class: 'chip', onclick: () => go(i) }, String(i + 1))));
    return [
      el('h2', { class: 'section-title' }, 'Ready to submit?'),
      el('p', {}, `${examAnswered(active)} of ${items.length} answered, with ${fmtClock(examTimeLeft())} left.`),
      unanswered.length ? [el('p', { class: 'muted' }, `Not answered (${unanswered.length}). Unanswered questions count as wrong.`), jumpList(unanswered)] : null,
      flagged.length ? [el('p', { class: 'muted' }, `Flagged for review (${flagged.length}).`), jumpList(flagged)] : null,
      el('div', { class: 'button-row' },
        el('button', {
          type: 'button',
          class: 'button-link',
          onclick: () => {
            if (unanswered.length && !confirm(`Submit with ${plural(unanswered.length, 'question')} not answered? They count as wrong.`)) return;
            submit(false);
          },
        }, 'Submit exam'),
        el('button', { type: 'button', class: 'button-secondary', onclick: () => { mode = 'question'; draw(); } }, 'Keep working')),
    ];
  }

  draw();
  tick();
  examTimer = setInterval(tick, 1000);
  return {
    title: active.title,
    tab: 'practice',
    body: [el('div', { class: 'exam-bar' }, el('div', {}, clock, counter), toggle), stage],
  };
}

function reviewAnswerCard(item, given, n) {
  const answered = given.length > 0;
  const correct = answered && sameLetters(given, item.answer);
  return el('article', { class: 'item', id: `x-${n}` },
    el('div', { class: 'item-head' },
      el('h3', {}, `Question ${n}`),
      el('span', { class: 'item-meta' }, manifest.domains[item.domain].title)),
    el('div', { class: 'prose', html: item.stem }),
    el('div', { class: 'options' }, item.options.map((o) => {
      const picked = given.includes(o.letter);
      const isRight = item.answer.includes(o.letter);
      const cls = isRight ? ' right' : picked ? ' wrong' : '';
      const note = isRight ? (picked ? 'Correct answer, your pick' : 'Correct answer') : picked ? 'Your pick' : null;
      return el('div', { class: `option${cls}` },
        el('span', { class: 'option-letter' }, o.letter),
        el('span', { class: 'option-body' }, el('span', { html: o.html }), note ? el('span', { class: 'option-note' }, note) : null));
    })),
    el('p', { class: `result ${correct ? 'is-right' : 'is-wrong'}` },
      correct ? 'Correct.' : answered ? `Missed. The answer is ${item.answer.join(' and ')}.` : `Not answered. The answer is ${item.answer.join(' and ')}.`),
    el('div', { class: 'prose explanation', html: item.explanation }),
    testsRow(item.tests, `exam question ${n}`));
}

async function examResultView(index, query) {
  const r = progress.exams[index];
  const items = await examItems(r.id, r.itemIds);
  const given = (i) => r.answers[i] || [];
  const isMissed = (i) => !(given(i).length && sameLetters(given(i), items[i].answer));
  const passed = r.score >= r.passPercent;

  const missedFocus = {};
  items.forEach((it, i) => { if (isMissed(i)) it.tests.forEach((f) => { missedFocus[f] = (missedFocus[f] || 0) + 1; }); });
  const studyNext = Object.entries(missedFocus).sort((a, b) => b[1] - a[1] || byNaturalId(a[0], b[0])).slice(0, 10);

  const show = query.show || '';
  const shownIdx = items.map((_, i) => i).filter((i) => (show === 'missed' ? isMissed(i) : show === 'flagged' ? (r.flagged || []).includes(i) : true));
  const setShow = (v) => replaceRoute(v ? `#/exam/result/${index}?show=${v}` : `#/exam/result/${index}`);

  return {
    title: 'Exam result',
    tab: 'practice',
    body: [
      el('h1', { class: 'page-title' }, r.title),
      el('p', { class: 'page-sub' }, `Taken ${fmtDate(r.finished)}. ${fmtDuration(r.finished - r.started)} used${r.timedOut ? ', time ran out' : ''}.`),
      el('div', { class: 'hero' },
        el('span', { class: 'hero-pct' }, `${r.score}%`),
        el('div', { class: 'hero-caption' }, el('strong', {}, `${r.right} of ${r.total} right`), `Pass mark ${r.passPercent}%`)),
      el('p', { class: `verdict ${passed ? 'is-right' : 'is-wrong'}` },
        passed ? 'Passed: at or above the pass mark.' : `Below the pass mark by ${r.passPercent - r.score} points.`),
      el('h2', { class: 'section-title' }, 'By phase'),
      el('div', { class: 'rows' }, domainIds().filter((d) => r.byDomain[d]).map((d) => {
        const b = r.byDomain[d];
        const pct = Math.floor((b.right / b.total) * 100);
        return el('div', { class: 'rollup' },
          el('div', { class: 'rollup-head' },
            el('span', { class: 'rollup-label' }, manifest.domains[d].title),
            el('span', { class: 'rollup-pct' }, `${b.right} of ${b.total}, ${pct}%`)),
          el('div', { class: 'bar has-mark', role: 'presentation' },
            el('div', { class: 'bar-fill', style: `width:${pct}%` }),
            el('div', { class: 'bar-mark', style: `left:${r.passPercent}%` })));
      })),
      studyNext.length ? el('h2', { class: 'section-title' }, 'Study next') : null,
      studyNext.length ? el('p', { class: 'muted small' }, 'Focus points tested by the questions you missed, most missed first.') : null,
      studyNext.length
        ? el('div', { class: 'rows' }, studyNext.map(([fid, n]) => el('a', {
          class: 'study-next',
          id: `sn-${fid}`,
          href: `#/guide/${fid.slice(0, 3)}?fp=${fid}`,
          'data-back': 'exam result',
        },
        el('span', {}, el('span', { class: 'fp-id' }, fid), ' ', tagBadge(manifest.focus[fid].tag), ' ', el('span', { html: manifest.focus[fid].title })),
        el('span', { class: 'muted small' }, `missed ${n}`))))
        : null,
      el('h2', { class: 'section-title' }, 'Your answers'),
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Show answers' },
        [['', `All (${items.length})`], ['missed', `Missed (${items.filter((_, i) => isMissed(i)).length})`], ['flagged', `Flagged (${(r.flagged || []).length})`]]
          .map(([v, text]) => el('button', { type: 'button', 'aria-pressed': String(show === v), onclick: () => setShow(v) }, text))),
      shownIdx.length
        ? el('div', { class: 'items' }, shownIdx.map((i) => reviewAnswerCard(items[i], given(i), i + 1)))
        : el('p', { class: 'empty' }, show === 'missed' ? 'Nothing missed. Every answer was right.' : 'No questions were flagged.'),
      el('p', {}, el('a', { class: 'button-link', href: '#/exam' }, 'Back to practice exams')),
    ],
  };
}

// ---------- views: review queue ----------

function reviewCard(onlyWhenDue) {
  const due = dueQuestionIds().length;
  if (onlyWhenDue && !due) return null;
  const next = nextReviewTime();
  return el('a', { class: 'continue', href: '#/review' },
    el('div', {},
      el('span', {}, 'Review'),
      el('strong', {}, due ? `${plural(due, 'missed question')} due today` : next ? `Nothing due. Next review ${fmtDate(next)}` : 'Missed questions come back here')),
    el('span', { class: 'continue-go' }, 'Open'));
}

async function reviewView() {
  const ids = dueQuestionIds();
  const questions = await loadItems('q', ids);
  const summary = el('p', { class: 'page-sub' });
  const refresh = () => {
    const left = dueQuestionIds().length;
    summary.textContent = left
      ? `${plural(left, 'question')} due. A missed question comes back after 1 day, then 3, then 7. Three right answers in a row clear it.`
      : 'All caught up for today.';
  };
  refresh();
  const next = nextReviewTime();
  return {
    title: 'Review',
    tab: 'practice',
    body: [
      el('h1', { class: 'page-title' }, 'Review'),
      summary,
      ids.length
        ? el('div', { class: 'items' }, questions.map((q) => questionCard(q, refresh, true)))
        : el('p', { class: 'empty' }, next
          ? `Nothing due right now. The next review is ${fmtDate(next)}.`
          : 'Nothing to review yet. Questions you miss in Practice come back here the next day.'),
    ],
  };
}

// ---------- views: search ----------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Text with each search term wrapped in <mark>, built from text nodes so content is never parsed as HTML.
function highlight(text, terms) {
  if (!terms.length) return [text];
  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el('mark', {}, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function snippet(text, terms) {
  const lower = text.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  if (!hits.length) return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  const at = Math.min(...hits);
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + 140);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// Scores rows of [id, title, middle text, body]: every term must appear somewhere (AND);
// title hits weigh most, then the middle text, then the body; the whole phrase earns a bonus.
function scoreRows(rows, phrase, words, terms) {
  const scored = [];
  for (const row of rows) {
    const lc = row.lc || (row.lc = [row[1].toLowerCase(), row[2].toLowerCase(), row[3].toLowerCase()]);
    let score = 0;
    let ok = true;
    for (const t of terms) {
      let s = 0;
      if (row[0].startsWith(t)) s += 20;
      if (lc[0].includes(t)) s += 6;
      if (lc[1].includes(t)) s += 3;
      if (lc[2].includes(t)) s += 1;
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    if (words.length > 1) {
      if (lc[0].includes(phrase)) score += 12;
      else if (lc[1].includes(phrase) || lc[2].includes(phrase)) score += 4;
    }
    scored.push([score, row]);
  }
  return scored.sort((a, b) => b[0] - a[0] || byNaturalId(a[1][0], b[1][0]));
}

function searchResults(index, q) {
  if (!q) {
    return el('p', { class: 'muted' }, `Type a word, a phrase, or an ID like 3.4.1. Searches the in-depth readings and the titles, outline lines and study guide text of all ${index.focus.length} focus points.`);
  }
  const phrase = q.toLowerCase().replace(/\s+/g, ' ');
  const words = phrase.split(' ');
  // One-letter words ("paired t") match nearly everything, so drop them when longer words exist.
  const longer = words.filter((t) => t.length > 1);
  const terms = longer.length ? longer : words;
  const readingRows = index.readings.map((r) => r.row || (r.row = [r[0], r[1], '', r[2]]));
  // Readings are long, so a reading that keeps returning to the phrase is the one that teaches it.
  const mentions = (row) => Math.min(10, row.lc[2].split(phrase).length - 1);
  const readHits = scoreRows(readingRows, phrase, words, terms)
    .map(([score, row]) => [score + mentions(row), row])
    .sort((a, b) => b[0] - a[0] || byNaturalId(a[1][0], b[1][0]))
    .slice(0, 5);
  const scored = scoreRows(index.focus, phrase, words, terms);
  if (!scored.length && !readHits.length) return el('p', { class: 'empty' }, 'Nothing matches. Try fewer or shorter words.');
  const shown = scored.slice(0, 60);
  return [
    readHits.length ? el('h2', { class: 'section-title' }, 'In-depth readings') : null,
    readHits.length ? el('div', { class: 'rows' }, readHits.map(([, [tid, title, , body]]) => el('a', {
      class: 'search-hit', id: `sr-${tid}`, href: `#/read/${tid}`, 'data-back': 'search',
    },
    el('span', { class: 'search-title' }, el('span', { class: 'fp-id' }, tid), ' ', highlight(title, terms)),
    el('span', { class: 'search-snippet' }, highlight(snippet(body, terms), terms))))) : null,
    readHits.length && shown.length ? el('h2', { class: 'section-title' }, 'Focus points') : null,
    shown.length ? el('p', { class: 'muted small' }, scored.length > shown.length
      ? `${scored.length} focus points match. Showing the best ${shown.length}.`
      : `${plural(scored.length, 'focus point')} match.`) : null,
    shown.length ? el('div', { class: 'rows' }, shown.map(([, [id, title, text, body]]) => {
      const source = body.toLowerCase().includes(terms[0]) ? body : text;
      return el('a', { class: 'search-hit', id: `sr-${id}`, href: `#/guide/${id.slice(0, 3)}?fp=${id}`, 'data-back': 'search' },
        el('span', { class: 'search-title' }, el('span', { class: 'fp-id' }, id), ' ', tagBadge(manifest.focus[id].tag), ' ', highlight(title, terms)),
        el('span', { class: 'search-snippet' }, highlight(snippet(source, terms), terms)));
    })) : null,
  ];
}

async function searchView(query) {
  const index = await loadSearchIndex();
  const results = el('div', {});
  const input = el('input', {
    type: 'search',
    class: 'search-input',
    placeholder: 'Search, for example: paired t-test',
    'aria-label': 'Search the study guide',
    enterkeyhint: 'search',
    autocomplete: 'off',
  });
  input.value = query.q || '';
  let timer = null;
  const update = () => {
    const q = input.value.trim();
    replaceRoute(q ? `#/search?q=${encodeURIComponent(q)}` : '#/search', false);
    results.replaceChildren(...nodes(searchResults(index, q)));
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 150); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  results.replaceChildren(...nodes(searchResults(index, input.value.trim())));
  if (!input.value) setTimeout(() => input.focus(), 0);
  return {
    title: 'Search',
    tab: 'outline',
    body: [el('h1', { class: 'page-title' }, 'Search'), input, results],
  };
}

// ---------- views: settings ----------

function choiceGroup(label, options, current, onPick) {
  return el('div', { class: 'field' },
    el('p', { class: 'field-label' }, label),
    el('div', { class: 'segmented', role: 'group', 'aria-label': label },
      options.map(([value, text]) => el('button', {
        type: 'button',
        'aria-pressed': String(value === current),
        onclick: () => onPick(value),
      }, text))));
}

function settingsView() {
  const status = el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const say = (msg, isError) => {
    status.textContent = msg;
    status.classList.toggle('is-wrong', !!isError);
  };
  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'visually-hidden',
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: (e) => { importBackup(e.target.files[0], say); e.target.value = ''; },
  });
  const pick = (key) => (value) => { settings[key] = value; saveSettings(); applyAppearance(); render(); };
  const controller = 'serviceWorker' in navigator && navigator.serviceWorker.controller;
  return {
    title: 'Settings',
    tab: 'settings',
    body: [
      el('h1', { class: 'page-title' }, 'Settings'),
      el('h2', { class: 'section-title' }, 'Appearance'),
      choiceGroup('Theme', [['auto', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], settings.theme, pick('theme')),
      choiceGroup('Text size', [[1, 'Standard'], [1.12, 'Large'], [1.25, 'Larger']], settings.fontScale, pick('fontScale')),

      el('h2', { class: 'section-title' }, 'Backup'),
      el('p', {}, 'Your progress is saved only in this browser, on this device. Save a backup file after big study sessions, and keep it somewhere safe like your email or cloud storage.'),
      el('p', { class: 'muted' }, settings.lastBackup ? `Last backup: ${new Date(settings.lastBackup).toLocaleString()}.` : 'No backup saved yet.'),
      el('div', { class: 'button-row' },
        el('button', { type: 'button', class: 'button-link', onclick: () => exportBackup(say) }, 'Save backup file'),
        el('button', { type: 'button', class: 'button-secondary', onclick: () => fileInput.click() }, 'Restore from backup file'),
        fileInput),
      status,

      el('h2', { class: 'section-title' }, 'Start over'),
      el('p', {}, 'Erase every checkmark, answer and workbook grade on this device. Save a backup first if you might want them back.'),
      el('button', {
        type: 'button',
        class: 'button-secondary',
        onclick: () => {
          if (!confirm(`Erase all progress on this device?\n\nNow: ${progressSummary(progress)}.\n\nThis cannot be undone without a backup file.`)) return;
          resetProgress();
          say('All progress erased.');
        },
      }, 'Erase all progress'),

      el('h2', { class: 'section-title' }, 'About'),
      el('p', { class: 'muted' }, `Content version ${manifest.contentVersion}. Build ${manifest.build}.`),
      el('p', { class: 'muted' }, controller
        ? 'Saved for offline use on this device.'
        : 'Not saved for offline use yet. Open the app once with a connection, then reload.'),
    ],
  };
}

function exportBackup(say) {
  const payload = backupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `green-belt-progress-${payload.exported.slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  settings.lastBackup = payload.exported;
  saveSettings();
  say(`Backup saved: ${progressSummary(progress)}.`);
}

async function importBackup(file, say) {
  if (!file) return;
  let parsed;
  try {
    parsed = parseBackup(await file.text());
  } catch (err) {
    say(err.message, true);
    return;
  }
  const when = parsed.exported ? new Date(parsed.exported).toLocaleString() : 'an unknown date';
  const ok = confirm(`Replace the progress on this device with the backup from ${when}?\n\nBackup: ${progressSummary(parsed.progress)}.\nThis device now: ${progressSummary(progress)}.`);
  if (!ok) {
    say('Restore canceled. Nothing changed.');
    return;
  }
  if (replaceProgress(parsed.progress)) say(`Restored: ${progressSummary(progress)}.`);
  else say('The backup could not be saved on this device. Storage may be full or blocked.', true);
}

// ---------- install, offline and updates ----------

let installPrompt = null;
let updateRequested = false;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function installHint() {
  if (isStandalone() || settings.installHintDismissed) return null;
  let action;
  if (installPrompt) {
    action = el('button', {
      type: 'button',
      class: 'button-link',
      onclick: async () => {
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
        render();
      },
    }, 'Install app');
  } else if (isIos()) {
    action = el('p', {}, 'In Safari, tap the Share button, then Add to Home Screen.');
  } else {
    return null;
  }
  return el('div', { class: 'notice' },
    el('p', {}, el('strong', {}, 'Install the app to keep your progress safe. '),
      'Installed, it opens like an app and works with no signal. Browsers can clear saved progress for websites you have not opened in a while.'),
    action,
    el('button', { type: 'button', class: 'text-button', onclick: () => { settings.installHintDismissed = true; saveSettings(); render(); } }, 'Not now'));
}

// Only nags when there is real progress and no backup in the last 14 days.
function backupReminder() {
  const studied = Object.keys(progress.focus).length + Object.keys(progress.question).length + Object.keys(progress.problem).length;
  if (studied < 20) return null;
  if (settings.lastBackup && Date.now() - Date.parse(settings.lastBackup) < 14 * DAY_MS) return null;
  return el('a', { class: 'continue', href: '#/settings' },
    el('div', {},
      el('span', {}, settings.lastBackup ? `Last backup ${new Date(settings.lastBackup).toLocaleDateString()}` : 'No backup yet'),
      el('strong', {}, 'Save a backup of your progress')),
    el('span', { class: 'continue-go' }, 'Open'));
}

function showUpdateBanner(worker) {
  if (document.getElementById('update-banner')) return;
  document.body.classList.add('has-banner');
  document.body.append(el('div', { class: 'banner', id: 'update-banner', role: 'status' },
    el('span', {}, 'A new version of the app is ready.'),
    el('button', {
      type: 'button',
      class: 'button-link',
      onclick: () => { updateRequested = true; worker.postMessage('skip-waiting'); },
    }, 'Reload')));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      incoming.addEventListener('statechange', () => {
        // With no controller this is the first install, not an update.
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(incoming);
      });
    });
  }).catch(() => {});
  // The first install also fires controllerchange (clients.claim), so reload only when the reader asked.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
  });
}

function applyAppearance() {
  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  root.style.fontSize = settings.fontScale && settings.fontScale !== 1 ? `${settings.fontScale * 100}%` : '';
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (!currentRoute().parts.length) render();
});

window.addEventListener('appinstalled', () => { installPrompt = null; });

// ---------- start ----------

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
applyAppearance();
// Installed apps can ask the browser not to evict their storage; a plain tab asking would prompt in some browsers.
if (isStandalone() && navigator.storage && navigator.storage.persist) {
  navigator.storage.persisted().then((granted) => granted || navigator.storage.persist()).catch(() => {});
}
window.addEventListener('hashchange', onNavigate);
onNavigate();
registerServiceWorker();
