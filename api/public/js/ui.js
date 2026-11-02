// Utilitas antarmuka bersama: ikon, elemen DOM, unggah & pantau job, tampilan hasil.

const svg = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  up: svg('<path d="M18 15l-6-6-6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  left: svg('<path d="M15 18l-6-6 6-6"/>'),
  right: svg('<path d="M9 18l6-6-6-6"/>'),
  x: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/>'),
  download: svg('<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  rotl: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  rotr: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  zin: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>'),
  zout: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>'),
  select: svg('<path d="M5 3l14 8-6 2-2 6z"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  textEdit: svg('<path d="M4 7V5h9v2M8.5 5v12M6 17h5"/><path d="M14 19l1-4 5-5 3 3-5 5z"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>'),
  rect: svg('<rect x="4" y="5" width="16" height="14" rx="1"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
  line: svg('<path d="M5 19L19 5"/>'),
  draw: svg('<path d="M3 17c3-4 5 2 8-2s4-8 7-6 1 6-2 9"/><path d="M3 21h4"/>'),
  highlight: svg('<path d="M9 11l-5 5v3h3l5-5"/><path d="M14 4l6 6-7 7-6-6z"/>'),
  whiteout: svg('<rect x="3" y="6" width="18" height="12" rx="1" stroke-dasharray="3 2"/><path d="M8 12h8"/>'),
  blank: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M12 10v6M9 13h6"/>'),
  insertPdf: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M9 14h6M12 11l3 3-3 3"/>'),
  save: svg('<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>'),
  // ikon tool tanpa label teks
  merge: svg('<path d="M8 4v6a4 4 0 0 0 4 4 4 4 0 0 1 4 4v2M16 4v6a4 4 0 0 1-4 4"/>'),
  split: svg('<path d="M12 4v6M12 10l-6 6v4M12 10l6 6v4"/>'),
  compress: svg('<path d="M12 3v6M9 6l3 3 3-3M12 21v-6M9 18l3-3 3 3M4 12h16"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>'),
  watermark: svg('<path d="M12 3c3.5 4.5 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 2.5-6.5 6-11z"/>'),
  unwatermark: svg('<path d="M12 3c3.5 4.5 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 2.5-6.5 6-11z"/><path d="M4 4l16 16"/>'),
};

const BADGE_ICON = { merge: 'merge', split: 'split', compress: 'compress', edit: 'edit', unlock: 'key', watermark: 'watermark', 'remove-watermark': 'unwatermark' };

export function badge(tool, size = '') {
  const icon = BADGE_ICON[tool.id];
  const inner = icon ? ICONS[icon] : escapeHtml(tool.badge);
  return `<span class="badge hue-${tool.hue} ${size}" aria-hidden="true">${inner}</span>`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`.replace('.', ',');
}

let toastTimer;
export function toast(msg, ms = 3500) {
  const el = document.querySelector('.toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** Unggah FormData dengan progres. Mengembalikan {id}. */
export function uploadJob(toolId, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/jobs/${encodeURIComponent(toolId)}`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `Unggahan gagal (kode ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Koneksi ke server terputus. Periksa jaringan Anda.'));
    xhr.send(formData);
  });
}

/** Tunggu job selesai. onUpdate dipanggil dengan status terbaru. */
export async function waitJob(id, onUpdate, signal) {
  let delay = 600;
  for (;;) {
    if (signal?.aborted) throw new Error('Dibatalkan.');
    const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
    const job = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(job.error || 'Gagal memeriksa status.');
    onUpdate?.(job);
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new Error(job.error || 'Pemrosesan gagal.');
    if (job.status === 'expired') throw new Error('File sudah dihapus.');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.25, 2500);
  }
}

export function progressView(title) {
  const el = h(`<div class="progress-box" role="status" aria-live="polite">
    <h2>${escapeHtml(title)}</h2><p data-msg>Mengunggah file…</p>
    <div class="bar"><span></span></div></div>`);
  return {
    el,
    upload(frac) {
      el.querySelector('.bar span').style.width = `${Math.round(frac * 100)}%`;
      el.querySelector('[data-msg]').textContent = `Mengunggah file… ${Math.round(frac * 100)}%`;
    },
    status(job) {
      el.querySelector('.bar').classList.add('indet');
      el.querySelector('[data-msg]').textContent = job.status === 'queued'
        ? (job.queuePosition ? `Menunggu giliran — ${job.queuePosition} file di depan Anda.` : 'Menunggu giliran…')
        : 'Sedang diproses di server…';
    },
  };
}

const RESULT_TITLE = {
  merge: 'PDF sudah digabung', split: 'PDF sudah dipisah', compress: 'PDF sudah dikompres',
  watermark: 'Watermark sudah dibubuhkan', 'remove-watermark': 'Watermark sudah dihapus', unlock: 'PDF sudah tidak terkunci', edit: 'Perubahan sudah disimpan',
};

export function resultView(tool, job, { onAgain, onDeleted } = {}) {
  const info = job.result || {};
  const saved = tool.id === 'compress' && info.size_before
    ? `<p class="saved">${info.saved_percent > 0
      ? `Lebih kecil ${String(info.saved_percent).replace('.', ',')}% — dari ${formatBytes(info.size_before)} menjadi ${formatBytes(info.size_after)}`
      : 'File ini sudah optimal; ukurannya tidak bisa diperkecil lagi.'}</p>` : '';
  const removed = tool.id === 'remove-watermark'
    ? `<p class="saved">${(info.removed_objects || 0) + (info.removed_text || 0)} elemen watermark dihapus.</p>` : '';
  const isPdf = job.output.name.toLowerCase().endsWith('.pdf');
  const el = h(`<section class="panel result">
    <div class="stamp animate" aria-hidden="true">SELESAI<small>OlahPDF</small></div>
    <h2>${escapeHtml(RESULT_TITLE[tool.id] || 'File Anda sudah siap')}</h2>
    <p class="meta">${escapeHtml(job.output.name)} · ${formatBytes(job.output.size)}</p>
    ${saved}${removed}
    <div class="result-actions">
      <a class="btn btn-primary btn-big" href="${job.output.url}" download>${ICONS.download} Unduh ${escapeHtml(job.output.name.split('.').pop().toUpperCase())}</a>
      <div class="row">
        ${isPdf ? `<a class="btn" href="${job.output.url}?inline=1" target="_blank" rel="noopener">Lihat</a>` : ''}
        <button class="btn" type="button" data-again>Proses file lain</button>
      </div>
      <button class="btn btn-ghost btn-danger" type="button" data-del>${ICONS.trash} Hapus file dari server sekarang</button>
    </div></section>`);
  el.querySelector('[data-again]').addEventListener('click', () => onAgain?.());
  el.querySelector('[data-del]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const r = await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
    if (r.ok) {
      toast('File sudah dihapus dari server.');
      el.querySelectorAll('a.btn').forEach((a) => { a.removeAttribute('href'); a.classList.add('btn-disabled'); a.setAttribute('aria-disabled', 'true'); });
      onDeleted?.();
    } else {
      e.currentTarget.disabled = false;
      toast('Gagal menghapus file. Coba lagi.');
    }
  });
  return el;
}

// pdf.js dimuat hanya saat dibutuhkan (thumbnail & editor)
let pdfjsPromise;
export function loadPdfjs() {
  pdfjsPromise ||= import('/vendor/pdfjs/build/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
    return lib;
  });
  return pdfjsPromise;
}

export async function openPdf(file, password) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({
    data,
    password,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
    iccUrl: '/vendor/pdfjs/iccs/',
  });
  return task.promise;
}

/** Render halaman PDF ke data URL kecil untuk thumbnail. */
export async function renderThumb(pdf, pageIndex, maxPx = 220) {
  const page = await pdf.getPage(pageIndex + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = maxPx / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return { url: canvas.toDataURL('image/jpeg', 0.8), w: vp1.width, h: vp1.height };
}
