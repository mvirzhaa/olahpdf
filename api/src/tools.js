/**
 * Definisi semua tool. Dipakai API untuk validasi DAN dikirim ke frontend
 * (GET /api/tools) untuk membangun form opsi secara otomatis.
 */
import { config } from './config.js';

const PDF = ['.pdf'];
const IMAGES = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.gif'];

const pageSize = (def = 'a4', withFit = false) => ({
  name: 'pageSize', label: 'Ukuran halaman', type: 'select', default: def,
  options: [
    ...(withFit ? [{ value: 'fit', label: 'Sesuai gambar' }] : []),
    { value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }, { value: 'legal', label: 'Legal / F4' },
  ],
});
const margin = (def = 'none') => ({
  name: 'margin', label: 'Margin', type: 'select', default: def,
  options: [{ value: 'none', label: 'Tanpa margin' }, { value: 'small', label: 'Kecil' }, { value: 'big', label: 'Besar' }],
});

export const CATEGORIES = [
  { id: 'to-pdf', title: 'Konversi ke PDF' },
  { id: 'from-pdf', title: 'Konversi dari PDF' },
  { id: 'organize', title: 'Atur PDF' },
  { id: 'secure', title: 'Edit & keamanan' },
];

export const TOOLS = [
  // ── Ke PDF ──────────────────────────────────────────────
  {
    id: 'jpg-to-pdf', category: 'to-pdf', title: 'JPG ke PDF', badge: 'JPG', hue: 'amber',
    desc: 'Satukan foto atau hasil scan menjadi satu PDF.', accept: IMAGES, kind: 'image',
    minFiles: 1, maxFiles: 50, sortable: true,
    fields: [
      pageSize('a4', true),
      { name: 'orientation', label: 'Orientasi', type: 'select', default: 'auto',
        options: [{ value: 'auto', label: 'Otomatis' }, { value: 'portrait', label: 'Potret' }, { value: 'landscape', label: 'Lanskap' }],
        showIf: { pageSize: ['a4', 'letter', 'legal'] } },
      margin('small'),
      { name: 'merge', label: 'Gabungkan semua gambar ke satu PDF', type: 'checkbox', default: true },
    ],
  },
  {
    id: 'word-to-pdf', category: 'to-pdf', title: 'Word ke PDF', badge: 'W', hue: 'blue',
    desc: 'Ubah DOC, DOCX, ODT, atau RTF menjadi PDF.', accept: ['.doc', '.docx', '.odt', '.rtf'], kind: 'office',
    minFiles: 1, maxFiles: 20, fields: [],
  },
  {
    id: 'powerpoint-to-pdf', category: 'to-pdf', title: 'PowerPoint ke PDF', badge: 'P', hue: 'orange',
    desc: 'Ubah slide PPT, PPTX, atau ODP menjadi PDF.', accept: ['.ppt', '.pptx', '.odp', '.pps', '.ppsx'], kind: 'office',
    minFiles: 1, maxFiles: 20, fields: [],
  },
  {
    id: 'excel-to-pdf', category: 'to-pdf', title: 'Excel ke PDF', badge: 'X', hue: 'green',
    desc: 'Ubah lembar kerja XLS, XLSX, ODS, atau CSV menjadi PDF.', accept: ['.xls', '.xlsx', '.ods', '.csv'], kind: 'office',
    minFiles: 1, maxFiles: 20, fields: [],
  },
  {
    id: 'html-to-pdf', category: 'to-pdf', title: 'HTML ke PDF', badge: '</>', hue: 'amber',
    desc: 'Simpan halaman web atau file HTML sebagai PDF.', accept: ['.html', '.htm'], kind: 'html',
    minFiles: 0, maxFiles: 1, maxFileMb: 10,
    fields: [
      { name: 'source', label: 'Sumber', type: 'select', default: 'url',
        options: [{ value: 'url', label: 'Alamat web (URL)' }, { value: 'file', label: 'File HTML' }] },
      { name: 'url', label: 'URL halaman', type: 'text', placeholder: 'https://contoh.ac.id/halaman', maxLength: 2000,
        showIf: { source: ['url'] }, required: true },
      pageSize('a4'),
      { name: 'orientation', label: 'Orientasi', type: 'select', default: 'portrait',
        options: [{ value: 'portrait', label: 'Potret' }, { value: 'landscape', label: 'Lanskap' }] },
      margin('small'),
    ],
  },
  // ── Dari PDF ────────────────────────────────────────────
  {
    id: 'pdf-to-jpg', category: 'from-pdf', title: 'PDF ke JPG', badge: 'JPG', hue: 'amber',
    desc: 'Jadikan setiap halaman gambar, atau ambil gambar di dalamnya.', accept: PDF, kind: 'pdf',
    minFiles: 1, maxFiles: 10,
    fields: [
      { name: 'mode', label: 'Mode', type: 'select', default: 'pages',
        options: [{ value: 'pages', label: 'Setiap halaman jadi gambar' }, { value: 'extract', label: 'Ambil gambar di dalam PDF' }] },
      { name: 'dpi', label: 'Resolusi', type: 'select', default: '150', showIf: { mode: ['pages'] },
        options: [{ value: '72', label: 'Rendah (72 dpi)' }, { value: '150', label: 'Sedang (150 dpi)' }, { value: '300', label: 'Tinggi (300 dpi)' }] },
      { name: 'quality', label: 'Kualitas JPG', type: 'number', min: 40, max: 95, step: 5, default: 85 },
    ],
  },
  {
    id: 'pdf-to-word', category: 'from-pdf', title: 'PDF ke Word', badge: 'W', hue: 'blue',
    desc: 'Ubah PDF menjadi DOCX yang bisa diedit.', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 5,
    note: 'PDF hasil scan (berupa gambar) tidak menghasilkan teks yang bisa diedit.', fields: [],
  },
  {
    id: 'pdf-to-powerpoint', category: 'from-pdf', title: 'PDF ke PowerPoint', badge: 'P', hue: 'orange',
    desc: 'Ubah halaman PDF menjadi slide PPTX.', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 5,
    fields: [
      { name: 'mode', label: 'Hasil slide', type: 'select', default: 'image',
        options: [{ value: 'image', label: 'Tampilan persis (gambar per slide)' }, { value: 'editable', label: 'Bisa diedit (tata letak bisa bergeser)' }] },
    ],
  },
  {
    id: 'pdf-to-excel', category: 'from-pdf', title: 'PDF ke Excel', badge: 'X', hue: 'green',
    desc: 'Ambil tabel dari PDF ke XLSX.', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 5,
    fields: [
      { name: 'layout', label: 'Susunan', type: 'select', default: 'per-page',
        options: [{ value: 'per-page', label: 'Satu sheet per halaman' }, { value: 'single', label: 'Semua di satu sheet' }] },
      { name: 'includeText', label: 'Sertakan teks dari halaman tanpa tabel', type: 'checkbox', default: true },
    ],
  },
  {
    id: 'pdf-to-pdfa', category: 'from-pdf', title: 'PDF ke PDF/A', badge: 'A', hue: 'slate',
    desc: 'Format arsip jangka panjang (ISO 19005).', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 10,
    fields: [
      { name: 'level', label: 'Tingkat kepatuhan', type: 'select', default: '2b',
        options: [{ value: '1b', label: 'PDF/A-1b' }, { value: '2b', label: 'PDF/A-2b (disarankan)' }, { value: '3b', label: 'PDF/A-3b' }] },
    ],
  },
  // ── Atur ────────────────────────────────────────────────
  {
    id: 'merge', category: 'organize', title: 'Gabung PDF', badge: '+', hue: 'violet',
    desc: 'Satukan beberapa PDF sesuai urutan yang Anda atur.', accept: PDF, kind: 'pdf',
    minFiles: 2, maxFiles: 50, sortable: true,
    fields: [{ name: 'bookmarks', label: 'Buat bookmark untuk tiap file', type: 'checkbox', default: true }],
  },
  {
    id: 'split', category: 'organize', title: 'Pisah PDF', badge: '÷', hue: 'violet',
    desc: 'Pecah PDF per rentang halaman atau ambil halaman tertentu.', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 1,
    fields: [
      { name: 'mode', label: 'Cara memisah', type: 'select', default: 'ranges',
        options: [
          { value: 'ranges', label: 'Per rentang halaman' }, { value: 'fixed', label: 'Setiap N halaman' },
          { value: 'extract', label: 'Ambil halaman tertentu (1 file)' }, { value: 'all', label: 'Setiap halaman jadi file' },
        ] },
      { name: 'ranges', label: 'Rentang (tiap rentang jadi satu file)', type: 'text', placeholder: '1-3, 4-6, 7-', maxLength: 500,
        showIf: { mode: ['ranges'] }, required: true },
      { name: 'every', label: 'Jumlah halaman per file', type: 'number', min: 1, max: 1000, step: 1, default: 1, showIf: { mode: ['fixed'] } },
      { name: 'pages', label: 'Halaman yang diambil', type: 'text', placeholder: '1, 3, 5-8', maxLength: 500,
        showIf: { mode: ['extract'] }, required: true },
    ],
  },
  {
    id: 'compress', category: 'organize', title: 'Kompres PDF', badge: '↧', hue: 'teal',
    desc: 'Perkecil ukuran file dengan menyesuaikan gambar di dalamnya.', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 20,
    fields: [
      { name: 'level', label: 'Tingkat kompresi', type: 'select', default: 'recommended',
        options: [
          { value: 'low', label: 'Ringan — kualitas tinggi' },
          { value: 'recommended', label: 'Disarankan — seimbang' },
          { value: 'extreme', label: 'Maksimal — ukuran terkecil' },
        ] },
    ],
  },
  // ── Edit & keamanan ─────────────────────────────────────
  {
    id: 'edit', category: 'secure', title: 'Edit PDF', badge: '✎', hue: 'violet', custom: 'editor',
    desc: 'Atur halaman, ganti teks, tambah teks, gambar, bentuk, tanda tangan coretan.', accept: PDF, kind: 'pdf',
    minFiles: 1, maxFiles: 1, fields: [],
  },
  {
    id: 'watermark', category: 'secure', title: 'Watermark PDF', badge: 'Aa', hue: 'rose',
    desc: 'Bubuhkan teks atau logo di atas halaman.', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 10,
    extraUploads: [{ field: 'watermark', label: 'Gambar watermark (PNG/JPG)', accept: ['.png', '.jpg', '.jpeg', '.webp'], max: 1,
      kind: 'image', showIf: { type: ['image'] }, required: true }],
    fields: [
      { name: 'type', label: 'Jenis', type: 'select', default: 'text',
        options: [{ value: 'text', label: 'Teks' }, { value: 'image', label: 'Gambar / logo' }] },
      { name: 'text', label: 'Teks watermark', type: 'textarea', placeholder: 'RAHASIA', maxLength: 300,
        showIf: { type: ['text'] }, required: true },
      { name: 'font', label: 'Huruf', type: 'select', default: 'sans', showIf: { type: ['text'] },
        options: [{ value: 'sans', label: 'Sans (Helvetica)' }, { value: 'serif', label: 'Serif (Times)' }, { value: 'mono', label: 'Mono (Courier)' }] },
      { name: 'fontSize', label: 'Ukuran huruf (pt)', type: 'number', min: 6, max: 300, step: 1, default: 60, showIf: { type: ['text'] } },
      { name: 'bold', label: 'Tebal', type: 'checkbox', default: true, showIf: { type: ['text'] } },
      { name: 'color', label: 'Warna', type: 'color', default: '#c2364f', showIf: { type: ['text'] } },
      { name: 'imageScale', label: 'Lebar gambar (% lebar halaman)', type: 'number', min: 5, max: 100, step: 5, default: 30, showIf: { type: ['image'] } },
      { name: 'position', label: 'Posisi', type: 'position', default: 'mc' },
      { name: 'rotation', label: 'Rotasi (derajat)', type: 'number', min: -180, max: 180, step: 5, default: 45 },
      { name: 'opacity', label: 'Transparansi', type: 'range', min: 0.05, max: 1, step: 0.05, default: 0.3 },
      { name: 'layer', label: 'Lapisan', type: 'select', default: 'over',
        options: [{ value: 'over', label: 'Di atas isi halaman' }, { value: 'under', label: 'Di bawah isi halaman' }] },
      { name: 'pages', label: 'Halaman (kosongkan = semua)', type: 'text', placeholder: '1-3, 5', maxLength: 500 },
    ],
  },
  {
    id: 'remove-watermark', category: 'secure', title: 'Hapus Watermark', badge: 'wm', hue: 'teal',
    desc: 'Hapus watermark teks atau logo yang masih berupa objek terpisah.', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 10,
    note: 'Gunakan untuk dokumen milik Anda atau yang Anda berhak ubah — misalnya menghapus tanda DRAFT setelah dokumen final. '
      + 'Watermark yang sudah menyatu dengan gambar hasil scan tidak bisa dihapus otomatis.',
    fields: [
      { name: 'text', label: 'Teks watermark yang juga dihapus (opsional)', type: 'text', placeholder: 'mis. DRAFT atau RAHASIA', maxLength: 200 },
    ],
  },
  {
    id: 'unlock', category: 'secure', title: 'Unlock PDF', badge: 'key', hue: 'slate',
    desc: 'Hapus password dan batasan cetak/salin dari PDF milik Anda.', accept: PDF, kind: 'pdf', minFiles: 1, maxFiles: 10,
    note: 'Gunakan hanya untuk dokumen yang Anda miliki atau berhak membukanya. Password pembuka tetap diperlukan bila ada.',
    fields: [{ name: 'password', label: 'Password (jika PDF meminta password saat dibuka)', type: 'password', maxLength: 200 }],
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.id, t]));

/** Versi publik untuk frontend (tanpa detail internal). */
export function publicTools() {
  return {
    categories: CATEGORIES,
    tools: TOOLS.map((t) => ({
      ...t,
      fields: t.id === 'html-to-pdf' && !config.htmlUrlEnabled
        ? t.fields.filter((f) => f.name !== 'url').map((f) => (f.name === 'source'
          ? { ...f, default: 'file', options: f.options.filter((o) => o.value === 'file') } : f))
        : t.fields,
    })),
    limits: { maxFileMb: config.maxFileMb, maxTotalMb: config.maxTotalMb, resultTtlMinutes: config.resultTtlMinutes },
  };
}
