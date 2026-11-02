import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { router as jobsRouter } from './routes/jobs.js';
import { router as authRouter } from './routes/auth.js';
import { ssoMiddleware } from './sso.js';
import { ValidationError } from './validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));

for (const sub of ['uploads', 'outputs']) fs.mkdirSync(path.join(config.storageDir, sub), { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'worker-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'blob:', 'data:'],
      'frame-src': ["'self'", 'blob:'],
      'upgrade-insecure-requests': null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Aset statis pendukung (tanpa index.html otomatis) disajikan publik
app.use('/vendor/pdfjs', express.static(pdfjsDir, { maxAge: '7d', index: false }));
app.use(express.static(path.join(here, '../public'), { maxAge: '1h', index: false }));

// Endpoint logout langsung yang membersihkan sesi dan mengalihkan ke E-Portal
app.get('/logout', (req, res) => {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookieOptions = [
    `${config.sso.cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (isSecure) cookieOptions.push('Secure');
  res.setHeader('Set-Cookie', cookieOptions.join('; '));
  return res.redirect(config.sso.eportalUrl);
});

// Proteksi SSO UIKA E-Portal untuk seluruh API dan halaman
app.use(ssoMiddleware);

app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/auth', authRouter);
app.use('/api', jobsRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(here, '../public/index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = {
      LIMIT_FILE_SIZE: `Ukuran file maksimal ${config.maxFileMb} MB.`,
      LIMIT_FILE_COUNT: 'Jumlah file terlalu banyak.',
      LIMIT_UNEXPECTED_FILE: 'Jumlah file melebihi batas untuk tool ini.',
    }[err.code] || 'Unggahan tidak valid.';
    return res.status(400).json({ error: msg });
  }
  if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message });
  console.error(`[api] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

try {
  await migrate();
} catch (err) {
  console.error('[db] migrasi gagal:', err.message);
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`OlahPDF berjalan di http://localhost:${config.port}`);
});

const shutdown = () => {
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
