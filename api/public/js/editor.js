// Editor PDF: atur halaman (urut, putar, duplikat, hapus, halaman kosong, sisip PDF)
// dan isi halaman (ganti teks asli, teks baru, gambar, kotak, elips, garis, coretan, stabilo, hapus area).
// Semua perubahan disusun di peramban lalu diterapkan di server (PyMuPDF) saat disimpan.
import {
  ICONS, escapeHtml, formatBytes, h, loadPdfjs, openPdf, progressView, renderThumb, resultView, toast, uploadJob, waitJob,
} from './ui.js';

const TOOLBAR = [
  ['select', 'Pilih', 'Pilih & pindahkan objek (V)'],
  ['textEdit', 'Edit teks', 'Klik teks asli pada halaman untuk menggantinya (E)'],
  ['text', 'Teks', 'Tambah teks baru (T)'],
  ['image', 'Gambar', 'Sisipkan gambar atau tanda tangan (I)'],
  ['rect', 'Kotak', 'Gambar kotak (R)'],
  ['ellipse', 'Elips', 'Gambar elips/lingkaran (O)'],
  ['line', 'Garis', 'Gambar garis (L)'],
  ['draw', 'Coret', 'Coretan bebas / tanda tangan (D)'],
  ['highlight', 'Stabilo', 'Tandai dengan stabilo (H)'],
  ['whiteout', 'Tutup', 'Tutup area dengan warna putih (W)'],
];
const SHORTCUT = { v: 'select', e: 'textEdit', t: 'text', i: 'image', r: 'rect', o: 'ellipse', l: 'line', d: 'draw', h: 'highlight', w: 'whiteout' };
const FONT_CSS = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};
const HINT = {
  select: 'Klik objek untuk memilih. Klik dua kali pada teks untuk mengubah isinya.',
  textEdit: 'Klik teks asli pada halaman untuk menggantinya. Teks lama benar-benar dihapus saat disimpan.',
  text: 'Klik di halaman untuk menaruh teks baru.',
  image: 'Klik di halaman untuk menaruh gambar (PNG/JPG).',
  rect: 'Seret di halaman untuk membuat kotak.',
  ellipse: 'Seret di halaman untuk membuat elips.',
  line: 'Seret dari titik awal ke titik akhir.',
  draw: 'Seret untuk mencoret atau membubuhkan tanda tangan.',
  highlight: 'Seret di atas teks yang ingin ditandai.',
  whiteout: 'Seret untuk menutup area dengan warna putih.',
};

let uid = 1;
const nid = () => `o${uid++}`;
const clone = (v) => structuredClone(v);
const round = (n) => Math.round(n * 100) / 100;

export function mountEditor(root, tool, initialFile) {
  const S = {
    sources: [], // [{file, pdf, name}] — 0 = PDF utama
    assets: [], // [{file, url, w, h}]
    pages: [],
    cur: 0,
    tool: 'select',
    sel: null,
    editing: null,
    zoom: 1,
    password: null,
    dirty: false,
    style: { color: '#1b1f2a', size: 14, font: 'sans', bold: false, italic: false, align: 'left',
      stroke: '#c2364f', fill: '', strokeWidth: 2, opacity: 1, hl: '#ffe14d' },
    undo: [],
    redo: [],
  };
  const thumbCache = new Map();
  let renderTask = null;
  let pageToken = 0;
  let scale = 1;
  let propSession = null;

  const ed = h(`<div class="ed">
    <div class="ed-bar" role="toolbar" aria-label="Alat edit">
      <span class="ed-file" title=""></span><span class="sep"></span>
      ${TOOLBAR.map(([id, label, title]) => `<button class="tool-btn" type="button" data-tool="${id}" title="${title}" aria-pressed="${id === 'select'}">${ICONS[id]}<span>${label}</span></button>`).join('')}
      <span class="sep"></span>
      <button class="tool-btn" type="button" data-act="undo" title="Urungkan (Ctrl+Z)">${ICONS.undo}<span>Urungkan</span></button>
      <button class="tool-btn" type="button" data-act="redo" title="Ulangi (Ctrl+Y)">${ICONS.redo}<span>Ulangi</span></button>
      <span class="grow"></span>
      <button class="btn btn-primary" type="button" data-act="save">${ICONS.save} Simpan PDF</button>
    </div>
    <div class="ed-props" aria-live="polite"></div>
    <div class="ed-body">
      <aside class="ed-thumbs" aria-label="Halaman"></aside>
      <div class="ed-main"></div>
    </div>
  </div>`);
  root.replaceChildren(ed);
  const $ = (q) => ed.querySelector(q);
  const mainEl = $('.ed-main');
  const thumbsEl = $('.ed-thumbs');
  const propsEl = $('.ed-props');

  // ── Riwayat ───────────────────────────────────────────────
  const snapshot = () => ({ pages: clone(S.pages), cur: S.cur });
  function pushHistory() {
    S.undo.push(snapshot());
    if (S.undo.length > 60) S.undo.shift();
    S.redo = [];
    S.dirty = true;
    updateUndoButtons();
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot());
    const snap = from.pop();
    S.pages = snap.pages;
    S.cur = Math.min(snap.cur, S.pages.length - 1);
    S.sel = null;
    S.editing = null;
    renderAll();
  }
  function updateUndoButtons() {
    $('[data-act=undo]').disabled = !S.undo.length;
    $('[data-act=redo]').disabled = !S.redo.length;
  }

  const page = () => S.pages[S.cur];
  const findObj = (id) => page()?.objects.find((o) => o.id === id);
  const rotDims = (p) => (p.rotate % 180 ? [p.h, p.w] : [p.w, p.h]);

  // ── Memuat dokumen ────────────────────────────────────────
  async function loadPdf(file, { asMain }) {
    let pdf;
    try {
      pdf = await openPdf(file);
    } catch (err) {
      if (err?.name !== 'PasswordException') throw new Error(`"${file.name}" bukan PDF yang valid atau rusak.`);
      if (!asMain) throw new Error(`"${file.name}" terkunci password. Buka dulu dengan alat Unlock PDF.`);
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const pw = await askPassword(file.name);
        if (pw === null) throw new Error('Dibatalkan.');
        try {
          // eslint-disable-next-line no-await-in-loop
          pdf = await openPdf(file, pw);
          S.password = pw;
          break;
        } catch { toast('Password salah. Coba lagi.'); }
      }
    }
    const index = S.sources.push({ file, pdf, name: file.name }) - 1;
    const pages = [];
    for (let i = 0; i < pdf.numPages; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const pg = await pdf.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1 });
      pages.push({ key: nid(), src: { file: index, page: i }, blank: null, rotate: 0, objects: [], w: vp.width, h: vp.height });
    }
    return pages;
  }

  async function openMain(file) {
    try {
      mainEl.replaceChildren(h('<div class="ed-empty"><p>Membuka dokumen…</p></div>'));
      S.pages = await loadPdf(file, { asMain: true });
      S.cur = 0;
      $('.ed-file').textContent = file.name;
      $('.ed-file').title = `${file.name} · ${formatBytes(file.size)}`;
      renderAll();
    } catch (err) {
      S.sources = [];
      showEmpty(err.message);
    }
  }

  function showEmpty(error) {
    ed.querySelectorAll('.ed-bar button').forEach((b) => { b.disabled = true; });
    thumbsEl.replaceChildren();
    propsEl.replaceChildren(h('<span class="hint">Buka file PDF untuk mulai mengedit.</span>'));
    const dz = h(`<div class="ed-empty"><div class="dropzone">
      ${error ? `<div class="error-box" role="alert">${escapeHtml(error)}</div>` : ''}
      <p class="dz-title">Pilih PDF yang ingin diedit</p>
      <p class="dz-sub">Atur halaman, ganti teks, tambah teks, gambar, bentuk, dan tanda tangan.</p>
      <button class="btn btn-primary" type="button">${ICONS.upload} Pilih PDF</button></div></div>`);
    const pick = async () => {
      const [f] = await pickFile('.pdf');
      if (f) { ed.querySelectorAll('.ed-bar button').forEach((b) => { b.disabled = false; }); openMain(f); }
    };
    dz.querySelector('button').addEventListener('click', pick);
    const zone = dz.querySelector('.dropzone');
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = [...e.dataTransfer.files].find((x) => /\.pdf$/i.test(x.name));
      if (f) { ed.querySelectorAll('.ed-bar button').forEach((b) => { b.disabled = false; }); openMain(f); }
    });
    mainEl.replaceChildren(dz);
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.addEventListener('change', () => resolve([...input.files]));
      input.click();
    });
  }

  function askPassword(name) {
    return new Promise((resolve) => {
      const m = h(`<div class="ed-modal-back"><form class="ed-modal panel">
        <h2>PDF ini dilindungi password</h2>
        <p style="margin:0 0 14px;color:var(--ink-2)">${escapeHtml(name)}</p>
        <div class="field"><label for="ed-pw">Password</label><input class="input" id="ed-pw" type="password" autocomplete="off" required></div>
        <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" type="button" data-cancel>Batal</button>
        <button class="btn btn-primary" type="submit">Buka</button></div></form></div>`);
      document.body.append(m);
      m.querySelector('input').focus();
      m.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); const v = m.querySelector('input').value; m.remove(); resolve(v); });
      m.querySelector('[data-cancel]').addEventListener('click', () => { m.remove(); resolve(null); });
    });
  }

  // ── Thumbnail halaman ─────────────────────────────────────
  function thumbUrl(p) {
    if (!p.src) return Promise.resolve(null);
    const k = `${p.src.file}:${p.src.page}`;
    if (!thumbCache.has(k)) thumbCache.set(k, renderThumb(S.sources[p.src.file].pdf, p.src.page, 260).then((t) => t.url));
    return thumbCache.get(k);
  }

  let dragFrom = null;
  function renderThumbs() {
    const list = S.pages.map((p, i) => {
      const [rw, rh] = rotDims(p);
      const k = Math.min(132 / rw, 140 / rh);
      const el = h(`<div class="ed-thumb" draggable="true" tabindex="0" role="button" data-i="${i}" aria-current="${i === S.cur}"
          aria-label="Halaman ${i + 1}${p.rotate ? `, diputar ${p.rotate}°` : ''}">
        ${p.objects.length ? '<span class="edited-dot" title="Halaman ini diedit"></span>' : ''}
        <div class="tframe"><div class="tpage" style="width:${p.w * k}px;height:${p.h * k}px;transform:rotate(${p.rotate}deg)"></div></div>
        <div class="tnum">${i + 1}${p.blank ? ' · kosong' : ''}</div>
        <div class="tacts">
          <button class="icon-btn" type="button" data-pa="rotl" title="Putar ke kiri" aria-label="Putar halaman ${i + 1} ke kiri">${ICONS.rotl}</button>
          <button class="icon-btn" type="button" data-pa="rotr" title="Putar ke kanan" aria-label="Putar halaman ${i + 1} ke kanan">${ICONS.rotr}</button>
          <button class="icon-btn" type="button" data-pa="dup" title="Duplikat" aria-label="Duplikat halaman ${i + 1}">${ICONS.copy}</button>
          <button class="icon-btn danger" type="button" data-pa="del" title="Hapus halaman" aria-label="Hapus halaman ${i + 1}">${ICONS.trash}</button>
        </div></div>`);
      thumbUrl(p).then((url) => { if (url) el.querySelector('.tpage').replaceChildren(h(`<img alt="" src="${url}">`)); });
      el.addEventListener('click', (e) => {
        const act = e.target.closest('[data-pa]')?.dataset.pa;
        if (act) pageAction(act, i);
        else goTo(i);
      });
      el.addEventListener('keydown', (e) => {
        if (e.target !== el) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTo(i); }
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); movePage(i, e.key === 'ArrowUp' ? i - 1 : i + 1); }
        if (e.key === 'Delete') pageAction('del', i);
      });
      el.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
      el.addEventListener('dragend', () => { dragFrom = null; thumbsEl.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before')); });
      el.addEventListener('dragover', (e) => { if (dragFrom !== null) { e.preventDefault(); el.classList.add('drop-before'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
      el.addEventListener('drop', (e) => { if (dragFrom === null) return; e.preventDefault(); movePage(dragFrom, i > dragFrom ? i - 1 : i); });
      return el;
    });
    const add = h(`<div class="add-page">
      <button class="btn" type="button" data-add="blank">${ICONS.blank} Halaman kosong</button>
      <button class="btn" type="button" data-add="pdf">${ICONS.insertPdf} Sisipkan PDF</button></div>`);
    add.querySelector('[data-add=blank]').addEventListener('click', () => {
      pushHistory();
      const ref = page();
      const [w, hgt] = ref ? rotDims(ref) : [595.28, 841.89];
      S.pages.splice(S.cur + 1, 0, { key: nid(), src: null, blank: { w, h: hgt }, rotate: 0, objects: [], w, h: hgt });
      goTo(S.cur + 1);
    });
    add.querySelector('[data-add=pdf]').addEventListener('click', async () => {
      const [f] = await pickFile('.pdf');
      if (!f) return;
      try {
        const pages = await loadPdf(f, { asMain: false });
        pushHistory();
        S.pages.splice(S.cur + 1, 0, ...pages);
        toast(`${pages.length} halaman dari "${f.name}" disisipkan.`);
        goTo(S.cur + 1);
      } catch (err) { toast(err.message); }
    });
    thumbsEl.replaceChildren(...list, add);
    thumbsEl.querySelector('[aria-current=true]')?.scrollIntoView({ block: 'nearest' });
  }

  function movePage(from, to) {
    if (to < 0 || to >= S.pages.length || from === to) return;
    pushHistory();
    const [p] = S.pages.splice(from, 1);
    S.pages.splice(to, 0, p);
    if (S.cur === from) S.cur = to;
    else if (from < S.cur && to >= S.cur) S.cur -= 1;
    else if (from > S.cur && to <= S.cur) S.cur += 1;
    renderAll();
    thumbsEl.querySelector(`[data-i="${to}"]`)?.focus();
  }

  function pageAction(act, i) {
    const p = S.pages[i];
    if (act === 'del') {
      if (S.pages.length === 1) { toast('Dokumen minimal berisi 1 halaman.'); return; }
      pushHistory();
      S.pages.splice(i, 1);
      S.cur = Math.min(S.cur > i ? S.cur - 1 : S.cur, S.pages.length - 1);
      S.sel = null;
    } else if (act === 'dup') {
      pushHistory();
      const copy = { ...clone(p), key: nid() };
      copy.objects.forEach((o) => { o.id = nid(); });
      S.pages.splice(i + 1, 0, copy);
      S.cur = i + 1;
    } else {
      pushHistory();
      p.rotate = (p.rotate + (act === 'rotr' ? 90 : 270)) % 360;
      S.cur = i;
    }
    renderAll();
  }

  function goTo(i) {
    S.cur = Math.max(0, Math.min(S.pages.length - 1, i));
    S.sel = null;
    S.editing = null;
    renderAll();
  }

  // ── Halaman utama & objek ─────────────────────────────────
  let stage;
  let layer;
  let svgLayer;
  let textLayer;

  function computeScale(p) {
    const [rw] = rotDims(p);
    const avail = Math.max(240, mainEl.clientWidth - 56);
    return Math.min(avail / rw, 1.5) * S.zoom;
  }

  async function renderPage() {
    const p = page();
    if (!p) return;
    const token = ++pageToken;
    scale = computeScale(p);
    const W = p.w * scale;
    const H = p.h * scale;
    const [rw, rh] = rotDims(p);
    const view = h(`<div>
      <div class="ed-pagebar">
        <div class="ed-pill">
          <button class="icon-btn" type="button" data-nav="-1" aria-label="Halaman sebelumnya"${S.cur === 0 ? ' disabled' : ''}>${ICONS.left}</button>
          <span>Hal ${S.cur + 1} / ${S.pages.length}</span>
          <button class="icon-btn" type="button" data-nav="1" aria-label="Halaman berikutnya"${S.cur === S.pages.length - 1 ? ' disabled' : ''}>${ICONS.right}</button>
        </div>
        <div class="ed-pill">
          <button class="icon-btn" type="button" data-zoom="-1" aria-label="Perkecil">${ICONS.zout}</button>
          <button class="btn btn-ghost" type="button" data-zoom="0" style="padding:4px 6px;font-size:13px" title="Sesuaikan lebar">${Math.round(S.zoom * 100)}%</button>
          <button class="icon-btn" type="button" data-zoom="1" aria-label="Perbesar">${ICONS.zin}</button>
        </div>
      </div>
      <div class="ed-scroll"><div class="ed-rot" style="width:${rw * scale}px;height:${rh * scale}px">
        <div class="ed-stage" data-tool="${S.tool}" style="width:${W}px;height:${H}px;transform:translate(-50%,-50%) rotate(${p.rotate}deg)">
          <canvas class="page"></canvas>
          <div class="ed-textlayer"></div>
          <div class="ed-layer"></div>
          <svg class="ed-svg" viewBox="0 0 ${p.w} ${p.h}" preserveAspectRatio="none"></svg>
        </div></div></div></div>`);
    stage = view.querySelector('.ed-stage');
    layer = view.querySelector('.ed-layer');
    svgLayer = view.querySelector('.ed-svg');
    textLayer = view.querySelector('.ed-textlayer');
    view.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => goTo(S.cur + Number(b.dataset.nav))));
    view.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
      const d = Number(b.dataset.zoom);
      S.zoom = d === 0 ? 1 : Math.min(4, Math.max(0.25, S.zoom * (d > 0 ? 1.25 : 0.8)));
      renderPage();
    }));
    bindStage();
    const scrollTop = mainEl.scrollTop;
    mainEl.replaceChildren(view);
    mainEl.scrollTop = scrollTop;
    renderObjects();

    if (p.src) {
      renderTask?.cancel();
      const src = S.sources[p.src.file];
      const pg = await src.pdf.getPage(p.src.page + 1);
      if (token !== pageToken) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = pg.getViewport({ scale: scale * dpr });
      const canvas = view.querySelector('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      renderTask = pg.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp });
      try { await renderTask.promise; } catch { /* dibatalkan */ }
      if (token === pageToken && S.tool === 'textEdit') buildTextLayer(pg);
    }
  }

  async function buildTextLayer(pg) {
    textLayer.replaceChildren();
    if (S.tool !== 'textEdit' || !pg) return;
    const lib = await loadPdfjs();
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    const used = new Set(page().objects.filter((o) => o.type === 'textEdit').map((o) => o.itemKey));
    const frag = document.createDocumentFragment();
    tc.items.forEach((item, idx) => {
      if (!item.str || !item.str.trim()) return;
      const tx = lib.Util.transform(vp.transform, item.transform);
      if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) return; // hanya teks horizontal
      const fh = Math.hypot(tx[2], tx[3]);
      const style = tc.styles[item.fontName] || {};
      const asc = style.ascent || 0.8;
      const desc = Math.abs(style.descent || 0.2);
      const left = tx[4];
      const top = tx[5] - fh * asc;
      const width = item.width * (vp.scale || 1);
      const height = fh * (asc + desc);
      const key = `${S.pages[S.cur].key}:${idx}`;
      if (used.has(key) || width <= 0) return;
      const fam = (style.fontFamily || '').toLowerCase();
      const span = document.createElement('span');
      span.title = 'Klik untuk mengganti teks ini';
      Object.assign(span.style, { left: `${left * scale}px`, top: `${top * scale}px`, width: `${width * scale}px`, height: `${height * scale}px` });
      span.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        pushHistory();
        const o = {
          id: nid(), type: 'textEdit', itemKey: key, text: item.str,
          orig: [round(left), round(top), round(left + width), round(top + height)],
          x: round(left), y: round(top), w: round(width), h: round(height),
          size: round(fh), color: '#000000', font: fam.includes('serif') && !fam.includes('sans') ? 'serif' : fam.includes('mono') ? 'mono' : 'sans',
          bold: /bold|black|heavy/.test((item.fontName || '') + fam), italic: false, overrides: {},
        };
        page().objects.push(o);
        span.remove();
        renderObjects();
        select(o.id);
        startEditing(o.id);
        renderThumbs();
      });
      frag.append(span);
    });
    textLayer.append(frag);
    if (!textLayer.childElementCount) toast('Tidak ada teks yang bisa diedit di halaman ini (mungkin hasil scan).');
  }

  function objStyle(o) {
    const s = scale;
    const base = { left: `${o.x * s}px`, top: `${o.y * s}px`, width: `${o.w * s}px`, height: `${o.h * s}px`, opacity: o.opacity ?? 1 };
    if (o.type === 'text' || o.type === 'textEdit') {
      return { left: base.left, top: base.top, opacity: base.opacity, fontSize: `${o.size * s}px`, fontFamily: FONT_CSS[o.font] || FONT_CSS.sans,
        color: o.type === 'textEdit' && !o.overrides?.color ? '#1b1f2a' : o.color, fontWeight: o.bold ? '700' : '400',
        fontStyle: o.italic ? 'italic' : 'normal', textAlign: o.align || 'left', minHeight: o.type === 'textEdit' ? `${o.h * s}px` : '',
        minWidth: o.type === 'textEdit' ? `${(o.orig[2] - o.orig[0]) * s}px` : '' };
    }
    if (o.type === 'rect' || o.type === 'ellipse') {
      return { ...base, border: o.stroke ? `${Math.max(o.strokeWidth * s, 0.5)}px solid ${o.stroke}` : '0', background: o.fill || 'transparent', boxSizing: 'border-box' };
    }
    if (o.type === 'highlight') return { ...base, background: o.color, opacity: o.opacity ?? 0.5 };
    return base;
  }

  function renderObjects() {
    if (!layer) return;
    const p = page();
    layer.replaceChildren();
    svgLayer.replaceChildren();
    for (const o of p.objects) {
      if (o.type === 'line' || o.type === 'draw') {
        const ns = 'http://www.w3.org/2000/svg';
        const g = document.createElementNS(ns, 'g');
        const mk = (tag) => {
          const el = document.createElementNS(ns, o.type === 'line' ? 'line' : 'polyline');
          if (o.type === 'line') { el.setAttribute('x1', o.x1); el.setAttribute('y1', o.y1); el.setAttribute('x2', o.x2); el.setAttribute('y2', o.y2); } else el.setAttribute('points', o.points.map((pt) => pt.join(',')).join(' '));
          el.setAttribute('fill', 'none');
          el.setAttribute('stroke-linecap', 'round');
          el.setAttribute('stroke-linejoin', 'round');
          if (tag === 'hit') { el.setAttribute('class', 'hit'); el.setAttribute('stroke-width', Math.max(o.strokeWidth, 10 / scale)); el.dataset.id = o.id; } else {
            el.setAttribute('stroke', o.stroke);
            el.setAttribute('stroke-width', o.strokeWidth);
            el.setAttribute('stroke-opacity', o.opacity ?? 1);
          }
          return el;
        };
        g.append(mk('vis'), mk('hit'));
        svgLayer.append(g);
        continue;
      }
      const el = document.createElement('div');
      el.className = `ed-obj ${o.type}`;
      el.dataset.id = o.id;
      Object.assign(el.style, objStyle(o));
      if (o.type === 'text' || o.type === 'textEdit') el.textContent = o.text;
      if (o.type === 'image') {
        const img = document.createElement('img');
        img.alt = '';
        img.src = S.assets[o.asset].url;
        el.append(img);
      }
      layer.append(el);
    }
    // tingkatkan ukuran kotak teks sesuai isi yang tampil
    layer.querySelectorAll('.ed-obj.text, .ed-obj.textEdit').forEach((el) => {
      const o = findObj(el.dataset.id);
      if (o && el.offsetWidth) { o.w = round(el.offsetWidth / scale); o.h = round(el.offsetHeight / scale); }
    });
    renderSelection();
  }

  function bbox(o) {
    if (o.type === 'line') return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    if (o.type === 'draw') {
      const xs = o.points.map((p) => p[0]);
      const ys = o.points.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    return o;
  }

  function renderSelection() {
    layer.querySelector('.ed-sel')?.remove();
    const o = S.sel && findObj(S.sel);
    if (!o) return;
    const b = bbox(o);
    const pad = 3;
    const sel = document.createElement('div');
    sel.className = 'ed-sel';
    Object.assign(sel.style, { left: `${b.x * scale - pad}px`, top: `${b.y * scale - pad}px`, width: `${b.w * scale + pad * 2}px`, height: `${b.h * scale + pad * 2}px` });
    if (o.type === 'line') {
      [['p1', o.x1, o.y1], ['p2', o.x2, o.y2]].forEach(([k, x, y]) => {
        const hd = document.createElement('div');
        hd.className = `h ${k}`;
        hd.dataset.handle = k;
        Object.assign(hd.style, { left: `${(x - b.x) * scale + pad - 6}px`, top: `${(y - b.y) * scale + pad - 6}px` });
        sel.append(hd);
      });
    } else if (!['text', 'textEdit', 'draw'].includes(o.type)) {
      ['nw', 'ne', 'sw', 'se'].forEach((k) => { const hd = document.createElement('div'); hd.className = `h ${k}`; hd.dataset.handle = k; sel.append(hd); });
    }
    layer.append(sel);
  }

  function select(id) {
    if (S.sel !== id) propSession = null;
    S.sel = id;
    renderSelection();
    renderProps();
  }

  // ── Interaksi pointer ─────────────────────────────────────
  function toLocal(e) {
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const t = (page().rotate * Math.PI) / 180;
    const lx = dx * Math.cos(t) + dy * Math.sin(t);
    const ly = -dx * Math.sin(t) + dy * Math.cos(t);
    const p = page();
    return { x: round(lx / scale + p.w / 2), y: round(ly / scale + p.h / 2) };
  }
  const clampPt = (pt) => ({ x: Math.max(0, Math.min(page().w, pt.x)), y: Math.max(0, Math.min(page().h, pt.y)) });

  function bindStage() {
    stage.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.ed-obj.text, .ed-obj.textEdit');
      if (el && S.tool === 'select') startEditing(el.dataset.id);
    });
    stage.addEventListener('pointerdown', onDown);
  }

  function onDown(e) {
    if (e.button !== 0 || !page()) return;
    if (e.target.closest('.ed-obj.editing')) return;
    e.preventDefault(); // cegah peramban memindahkan fokus (yang akan menutup kotak teks yang baru dibuat)
    if (S.editing) finishEditing();
    const p0 = toLocal(e);
    const t = S.tool;

    if (t === 'select') {
      const handle = e.target.closest('[data-handle]')?.dataset.handle;
      const hit = e.target.closest('[data-id]');
      if (!handle && !hit) { select(null); return; }
      if (hit) select(hit.dataset.id);
      const o = findObj(S.sel);
      if (!o) return;
      const start = clone(o);
      let moved = false;
      drag(e, (pt) => {
        const dx = pt.x - p0.x;
        const dy = pt.y - p0.y;
        if (!moved && Math.hypot(dx, dy) * scale < 2) return;
        if (!moved) { pushHistory(); moved = true; }
        if (handle) resize(o, start, handle, dx, dy, e.shiftKey);
        else translate(o, start, dx, dy);
        renderObjects();
      }, () => { if (moved) { renderThumbs(); renderProps(); } });
      return;
    }
    if (t === 'textEdit') return; // klik ditangani lapisan teks
    if (t === 'text') {
      pushHistory();
      const st = S.style;
      const o = { id: nid(), type: 'text', text: 'Teks baru', x: p0.x, y: round(p0.y - st.size * 0.6), w: 80, h: st.size * 1.2,
        size: st.size, color: st.color, font: st.font, bold: st.bold, italic: st.italic, align: st.align, opacity: st.opacity };
      page().objects.push(o);
      setTool('select');
      renderObjects();
      select(o.id);
      startEditing(o.id, true);
      renderThumbs();
      return;
    }
    if (t === 'image') { placeImage(p0); return; }
    if (t === 'draw') {
      pushHistory();
      const o = { id: nid(), type: 'draw', points: [[p0.x, p0.y]], stroke: S.style.stroke, strokeWidth: S.style.strokeWidth, opacity: S.style.opacity };
      page().objects.push(o);
      drag(e, (pt) => {
        const last = o.points[o.points.length - 1];
        const c = clampPt(pt);
        if (Math.hypot(c.x - last[0], c.y - last[1]) >= 0.8) { o.points.push([c.x, c.y]); renderObjects(); }
      }, () => { renderObjects(); renderThumbs(); });
      return;
    }
    // bentuk yang dibuat dengan menyeret
    pushHistory();
    const st = S.style;
    let o;
    if (t === 'line') o = { id: nid(), type: 'line', x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y, stroke: st.stroke, strokeWidth: st.strokeWidth, opacity: st.opacity };
    else if (t === 'highlight') o = { id: nid(), type: 'highlight', x: p0.x, y: p0.y, w: 0, h: 0, color: st.hl, opacity: 0.5 };
    else if (t === 'whiteout') o = { id: nid(), type: 'whiteout', x: p0.x, y: p0.y, w: 0, h: 0, fill: '#ffffff' };
    else o = { id: nid(), type: t, x: p0.x, y: p0.y, w: 0, h: 0, stroke: st.stroke || null, fill: st.fill || null, strokeWidth: st.strokeWidth, opacity: st.opacity };
    page().objects.push(o);
    drag(e, (pt) => {
      const c = clampPt(pt);
      if (o.type === 'line') { o.x2 = c.x; o.y2 = c.y; } else {
        o.x = Math.min(p0.x, c.x); o.y = Math.min(p0.y, c.y); o.w = round(Math.abs(c.x - p0.x)); o.h = round(Math.abs(c.y - p0.y));
      }
      renderObjects();
    }, () => {
      const small = o.type === 'line' ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3 : o.w < 3 && o.h < 3;
      if (small) {
        if (o.type === 'line') { o.x2 = o.x1 + 120; } else if (o.type === 'highlight') { o.w = 140; o.h = 16; } else { o.w = 120; o.h = 80; }
      }
      if (!['highlight', 'whiteout'].includes(t)) setTool('select');
      renderObjects();
      select(o.id);
      renderThumbs();
    });
  }

  function drag(e0, onMove, onUp) {
    const target = e0.currentTarget || stage;
    try { target.setPointerCapture(e0.pointerId); } catch { /* abaikan */ }
    e0.preventDefault();
    const move = (e) => onMove(toLocal(e), e);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      onUp?.();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  function translate(o, s, dx, dy) {
    if (o.type === 'line') { o.x1 = round(s.x1 + dx); o.y1 = round(s.y1 + dy); o.x2 = round(s.x2 + dx); o.y2 = round(s.y2 + dy); } else if (o.type === 'draw') {
      o.points = s.points.map(([x, y]) => [round(x + dx), round(y + dy)]);
    } else { o.x = round(s.x + dx); o.y = round(s.y + dy); }
  }

  function resize(o, s, hd, dx, dy, free) {
    if (o.type === 'line') {
      if (hd === 'p1') { o.x1 = round(s.x1 + dx); o.y1 = round(s.y1 + dy); } else { o.x2 = round(s.x2 + dx); o.y2 = round(s.y2 + dy); }
      return;
    }
    let { x, y, w, h: ht } = s;
    if (hd.includes('e')) w = s.w + dx;
    if (hd.includes('s')) ht = s.h + dy;
    if (hd.includes('w')) { x = s.x + dx; w = s.w - dx; }
    if (hd.includes('n')) { y = s.y + dy; ht = s.h - dy; }
    if (o.type === 'image' && !free) { // jaga proporsi gambar
      const ratio = s.w / s.h;
      if (Math.abs(w - s.w) / s.w > Math.abs(ht - s.h) / s.h) ht = w / ratio; else w = ht * ratio;
      if (hd.includes('n')) y = s.y + s.h - ht;
      if (hd.includes('w')) x = s.x + s.w - w;
    }
    o.x = round(Math.min(x, x + w)); o.y = round(Math.min(y, y + ht));
    o.w = round(Math.max(4, Math.abs(w))); o.h = round(Math.max(4, Math.abs(ht)));
  }

  async function placeImage(p0) {
    const [f] = await pickFile('image/png,image/jpeg,image/webp,image/gif');
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) { toast('Gambar maksimal 15 MB.'); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { toast('Gambar tidak dapat dibaca.'); return; }
    const idx = S.assets.push({ file: f, url, w: img.naturalWidth, h: img.naturalHeight }) - 1;
    const p = page();
    const w = Math.min(200, p.w * 0.4);
    const ht = (w * img.naturalHeight) / img.naturalWidth;
    pushHistory();
    const o = { id: nid(), type: 'image', asset: idx, x: round(Math.min(p0.x, p.w - w)), y: round(Math.min(p0.y, p.h - ht)), w: round(w), h: round(ht), opacity: 1 };
    p.objects.push(o);
    setTool('select');
    renderObjects();
    select(o.id);
    renderThumbs();
  }

  // ── Mengetik teks ─────────────────────────────────────────
  function startEditing(id, selectAll = false) {
    const el = layer.querySelector(`.ed-obj[data-id="${id}"]`);
    const o = findObj(id);
    if (!el || !o) return;
    S.editing = id;
    el.classList.add('editing');
    try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const before = snapshot();
    let pushed = false;
    el.addEventListener('input', () => {
      if (!pushed) { // simpan keadaan sebelum mengetik sebagai satu langkah urungkan
        S.undo.push(before);
        S.redo = [];
        S.dirty = true;
        pushed = true;
        updateUndoButtons();
      }
      o.text = el.innerText.replace(/\n$/, '');
      o.w = round(el.offsetWidth / scale);
      o.h = round(el.offsetHeight / scale);
      renderSelection();
    });
    el.addEventListener('paste', (e) => {
      if (el.contentEditable === 'plaintext-only') return;
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    el.addEventListener('blur', () => finishEditing(), { once: true });
    renderSelection();
  }

  function finishEditing() {
    const id = S.editing;
    if (!id) return;
    S.editing = null;
    const o = findObj(id);
    if (o && !o.text.trim() && o.type === 'text') {
      page().objects = page().objects.filter((x) => x.id !== id);
      if (S.sel === id) S.sel = null;
    }
    renderObjects();
    renderProps();
    renderThumbs();
  }

  // ── Panel properti ────────────────────────────────────────
  function renderProps() {
    const o = S.sel && findObj(S.sel);
    const t = o ? o.type : S.tool;
    const v = o || {
      ...S.style, stroke: S.style.stroke, color: t === 'highlight' ? S.style.hl : S.style.color,
      opacity: t === 'highlight' ? 0.5 : S.style.opacity,
    };
    const parts = [];
    const colorInput = (prop, label, value) => `<label>${label} <input type="color" data-prop="${prop}" value="${value || '#000000'}"></label>`;
    if (t === 'text' || t === 'textEdit') {
      parts.push(`<label>Huruf <select data-prop="font">${[['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']].map(([k, l]) => `<option value="${k}"${v.font === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`);
      parts.push(`<label>Ukuran <input type="number" min="4" max="400" step="1" data-prop="size" value="${round(v.size)}"></label>`);
      parts.push(colorInput('color', 'Warna', v.color));
      parts.push(`<button class="toggle" type="button" data-toggle="bold" aria-pressed="${!!v.bold}" title="Tebal">B</button>`);
      parts.push(`<button class="toggle" type="button" data-toggle="italic" aria-pressed="${!!v.italic}" title="Miring" style="font-style:italic">I</button>`);
      parts.push(`<label>Rata <select data-prop="align">${[['left', 'Kiri'], ['center', 'Tengah'], ['right', 'Kanan']].map(([k, l]) => `<option value="${k}"${(v.align || 'left') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`);
      if (t === 'textEdit') parts.push('<span class="hint">Warna & huruf asli dipakai kecuali Anda mengubahnya.</span>');
    } else if (t === 'rect' || t === 'ellipse') {
      parts.push(colorInput('stroke', 'Garis', v.stroke || '#000000'));
      parts.push(`<label><input type="checkbox" data-none="stroke"${v.stroke ? '' : ' checked'}> tanpa</label>`);
      parts.push(colorInput('fill', 'Isi', v.fill || '#ffffff'));
      parts.push(`<label><input type="checkbox" data-none="fill"${v.fill ? '' : ' checked'}> tanpa</label>`);
      parts.push(`<label>Tebal <input type="number" min="0" max="50" step="0.5" data-prop="strokeWidth" value="${v.strokeWidth}"></label>`);
    } else if (t === 'line' || t === 'draw') {
      parts.push(colorInput('stroke', 'Warna', v.stroke));
      parts.push(`<label>Tebal <input type="number" min="0.5" max="50" step="0.5" data-prop="strokeWidth" value="${v.strokeWidth}"></label>`);
    } else if (t === 'highlight') {
      parts.push(colorInput('color', 'Warna', v.color));
    }
    if (['text', 'image', 'rect', 'ellipse', 'line', 'draw', 'highlight'].includes(t)) {
      parts.push(`<label>Transparansi <input type="range" min="0.1" max="1" step="0.05" data-prop="opacity" value="${v.opacity ?? 1}"></label>`);
    }
    if (o) {
      parts.push('<span style="flex:1"></span>');
      parts.push(`<button class="btn btn-ghost" type="button" data-obj="front" style="padding:5px 10px;font-size:13px">Ke depan</button>`);
      parts.push(`<button class="btn btn-ghost" type="button" data-obj="back" style="padding:5px 10px;font-size:13px">Ke belakang</button>`);
      parts.push(`<button class="btn btn-ghost btn-danger" type="button" data-obj="del" style="padding:5px 10px;font-size:13px">${ICONS.trash} Hapus</button>`);
    } else {
      parts.push(`<span class="hint">${escapeHtml(HINT[S.tool] || '')}</span>`);
    }
    propsEl.innerHTML = parts.join('');
  }

  function applyProp(prop, value) {
    const o = S.sel && findObj(S.sel);
    if (!o) {
      if (prop === 'color' && S.tool === 'highlight') S.style.hl = value;
      else S.style[prop] = value;
      return;
    }
    if (propSession !== o.id) { pushHistory(); propSession = o.id; }
    o[prop] = value;
    if (o.type === 'textEdit') { o.overrides ||= {}; o.overrides[prop] = true; }
    renderObjects();
  }

  propsEl.addEventListener('input', (e) => {
    const prop = e.target.dataset.prop;
    if (!prop) return;
    let v = e.target.value;
    if (e.target.type === 'number' || e.target.type === 'range') {
      v = Number(v);
      if (!Number.isFinite(v)) return;
    }
    if (prop === 'stroke' || prop === 'fill') {
      const none = propsEl.querySelector(`[data-none=${prop}]`);
      if (none) none.checked = false;
    }
    applyProp(prop, v);
  });
  propsEl.addEventListener('change', (e) => {
    const none = e.target.dataset.none;
    if (none) applyProp(none, e.target.checked ? null : propsEl.querySelector(`[data-prop=${none}]`).value);
  });
  propsEl.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const on = tg.getAttribute('aria-pressed') !== 'true';
      tg.setAttribute('aria-pressed', String(on));
      applyProp(tg.dataset.toggle, on);
      return;
    }
    const act = e.target.closest('[data-obj]')?.dataset.obj;
    const o = S.sel && findObj(S.sel);
    if (!act || !o) return;
    pushHistory();
    const objs = page().objects;
    const i = objs.indexOf(o);
    objs.splice(i, 1);
    if (act === 'front') objs.push(o);
    if (act === 'back') objs.unshift(o);
    if (act === 'del') S.sel = null;
    renderObjects();
    renderProps();
    renderThumbs();
  });

  function setTool(t) {
    if (S.editing) finishEditing();
    const prev = S.tool;
    S.tool = t;
    ed.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    if (stage) stage.dataset.tool = t;
    if (t !== 'select') S.sel = null;
    renderSelection?.();
    renderProps();
    if (t === 'textEdit' && page()) {
      if (!page().src) { toast('Halaman kosong tidak punya teks asli untuk diedit.'); return; }
      S.sources[page().src.file].pdf.getPage(page().src.page + 1).then(buildTextLayer);
    } else if (prev === 'textEdit' && textLayer) textLayer.replaceChildren();
  }

  // ── Simpan ────────────────────────────────────────────────
  function serialize() {
    const assetMap = new Map();
    const sourceMap = new Map([[0, 0]]);
    const pages = S.pages.map((p) => {
      const out = { rotate: p.rotate, objects: [] };
      if (p.src) {
        if (!sourceMap.has(p.src.file)) sourceMap.set(p.src.file, sourceMap.size);
        out.src = { file: sourceMap.get(p.src.file), page: p.src.page };
      } else out.blank = { w: round(p.w), h: round(p.h) };
      out.objects = p.objects.map((o) => {
        const c = { ...o };
        delete c.id; delete c.itemKey; delete c.overrides;
        if (o.type === 'textEdit') {
          for (const k of ['size', 'color', 'font', 'bold', 'italic', 'align']) if (!o.overrides?.[k]) delete c[k];
        }
        if (o.type === 'text' && !String(o.text).trim()) return null;
        if (o.type === 'image') {
          if (!assetMap.has(o.asset)) assetMap.set(o.asset, assetMap.size);
          c.asset = assetMap.get(o.asset);
        }
        return c;
      }).filter(Boolean);
      return out;
    });
    return { pages, sources: [...sourceMap.keys()], assets: [...assetMap.keys()] };
  }

  async function save() {
    if (S.editing) finishEditing();
    const { pages, sources, assets } = serialize();
    const fd = new FormData();
    fd.append('options', JSON.stringify({ edit: { pages }, ...(S.password ? { password: S.password } : {}) }));
    fd.append('files', S.sources[0].file, S.sources[0].name);
    sources.slice(1).forEach((i) => fd.append('extra', S.sources[i].file, S.sources[i].name));
    assets.forEach((i) => fd.append('assets', S.assets[i].file, S.assets[i].file.name));

    const back = h('<div class="ed-modal-back"><div class="ed-modal panel" role="dialog" aria-modal="true" aria-label="Menyimpan PDF"></div></div>');
    const modal = back.querySelector('.ed-modal');
    const prog = progressView('Menyimpan perubahan');
    modal.append(prog.el);
    document.body.append(back);
    const close = () => back.remove();
    try {
      const { id } = await uploadJob('edit', fd, prog.upload);
      const job = await waitJob(id, prog.status);
      S.dirty = false;
      const res = resultView(tool, job, { onAgain: close });
      res.querySelector('[data-again]').textContent = 'Lanjut mengedit';
      res.style.border = '0';
      modal.replaceChildren(res);
    } catch (err) {
      modal.replaceChildren(h(`<div style="padding:8px"><div class="error-box" role="alert">${escapeHtml(err.message)}</div>
        <button class="btn" type="button">Kembali ke editor</button></div>`));
      modal.querySelector('button').addEventListener('click', close);
    }
  }

  // ── Toolbar & keyboard ────────────────────────────────────
  ed.querySelector('.ed-bar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    if (b.dataset.act === 'undo') restore(S.undo, S.redo);
    if (b.dataset.act === 'redo') restore(S.redo, S.undo);
    if (b.dataset.act === 'save') save();
  });

  function onKey(e) {
    if (!ed.isConnected) { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); window.onbeforeunload = null; return; }
    if (S.editing) { if (e.key === 'Escape') { e.preventDefault(); document.activeElement?.blur(); } return; }
    if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) restore(S.redo, S.undo); else restore(S.undo, S.redo); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); restore(S.redo, S.undo); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (mod) return;
    const o = S.sel && findObj(S.sel);
    if ((e.key === 'Delete' || e.key === 'Backspace') && o) {
      e.preventDefault();
      pushHistory();
      page().objects = page().objects.filter((x) => x !== o);
      S.sel = null;
      renderObjects(); renderProps(); renderThumbs();
      return;
    }
    if (e.key === 'Escape') { select(null); setTool('select'); return; }
    if (e.key === 'Enter' && o && (o.type === 'text' || o.type === 'textEdit')) { e.preventDefault(); startEditing(o.id); return; }
    if (o && e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (propSession !== `nudge-${o.id}`) { pushHistory(); propSession = `nudge-${o.id}`; }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      translate(o, clone(o), d[0], d[1]);
      renderObjects();
      return;
    }
    if (!o && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); goTo(S.cur + (e.key === 'PageDown' ? 1 : -1)); return; }
    if (SHORTCUT[e.key.toLowerCase()] && S.pages.length) setTool(SHORTCUT[e.key.toLowerCase()]);
  }
  document.addEventListener('keydown', onKey);

  let resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (ed.isConnected && S.pages.length) renderPage(); }, 150);
  }
  window.addEventListener('resize', onResize);
  window.onbeforeunload = (e) => { if (S.dirty) { e.preventDefault(); return ''; } return undefined; };

  function renderAll() {
    renderThumbs();
    renderPage();
    renderProps();
    updateUndoButtons();
  }

  if (initialFile) {
    openMain(initialFile);
  } else {
    showEmpty();
  }
}
