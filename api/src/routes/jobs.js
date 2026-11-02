import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { pool } from '../db.js';
import { TOOL_MAP, publicTools } from '../tools.js';
import {
  ValidationError, checkFileSignature, extraUploadVisible, sanitizeOptions, validateEditSpec,
} from '../validate.js';

export const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uploadsRoot = path.join(config.storageDir, 'uploads');
const outputsRoot = path.join(config.storageDir, 'outputs');

const MIME = {
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.jpg': 'image/jpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// Nama file dari multer berupa latin1; ubah ke UTF-8 agar nama berbahasa Indonesia/Arab tetap benar.
const fixName = (name) => {
  const utf = Buffer.from(name, 'latin1').toString('utf8');
  return (utf.includes('�') ? name : utf).replace(/[\\/\0]/g, '_').slice(0, 200);
};

// ── Upload ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = path.join(uploadsRoot, req.jobId);
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename(_req, file, cb) {
    const ext = path.extname(fixName(file.originalname)).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const tool = req.tool;
  const ext = path.extname(fixName(file.originalname)).toLowerCase();
  let accept = tool.accept;
  if (file.fieldname === 'watermark') accept = tool.extraUploads?.find((e) => e.field === 'watermark')?.accept ?? [];
  if (file.fieldname === 'assets') accept = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  if (file.fieldname === 'extra') accept = ['.pdf'];
  if (!accept.includes(ext)) {
    return cb(new ValidationError(`Tipe file "${ext || 'tanpa ekstensi'}" tidak didukung untuk ${tool.title}. Gunakan: ${accept.join(', ')}`));
  }
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxFileMb * 1024 * 1024, files: 120, fieldSize: 8 * 1024 * 1024, fields: 20 },
});

const createLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.jobsPerMinute,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.' },
});

function prepareJob(req, _res, next) {
  const tool = TOOL_MAP.get(req.params.tool);
  if (!tool) return next(new ValidationError('Tool tidak dikenal.', 404));
  req.tool = tool;
  req.jobId = crypto.randomUUID();
  return next();
}

const uploadFields = (req, res, next) => upload.fields([
  { name: 'files', maxCount: req.tool.maxFiles || 1 },
  { name: 'watermark', maxCount: 1 },
  { name: 'extra', maxCount: 10 },
  { name: 'assets', maxCount: 100 },
])(req, res, (err) => {
  if (!err) return next();
  // unggahan sebagian dibuang bila ditolak
  return removeUploads(req.jobId).finally(() => next(err));
});

async function removeUploads(jobId) {
  if (jobId && UUID_RE.test(jobId)) await fsp.rm(path.join(uploadsRoot, jobId), { recursive: true, force: true });
}

router.get('/tools', (_req, res) => res.json(publicTools()));

router.post('/jobs/:tool', createLimiter, prepareJob, uploadFields, async (req, res, next) => {
  const { tool, jobId } = req;
  try {
    const groups = req.files || {};
    const all = Object.values(groups).flat();
    const files = groups.files || [];
    let rawOptions = {};
    try {
      rawOptions = req.body?.options ? JSON.parse(req.body.options) : {};
    } catch {
      throw new ValidationError('Format opsi tidak valid.');
    }
    const options = sanitizeOptions(tool, rawOptions);

    const minFiles = tool.id === 'html-to-pdf' && options.source === 'file' ? 1 : tool.minFiles;
    if (files.length < minFiles) {
      throw new ValidationError(minFiles > 1 ? `Pilih minimal ${minFiles} file.` : 'Pilih file terlebih dahulu.');
    }
    const total = all.reduce((s, f) => s + f.size, 0);
    if (total > config.maxTotalMb * 1024 * 1024) throw new ValidationError(`Total ukuran file melebihi ${config.maxTotalMb} MB.`);
    if (tool.maxFileMb && files.some((f) => f.size > tool.maxFileMb * 1024 * 1024)) {
      throw new ValidationError(`Ukuran file maksimal ${tool.maxFileMb} MB untuk ${tool.title}.`);
    }

    for (const extra of tool.extraUploads || []) {
      if (extra.required && extraUploadVisible(extra, options) && !(groups[extra.field]?.length)) {
        throw new ValidationError(`${extra.label} wajib diunggah.`);
      }
    }
    if (tool.custom === 'editor') {
      if (!rawOptions.edit) throw new ValidationError('Data editor tidak ada.');
      options.edit = validateEditSpec(rawOptions.edit, {
        sourceFiles: 1 + (groups.extra?.length || 0),
        assetCount: groups.assets?.length || 0,
      });
      if (rawOptions.password) options.password = String(rawOptions.password).slice(0, 200);
    }

    // Cek isi file sungguhan, bukan hanya ekstensi
    for (const f of all) {
      const kind = f.fieldname === 'files' ? tool.kind : f.fieldname === 'extra' ? 'pdf' : 'image';
      if (!(await checkFileSignature(f.path, kind))) {
        throw new ValidationError(`File "${fixName(f.originalname)}" rusak atau isinya tidak sesuai ekstensinya.`);
      }
    }

    const inputFiles = all.map((f) => ({
      field: f.fieldname,
      name: fixName(f.originalname),
      path: path.relative(config.storageDir, f.path).split(path.sep).join('/'),
      size: f.size,
    }));
    await pool.query(
      `INSERT INTO jobs (id, tool, options, input_files, client_ip) VALUES ($1, $2, $3, $4, $5)`,
      [jobId, tool.id, options, JSON.stringify(inputFiles), req.ip || null],
    );
    res.status(202).json({ id: jobId, status: 'queued' });
  } catch (err) {
    await removeUploads(jobId);
    next(err);
  }
});

async function findJob(id) {
  if (!UUID_RE.test(id)) throw new ValidationError('Job tidak ditemukan.', 404);
  const { rows } = await pool.query(
    `SELECT id, tool, status, output_name, output_size, output_path, result, error, created_at, finished_at, expires_at,
            CASE WHEN status = 'queued'
                 THEN (SELECT count(*) FROM jobs q WHERE q.status = 'queued' AND q.created_at < j.created_at)::int
            END AS queue_position
       FROM jobs j WHERE id = $1`, [id],
  );
  if (!rows.length) throw new ValidationError('Job tidak ditemukan.', 404);
  return rows[0];
}

router.get('/jobs/:id', async (req, res) => {
  const j = await findJob(req.params.id);
  res.set('Cache-Control', 'no-store').json({
    id: j.id,
    tool: j.tool,
    status: j.status,
    queuePosition: j.queue_position,
    error: j.status === 'failed' ? j.error : null,
    output: j.status === 'done' ? { name: j.output_name, size: Number(j.output_size), url: `/api/jobs/${j.id}/download` } : null,
    result: j.result,
    expiresAt: j.expires_at,
  });
});

router.get('/jobs/:id/download', async (req, res) => {
  const j = await findJob(req.params.id);
  if (j.status === 'expired') throw new ValidationError('File sudah dihapus karena melewati batas waktu penyimpanan.', 410);
  if (j.status !== 'done' || !j.output_path) throw new ValidationError('File belum siap.', 409);
  const abs = path.resolve(config.storageDir, j.output_path);
  if (!abs.startsWith(outputsRoot + path.sep)) throw new ValidationError('Lokasi file tidak valid.', 400);
  if (!fs.existsSync(abs)) throw new ValidationError('File sudah tidak tersedia.', 410);
  const ext = path.extname(j.output_name).toLowerCase();
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  const inline = req.query.inline === '1' && ext === '.pdf';
  if (inline) {
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(j.output_name)}`);
    return res.sendFile(abs);
  }
  return res.download(abs, j.output_name);
});

router.delete('/jobs/:id', async (req, res) => {
  const j = await findJob(req.params.id);
  if (j.status === 'processing') throw new ValidationError('File sedang diproses. Coba lagi setelah selesai.', 409);
  await pool.query(`UPDATE jobs SET status = 'expired', output_path = NULL, expires_at = now() WHERE id = $1`, [j.id]);
  await Promise.all([
    fsp.rm(path.join(uploadsRoot, j.id), { recursive: true, force: true }),
    fsp.rm(path.join(outputsRoot, j.id), { recursive: true, force: true }),
  ]);
  res.json({ ok: true });
});

// Statistik sederhana untuk admin: GET /api/stats  (header: Authorization: Bearer <ADMIN_TOKEN>)
router.get('/stats', async (req, res) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(token);
  const b = Buffer.from(config.adminToken);
  if (!config.adminToken || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ValidationError('Tidak diizinkan.', 401);
  }
  const { rows } = await pool.query(
    `SELECT * FROM job_stats_daily WHERE day > now() - interval '30 days' ORDER BY day DESC, total DESC`,
  );
  const { rows: [queue] } = await pool.query(
    `SELECT count(*) FILTER (WHERE status='queued')::int AS queued,
            count(*) FILTER (WHERE status='processing')::int AS processing FROM jobs`,
  );
  res.json({ queue, daily: rows });
});

router.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});
