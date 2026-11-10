import {
  ICONS, badge, escapeHtml, formatBytes, h, openPdf, progressView, renderThumb, resultView, toast, uploadJob, waitJob, urlPath,
} from './ui.js';

const main = document.getElementById('main');
const state = { catalog: null, pendingFiles: null };

const ACTION_LABEL = {
  'jpg-to-pdf': 'Konversi ke PDF', 'word-to-pdf': 'Konversi ke PDF', 'powerpoint-to-pdf': 'Konversi ke PDF',
  'excel-to-pdf': 'Konversi ke PDF', 'html-to-pdf': 'Konversi ke PDF', 'pdf-to-jpg': 'Konversi ke JPG',
  'pdf-to-word': 'Konversi ke Word', 'pdf-to-powerpoint': 'Konversi ke PowerPoint', 'pdf-to-excel': 'Konversi ke Excel',
  'pdf-to-pdfa': 'Konversi ke PDF/A', merge: 'Gabungkan PDF', split: 'Pisahkan PDF', compress: 'Kompres PDF',
  watermark: 'Bubuhkan watermark', 'remove-watermark': 'Hapus watermark', 'pdf-to-flipbook': 'Buat flipbook', unlock: 'Buka kunci PDF',
};
const PROGRESS_TITLE = {
  merge: 'Menggabungkan PDF', split: 'Memisahkan PDF', compress: 'Mengompres PDF', watermark: 'Membubuhkan watermark',
  unlock: 'Membuka kunci PDF', 'remove-watermark': 'Menghapus watermark', 'pdf-to-flipbook': 'Membuat flipbook',
};

const extOf = (name) => (name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();

async function catalog() {
  if (!state.catalog) {
    const res = await fetch(urlPath('/api/tools'));
    if (!res.ok) throw new Error('Tidak dapat memuat daftar alat.');
    state.catalog = await res.json();
    document.querySelectorAll('[data-ttl]').forEach((e) => { e.textContent = state.catalog.limits.resultTtlMinutes; });
  }
  return state.catalog;
}

function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept.join(',');
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

function bindDrop(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); depth += 1; el.classList.add('over'); } });
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    el.classList.remove('over');
    onFiles([...e.dataTransfer.files]);
  });
}

// ── Beranda ──────────────────────────────────────────────────────────
async function renderHome() {
  const { categories, tools } = await catalog();
  document.title = 'OlahPDF — konversi, gabung, kompres & edit PDF';
  const cols = categories.map((c) => `
    <section class="dir-col" aria-labelledby="cat-${c.id}">
      <h2 id="cat-${c.id}">${escapeHtml(c.title)}</h2>
      <ul>${tools.filter((t) => t.category === c.id).map((t) => `
        <li><a class="tool-link" href="#/tool/${t.id}">${badge(t)}
          <span><strong>${escapeHtml(t.title)}</strong><span class="d">${escapeHtml(t.desc)}</span></span></a></li>`).join('')}
      </ul>
    </section>`).join('');

  main.replaceChildren(h(`<div class="wrap">
    <section class="hero">
      <div>
        <h1>Olah PDF langsung dari peramban.</h1>
        <p>Konversi, gabung, pisah, kompres, beri watermark, buka kunci, dan edit halaman PDF — tanpa memasang aplikasi.</p>
      </div>
      <div class="desk-drop" id="desk">
        <div class="dz-inner" id="desk-inner">
          <p class="dz-title">Letakkan file di sini</p>
          <p class="dz-sub">PDF, Word, Excel, PowerPoint, atau gambar — kami tunjukkan apa yang bisa dilakukan.</p>
          <button class="btn btn-primary" type="button" id="desk-pick">${ICONS.upload} Pilih file</button>
        </div>
      </div>
    </section>
    <div class="directory">${cols}</div>
  </div>`));

  const desk = document.getElementById('desk');
  const show = (files) => {
    if (!files.length) return;
    const exts = new Set(files.map((f) => extOf(f.name)));
    const fits = tools.filter((t) => [...exts].every((e) => t.accept.includes(e)) && (t.maxFiles >= files.length || t.maxFiles === 1));
    const inner = document.getElementById('desk-inner');
    const names = files.length === 1 ? files[0].name : `${files.length} file dipilih`;
    inner.replaceChildren(h(`<div class="suggest">
      <h2>${fits.length ? 'Mau diapakan?' : 'Tipe file ini belum didukung'}</h2>
      <p class="files-line">${escapeHtml(names)}</p>
      <div class="suggest-list">${fits.map((t) => `<button class="chip" type="button" data-tool="${t.id}">${badge(t)}${escapeHtml(t.title)}</button>`).join('')}</div>
      <button class="btn btn-ghost" type="button" data-reset>Pilih file lain</button>
    </div>`));
    inner.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
      const tool = tools.find((t) => t.id === b.dataset.tool);
      state.pendingFiles = files.slice(0, tool.maxFiles);
      location.hash = `#/tool/${tool.id}`;
    }));
    inner.querySelector('[data-reset]').addEventListener('click', () => renderHome());
  };
  bindDrop(desk, show);
  document.getElementById('desk-pick').addEventListener('click', async () => {
    const all = [...new Set(tools.flatMap((t) => t.accept))];
    show(await pickFiles(all, true));
  });
}

// ── Form opsi ────────────────────────────────────────────────────────
const POS_LABEL = { tl: 'Kiri atas', tc: 'Tengah atas', tr: 'Kanan atas', ml: 'Kiri tengah', mc: 'Tengah', mr: 'Kanan tengah',
  bl: 'Kiri bawah', bc: 'Tengah bawah', br: 'Kanan bawah' };

function fieldHtml(f) {
  const id = `opt-${f.name}`;
  const req = f.required ? ' required' : '';
  switch (f.type) {
    case 'select':
      return `<div class="field" data-field="${f.name}"><label for="${id}">${escapeHtml(f.label)}</label>
        <select class="select" id="${id}" name="${f.name}">${f.options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === f.default ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select></div>`;
    case 'checkbox':
      return `<div class="field" data-field="${f.name}"><label class="check"><input type="checkbox" name="${f.name}"${f.default ? ' checked' : ''}> ${escapeHtml(f.label)}</label></div>`;
    case 'number':
      return `<div class="field" data-field="${f.name}"><label for="${id}">${escapeHtml(f.label)}</label>
        <input class="input" type="number" id="${id}" name="${f.name}" min="${f.min}" max="${f.max}" step="${f.step}" value="${f.default}" inputmode="decimal"></div>`;
    case 'range':
      return `<div class="field" data-field="${f.name}"><label for="${id}">${escapeHtml(f.label)}</label>
        <div class="range-row"><input type="range" id="${id}" name="${f.name}" min="${f.min}" max="${f.max}" step="${f.step}" value="${f.default}">
        <output for="${id}">${Math.round(f.default * 100)}%</output></div></div>`;
    case 'color':
      return `<div class="field" data-field="${f.name}"><label for="${id}">${escapeHtml(f.label)}</label>
        <div class="color-row"><input type="color" id="${id}" name="${f.name}" value="${f.default}"><span>${f.default}</span></div></div>`;
    case 'position':
      return `<div class="field" data-field="${f.name}"><span class="label" id="${id}-l">${escapeHtml(f.label)}</span>
        <input type="hidden" name="${f.name}" value="${f.default}">
        <div class="pos-wrap"><div class="posgrid" role="group" aria-labelledby="${id}-l">${Object.entries(POS_LABEL).map(([k, l]) => `<button type="button" data-pos="${k}" aria-label="${l}" title="${l}" aria-pressed="${k === f.default}"></button>`).join('')}</div>
        <label class="check"><input type="checkbox" data-tile> Ulangi di seluruh halaman</label></div></div>`;
    case 'textarea':
      return `<div class="field" data-field="${f.name}"><label for="${id}">${escapeHtml(f.label)}</label>
        <textarea class="textarea" id="${id}" name="${f.name}" maxlength="${f.maxLength || 500}" placeholder="${escapeHtml(f.placeholder || '')}"${req}></textarea></div>`;
    default:
      return `<div class="field" data-field="${f.name}"><label for="${id}">${escapeHtml(f.label)}</label>
        <input class="input" type="${f.type === 'password' ? 'password' : 'text'}" id="${id}" name="${f.name}" maxlength="${f.maxLength || 500}"
        placeholder="${escapeHtml(f.placeholder || '')}" value="${f.type === 'password' ? '' : escapeHtml(f.default ?? '')}" autocomplete="${f.type === 'password' ? 'off' : 'on'}"${req}></div>`;
  }
}

function extraHtml(x) {
  return `<div class="field" data-field="${x.field}"><span class="label">${escapeHtml(x.label)}</span>
            <div class="extra-row"><button class="btn" type="button" data-extra="${x.field}">${ICONS.upload} ${escapeHtml(x.button || 'Pilih gambar')}</button>
            <button class="icon-btn danger" type="button" data-extra-clear="${x.field}" aria-label="Hapus ${escapeHtml(x.label)}" hidden>${ICONS.x}</button></div>
            ${x.kind === 'audio' ? '<audio class="extra-audio" controls preload="metadata" hidden></audio>' : ''}
            ${x.maxMb ? `<span class="hint-sm">Maks. ${x.maxMb} MB</span>` : ''}</div>`;
}

function readOptions(form, tool) {
  const o = {};
  for (const f of tool.fields) {
    const input = form.elements[f.name];
    if (!input) continue;
    if (f.type === 'checkbox') o[f.name] = input.checked;
    else if (f.type === 'number' || f.type === 'range') o[f.name] = Number(input.value);
    else o[f.name] = input.value;
  }
  return o;
}

function applyShowIf(form, tool) {
  const vals = readOptions(form, tool);
  for (const f of [...tool.fields, ...(tool.extraUploads || [])]) {
    if (!f.showIf) continue;
    const ok = Object.entries(f.showIf).every(([k, allowed]) => allowed.includes(String(vals[k])));
    const node = form.querySelector(`[data-field="${f.name || f.field}"]`);
    if (node) node.hidden = !ok;
  }
  return vals;
}

// ── Halaman tool ─────────────────────────────────────────────────────
async function renderTool(id) {
  const { tools, limits } = await catalog();
  const tool = tools.find((t) => t.id === id);
  if (!tool) { location.hash = '#/'; return; }
  document.title = `${tool.title} — OlahPDF`;

  if (tool.custom === 'editor') {
    const { mountEditor } = await import('./editor.js');
    document.body.classList.add('editing');
    const files = state.pendingFiles;
    state.pendingFiles = null;
    mountEditor(main, tool, files?.[0]);
    return;
  }

  let files = state.pendingFiles?.filter((f) => tool.accept.includes(extOf(f.name))) || [];
  state.pendingFiles = null;
  const extras = {};
  const multiple = tool.maxFiles > 1;

  const page = h(`<div class="wrap">
    <a class="back" href="#/">${ICONS.back} Semua alat</a>
    <header class="tool-head">${badge(tool, 'big')}<div><h1>${escapeHtml(tool.title)}</h1><p>${escapeHtml(tool.desc)}</p></div></header>
    <div class="tool-grid">
      <section class="files-area" aria-label="File"></section>
      <form class="panel options" novalidate>
        <h2>Pengaturan</h2>
        <div class="error-box" role="alert" hidden></div>
        ${tool.fields.map((f) => fieldHtml(f) + (tool.extraUploads || []).filter((x) => x.after === f.name).map(extraHtml).join('')).join('')}
        ${(tool.extraUploads || []).filter((x) => !x.after).map(extraHtml).join('')}
        ${tool.note ? `<p class="note">${escapeHtml(tool.note)}</p>` : ''}
        <button class="btn btn-primary btn-big" type="submit">${escapeHtml(ACTION_LABEL[tool.id] || 'Proses')}</button>
      </form>
    </div></div>`);
  main.replaceChildren(page);
  const form = page.querySelector('form');
  const area = page.querySelector('.files-area');
  const errBox = form.querySelector('.error-box');
  const showErr = (msg) => { errBox.textContent = msg; errBox.hidden = !msg; if (msg) errBox.scrollIntoView({ block: 'nearest' }); };
  const needsFiles = () => !(tool.id === 'html-to-pdf' && form.elements.source?.value === 'url');

  // perilaku kontrol khusus
  form.addEventListener('input', (e) => {
    if (e.target.type === 'range') e.target.nextElementSibling.textContent = `${Math.round(e.target.value * 100)}%`;
    if (e.target.type === 'color') e.target.nextElementSibling.textContent = e.target.value;
    applyShowIf(form, tool);
    if (e.target.name === 'source') renderFiles();
  });
  form.addEventListener('change', (e) => { applyShowIf(form, tool); if (e.target.name === 'source') renderFiles(); });
  form.querySelectorAll('.posgrid button').forEach((b) => b.addEventListener('click', () => {
    form.querySelectorAll('.posgrid button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    form.querySelector('[data-tile]').checked = false;
    form.elements.position.value = b.dataset.pos;
  }));
  form.querySelector('[data-tile]')?.addEventListener('change', (e) => {
    const sel = form.querySelector('.posgrid [aria-pressed=true]');
    form.elements.position.value = e.target.checked ? 'tile' : (sel?.dataset.pos || 'mc');
    form.querySelector('.posgrid').style.opacity = e.target.checked ? '.35' : '1';
  });
  // Opsi yang hanya relevan bila file tambahan (mis. MP3) sudah dipilih
  const syncUploadDeps = () => {
    for (const f of tool.fields) {
      if (!f.showIfUpload) continue;
      const node = form.querySelector(`[data-field="${f.name}"]`);
      if (node) node.hidden = !extras[f.showIfUpload];
    }
  };
  form.querySelectorAll('[data-extra]').forEach((b) => b.addEventListener('click', async () => {
    const def = tool.extraUploads.find((x) => x.field === b.dataset.extra);
    const [f] = await pickFiles(def.accept, false);
    if (!f) return;
    if (!def.accept.includes(extOf(f.name))) { toast(`Gunakan file ${def.accept.join(', ')}`); return; }
    if (def.maxMb && f.size > def.maxMb * 1024 * 1024) { toast(`Ukuran maksimal ${def.maxMb} MB.`); return; }
    extras[def.field] = f;
    b.innerHTML = `${def.kind === 'audio' ? ICONS.music : ICONS.image} ${escapeHtml(f.name)} · ${formatBytes(f.size)}`;
    const wrap = b.closest('.field');
    wrap.querySelector('[data-extra-clear]').hidden = false;
    const au = wrap.querySelector('.extra-audio');
    if (au) { if (au.src) URL.revokeObjectURL(au.src); au.src = URL.createObjectURL(f); au.hidden = false; }
    syncUploadDeps();
  }));
  form.querySelectorAll('[data-extra-clear]').forEach((c) => c.addEventListener('click', () => {
    const def = tool.extraUploads.find((x) => x.field === c.dataset.extraClear);
    delete extras[def.field];
    const wrap = c.closest('.field');
    wrap.querySelector('[data-extra]').innerHTML = `${ICONS.upload} ${escapeHtml(def.button || 'Pilih gambar')}`;
    c.hidden = true;
    const au = wrap.querySelector('.extra-audio');
    if (au) { au.pause(); if (au.src) URL.revokeObjectURL(au.src); au.removeAttribute('src'); au.hidden = true; }
    syncUploadDeps();
  }));
  applyShowIf(form, tool);
  syncUploadDeps();

  const thumbCache = new WeakMap();
  async function thumbFor(file, holder) {
    try {
      let url = thumbCache.get(file);
      if (!url) {
        if (file.type.startsWith('image/')) url = URL.createObjectURL(file);
        else if (extOf(file.name) === '.pdf') {
          const pdf = await openPdf(file);
          const t = await renderThumb(pdf, 0, 260);
          holder.dataset.pages = pdf.numPages;
          pdf.loadingTask?.destroy?.();
          url = t.url;
        }
        if (url) thumbCache.set(file, url);
      }
      if (url) holder.querySelector('.thumb').replaceChildren(h(`<img alt="" src="${url}">`));
    } catch (err) {
      console.warn('Pratinjau gagal:', file.name, err);
      holder.querySelector('.thumb').textContent = extOf(file.name).slice(1).toUpperCase();
    }
  }

  function addFiles(list) {
    const ok = list.filter((f) => tool.accept.includes(extOf(f.name)));
    if (ok.length < list.length) toast(`Sebagian file dilewati — ${tool.title} menerima ${tool.accept.join(', ')}`);
    const big = ok.filter((f) => f.size > limits.maxFileMb * 1024 * 1024);
    if (big.length) toast(`${big[0].name} melebihi ${limits.maxFileMb} MB.`);
    files = [...files, ...ok.filter((f) => !big.includes(f))].slice(0, tool.maxFiles);
    renderFiles();
  }

  let dragIndex = null;
  function renderFiles() {
    if (!needsFiles() && !files.length) {
      area.replaceChildren(h(`<div class="dropzone"><p class="dz-title">Isi URL di panel pengaturan</p>
        <p class="dz-sub">Halaman web publik akan dibuka di server lalu disimpan sebagai PDF.</p></div>`));
      return;
    }
    if (!files.length) {
      const dz = h(`<div class="dropzone"><p class="dz-title">Letakkan ${multiple ? 'file-file' : 'file'} di sini</p>
        <p class="dz-sub">${escapeHtml(tool.accept.join(', '))} · maks. ${limits.maxFileMb} MB per file</p>
        <button class="btn btn-primary" type="button">${ICONS.upload} Pilih file</button></div>`);
      dz.querySelector('button').addEventListener('click', async () => addFiles(await pickFiles(tool.accept, multiple)));
      bindDrop(dz, addFiles);
      area.replaceChildren(dz);
      return;
    }
    const wrap = h(`<div>
      <div class="files-bar"><p>${files.length} file · ${formatBytes(files.reduce((s, f) => s + f.size, 0))}${tool.sortable && files.length > 1 ? ' · seret untuk mengubah urutan' : ''}</p>
      <button class="btn btn-ghost" type="button" data-clear>${ICONS.trash} Kosongkan</button></div>
      <div class="sheets"></div></div>`);
    const grid = wrap.querySelector('.sheets');
    files.forEach((f, i) => {
      const s = h(`<div class="sheet" draggable="${!!tool.sortable}" data-i="${i}">
        ${tool.sortable && files.length > 1 ? `<span class="order">${i + 1}</span>` : ''}
        <div class="thumb">…</div>
        <div><div class="fname" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div><div class="fmeta">${formatBytes(f.size)}</div></div>
        <div class="acts">
          ${tool.sortable && files.length > 1 ? `<button class="icon-btn" type="button" data-mv="-1" aria-label="Geser ke kiri"${i === 0 ? ' disabled' : ''}>${ICONS.left}</button>
          <button class="icon-btn" type="button" data-mv="1" aria-label="Geser ke kanan"${i === files.length - 1 ? ' disabled' : ''}>${ICONS.right}</button>` : ''}
          <button class="icon-btn danger" type="button" data-rm aria-label="Hapus ${escapeHtml(f.name)}">${ICONS.x}</button>
        </div></div>`);
      s.querySelector('[data-rm]').addEventListener('click', () => { files.splice(i, 1); renderFiles(); });
      s.querySelectorAll('[data-mv]').forEach((b) => b.addEventListener('click', () => {
        const j = i + Number(b.dataset.mv);
        [files[i], files[j]] = [files[j], files[i]];
        renderFiles();
      }));
      if (tool.sortable) {
        s.addEventListener('dragstart', (e) => { dragIndex = i; s.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        s.addEventListener('dragend', () => { dragIndex = null; s.classList.remove('dragging'); });
        s.addEventListener('dragover', (e) => { if (dragIndex !== null) { e.preventDefault(); s.classList.add('drop-before'); } });
        s.addEventListener('dragleave', () => s.classList.remove('drop-before'));
        s.addEventListener('drop', (e) => {
          if (dragIndex === null) return;
          e.preventDefault();
          e.stopPropagation();
          const [moved] = files.splice(dragIndex, 1);
          files.splice(i > dragIndex ? i - 1 : i, 0, moved);
          renderFiles();
        });
      }
      grid.append(s);
      thumbFor(f, s);
    });
    if (files.length < tool.maxFiles) {
      const add = h(`<button class="add-more" type="button">${ICONS.plus}<span>Tambah file</span></button>`);
      add.addEventListener('click', async () => addFiles(await pickFiles(tool.accept, multiple)));
      grid.append(add);
    }
    wrap.querySelector('[data-clear]').addEventListener('click', () => { files = []; renderFiles(); });
    bindDrop(wrap, addFiles);
    area.replaceChildren(wrap);
  }
  renderFiles();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr('');
    const options = applyShowIf(form, tool);
    const min = needsFiles() ? Math.max(1, tool.minFiles) : 0;
    if (files.length < min) return showErr(min > 1 ? `Pilih minimal ${min} file.` : 'Pilih file terlebih dahulu.');
    for (const f of tool.fields) {
      const node = form.querySelector(`[data-field="${f.name}"]`);
      if (f.required && !node?.hidden && !String(options[f.name] ?? '').trim()) return showErr(`Kolom "${f.label}" wajib diisi.`);
    }
    for (const x of tool.extraUploads || []) {
      const node = form.querySelector(`[data-field="${x.field}"]`);
      if (x.required && !node?.hidden && !extras[x.field]) return showErr(`${x.label} wajib diunggah.`);
    }
    const fd = new FormData();
    fd.append('options', JSON.stringify(options));
    if (needsFiles()) files.forEach((f) => fd.append('files', f, f.name));
    Object.entries(extras).forEach(([k, f]) => fd.append(k, f, f.name));

    const prog = progressView(PROGRESS_TITLE[tool.id] || 'Mengonversi file');
    const gridEl = page.querySelector('.tool-grid');
    gridEl.hidden = true;
    const box = h('<section class="panel"></section>');
    box.append(prog.el);
    gridEl.after(box);
    try {
      const { id: jobId } = await uploadJob(tool.id, fd, prog.upload);
      const job = await waitJob(jobId, prog.status);
      box.replaceWith(resultView(tool, job, { onAgain: () => renderTool(tool.id) }));
      page.querySelector('.result h2')?.focus?.();
    } catch (err) {
      box.remove();
      gridEl.hidden = false;
      showErr(err.message);
    }
    return undefined;
  });
}

// ── Router ───────────────────────────────────────────────────────────
async function route() {
  document.body.classList.remove('editing');
  const m = location.hash.match(/^#\/tool\/([\w-]+)/);
  try {
    if (m) await renderTool(m[1]);
    else await renderHome();
  } catch (err) {
    main.replaceChildren(h(`<div class="wrap"><div class="error-box" style="margin-top:32px">${escapeHtml(err.message)}</div></div>`));
  }
  window.scrollTo(0, 0);
}
async function initAuth() {
  try {
    const res = await fetch(urlPath('/api/auth/me'));
    if (!res.ok) return;
    const data = await res.json();
    if (data.authenticated && data.user) {
      const menu = document.getElementById('user-menu');
      const nameEl = document.getElementById('user-name');
      const portalBtn = document.getElementById('btn-portal');
      const logoutBtn = document.getElementById('btn-logout');
      const chip = document.getElementById('user-chip');

      if (menu && nameEl) {
        nameEl.textContent = data.user.name || data.user.email || 'Pengguna';
        if (chip && data.user.role) {
          const detail = [data.user.role, data.user.unit].filter(Boolean).join(' • ');
          chip.title = `${data.user.name}${detail ? ' (' + detail + ')' : ''}`;
        }
        if (portalBtn && data.eportalUrl) {
          portalBtn.href = data.eportalUrl;
        }
        if (logoutBtn) {
          logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.href = urlPath('/logout');
          });
        }
        menu.hidden = false;
      }
    }
  } catch (err) {
    console.debug('Auth check:', err);
  }
}

window.addEventListener('hashchange', route);
initAuth();
route();
