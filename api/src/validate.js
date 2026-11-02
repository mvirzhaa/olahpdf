import fs from 'node:fs/promises';
import path from 'node:path';

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const visible = (field, values) => !field.showIf
  || Object.entries(field.showIf).every(([k, allowed]) => allowed.includes(String(values[k])));

const POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br', 'tile'];

/** Bersihkan opsi dari klien berdasarkan definisi field tool (whitelist). */
export function sanitizeOptions(tool, raw = {}) {
  const out = {};
  for (const f of tool.fields) {
    let v = raw[f.name];
    if (!visible(f, out)) continue;
    if (v === undefined || v === null || v === '') v = f.default;
    switch (f.type) {
      case 'select':
        if (!f.options.some((o) => o.value === String(v))) v = f.default;
        v = String(v);
        break;
      case 'checkbox':
        v = v === true || v === 'true' || v === 'on' || v === '1' || v === 1;
        break;
      case 'number':
      case 'range': {
        const n = Number(v);
        v = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.default;
        break;
      }
      case 'color':
        v = /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : f.default;
        break;
      case 'position':
        v = POSITIONS.includes(String(v)) ? String(v) : f.default;
        break;
      default: // text, textarea, password
        v = v === undefined ? '' : String(v).slice(0, f.maxLength || 500);
        if (f.type !== 'password') v = v.trim();
    }
    if (f.required && (v === '' || v === undefined)) {
      throw new ValidationError(`Kolom "${f.label}" wajib diisi.`);
    }
    if (v !== undefined) out[f.name] = v;
  }
  if (tool.id === 'html-to-pdf' && out.source === 'url' && !/^(https?:\/\/)?[^\s/$.?#][^\s]*\.[^\s]+$/i.test(out.url || '')) {
    throw new ValidationError('URL tidak valid. Contoh: https://uika-bogor.ac.id');
  }
  return out;
}

export function extraUploadVisible(extra, options) {
  return visible(extra, options);
}

// ── Validasi spesifikasi editor ─────────────────────────────────────────
const num = (v, lo = -1e5, hi = 1e5) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError('Data editor berisi angka tidak valid.');
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
};
const color = (v) => (v == null || v === '' ? null : /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : null);
const OBJ_TYPES = new Set(['text', 'textEdit', 'image', 'rect', 'ellipse', 'line', 'draw', 'highlight', 'whiteout']);

function cleanObject(o, assetCount) {
  if (!o || typeof o !== 'object' || !OBJ_TYPES.has(o.type)) throw new ValidationError('Jenis objek editor tidak dikenal.');
  const c = { type: o.type };
  if (o.type === 'line') {
    Object.assign(c, { x1: num(o.x1), y1: num(o.y1), x2: num(o.x2), y2: num(o.y2) });
  } else if (o.type === 'draw') {
    if (!Array.isArray(o.points) || o.points.length > 20000) throw new ValidationError('Coretan terlalu panjang.');
    c.points = o.points.map((p) => [num(p?.[0]), num(p?.[1])]);
  } else {
    Object.assign(c, { x: num(o.x), y: num(o.y), w: num(o.w, 0, 1e5), h: num(o.h, 0, 1e5) });
  }
  if (o.type === 'text' || o.type === 'textEdit') {
    c.text = String(o.text ?? '').slice(0, 5000);
    for (const k of ['bold', 'italic', 'underline']) if (o[k] != null) c[k] = !!o[k];
    if (o.size != null) c.size = num(o.size, 4, 400);
    if (o.color != null) c.color = color(o.color) ?? '#000000';
    if (['sans', 'serif', 'mono'].includes(o.font)) c.font = o.font;
    if (['left', 'center', 'right'].includes(o.align)) c.align = o.align;
  }
  if (o.type === 'textEdit') {
    if (!Array.isArray(o.orig) || o.orig.length !== 4) throw new ValidationError('Area teks asli tidak valid.');
    c.orig = o.orig.map((v) => num(v));
  }
  if (o.type === 'image') {
    const idx = Number(o.asset);
    if (!Number.isInteger(idx) || idx < 0 || idx >= assetCount) throw new ValidationError('Gambar pada editor tidak ditemukan.');
    c.asset = idx;
  }
  if (['rect', 'ellipse', 'line', 'draw'].includes(o.type)) {
    c.stroke = color(o.stroke);
    c.fill = color(o.fill);
    c.strokeWidth = num(o.strokeWidth ?? 2, 0, 50);
  }
  if (['highlight', 'whiteout'].includes(o.type)) {
    if (o.type === 'highlight') c.color = color(o.color) ?? '#ffeb3b';
    if (o.type === 'whiteout') c.fill = color(o.fill) ?? '#ffffff';
  }
  if (o.opacity != null) c.opacity = num(o.opacity, 0.05, 1);
  return c;
}

export function validateEditSpec(spec, { sourceFiles, assetCount }) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.pages)) throw new ValidationError('Data editor tidak valid.');
  if (spec.pages.length < 1) throw new ValidationError('Dokumen minimal berisi 1 halaman.');
  if (spec.pages.length > 3000) throw new ValidationError('Maksimal 3000 halaman.');
  let objectCount = 0;
  const pages = spec.pages.map((p) => {
    const page = { rotate: [0, 90, 180, 270].includes(Number(p?.rotate)) ? Number(p.rotate) : 0, objects: [] };
    if (p?.src) {
      const file = Number(p.src.file);
      const no = Number(p.src.page);
      if (!Number.isInteger(file) || file < 0 || file >= sourceFiles || !Number.isInteger(no) || no < 0) {
        throw new ValidationError('Sumber halaman tidak valid.');
      }
      page.src = { file, page: no };
    } else {
      page.blank = { w: num(p?.blank?.w ?? 595.28, 72, 14400), h: num(p?.blank?.h ?? 841.89, 72, 14400) };
    }
    const objs = Array.isArray(p?.objects) ? p.objects : [];
    objectCount += objs.length;
    if (objectCount > 20000) throw new ValidationError('Terlalu banyak objek pada dokumen.');
    page.objects = objs.map((o) => cleanObject(o, assetCount));
    return page;
  });
  return { pages };
}

// ── Pemeriksaan tanda tangan file (magic bytes) ─────────────────────────
const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

export async function checkFileSignature(filePath, kind) {
  const fh = await fs.open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(1024), 0, 1024, 0);
    const buf = buffer.subarray(0, bytesRead);
    const ext = path.extname(filePath).toLowerCase();
    switch (kind) {
      case 'pdf':
        return buf.includes(Buffer.from('%PDF-'));
      case 'image':
        return startsWith(buf, [0xff, 0xd8, 0xff]) // JPEG
          || startsWith(buf, [0x89, 0x50, 0x4e, 0x47]) // PNG
          || (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) // WEBP
          || startsWith(buf, [0x42, 0x4d]) // BMP
          || startsWith(buf, [0x47, 0x49, 0x46, 0x38]) // GIF
          || startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a]); // TIFF
      case 'office':
        if (ext === '.csv') return !buf.includes(0);
        if (ext === '.rtf') return buf.toString('latin1', 0, 5) === '{\\rtf';
        return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) // OOXML / ODF (zip)
          || startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // DOC/XLS/PPT lama
      case 'html':
        return !buf.subarray(0, 512).includes(0);
      case 'audio': { // MP3: tag ID3 atau sinkronisasi frame MPEG audio
        if (buf.toString('latin1', 0, 3) === 'ID3') return true;
        for (let i = 0; i < buf.length - 1; i += 1) {
          if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0 && (buf[i + 1] & 0x06) !== 0) return true;
        }
        return false;
      }
      default:
        return false;
    }
  } finally {
    await fh.close();
  }
}
