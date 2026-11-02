import crypto from 'node:crypto';
import { config } from './config.js';

export function parseCookies(header = '') {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

export function signSession(userData, secret) {
  const payload = {
    user: userData,
    exp: Date.now() + config.sso.sessionTtlHours * 3600 * 1000,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifySession(tokenString, secret) {
  if (!tokenString || typeof tokenString !== 'string') return null;
  const parts = tokenString.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload.user;
  } catch {
    return null;
  }
}

export async function introspectToken(token, appModuleId) {
  let targetModuleId = appModuleId || config.sso.appModuleId;

  // Ekstrak metadata dari token jika ada (iss = issuer endpoint, appModule_id = ID modul)
  let tokenIss = null;
  try {
    const parts = (token || '').split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload.iss && typeof payload.iss === 'string') {
        tokenIss = payload.iss;
      }
      if (!targetModuleId && payload.appModule_id) {
        targetModuleId = payload.appModule_id;
      }
    }
  } catch {}

  // Susun daftar candidate URL untuk introspect
  const candidates = [];

  // 1. Dari konfigurasi SSO_BASE_URL (jika di-set khusus)
  const base = (config.sso.baseUrl || '').replace(/\/+$/, '');
  if (base) {
    if (base.endsWith('/api') || base.includes('/api/')) {
      candidates.push(`${base}/sso/introspect`);
    } else {
      candidates.push(`${base}/eportal-api/api/sso/introspect`);
      candidates.push(`${base}/api/sso/introspect`);
      candidates.push(`${base}/sso/introspect`);
    }
  }

  // 2. Candidate endpoint E-Portal UIKA (dengan domain host map & IP internal)
  candidates.push('https://eportal.uika-bogor.ac.id/eportal-api/api/sso/introspect');
  candidates.push('http://eportal.uika-bogor.ac.id/eportal-api/api/sso/introspect');
  candidates.push('https://eportal.uika-bogor.ac.id/api/sso/introspect');
  candidates.push('http://eportal.uika-bogor.ac.id/api/sso/introspect');
  candidates.push('http://172.16.18.141/eportal-api/api/sso/introspect');
  candidates.push('http://172.16.18.141/api/sso/introspect');

  // 3. Dari claim iss token jika ada
  if (tokenIss) {
    const apiBase = tokenIss.replace(/\/sso\/redirect\/?$/, '').replace(/\/+$/, '');
    candidates.push(`${apiBase}/sso/introspect`);
  }

  const uniqueCandidates = [...new Set(candidates)];
  let lastError = null;

  for (const candidateBase of uniqueCandidates) {
    try {
      const url = new URL(candidateBase);
      if (targetModuleId) {
        url.searchParams.set('appModule_id', targetModuleId);
      }

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-SSO-Client-ID': config.sso.clientId,
          'X-SSO-Client-Secret': config.sso.clientSecret,
          Host: 'eportal.uika-bogor.ac.id',
          Accept: 'application/json',
        },
      });

      // Jika 404, coba candidate berikutnya
      if (res.status === 404) {
        lastError = new Error(`Endpoint tidak ditemukan (404) di ${url.origin}${url.pathname}`);
        continue;
      }

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = body?.message || `HTTP ${res.status}`;
        throw new Error(`SSO introspect gagal: ${msg}`);
      }
      return body;
    } catch (err) {
      console.warn(`[sso] introspect candidate ${candidateBase} gagal:`, err.message);
      lastError = err;
      continue;
    }
  }

  throw lastError || new Error('SSO introspect gagal: semua endpoint candidate tidak dapat dihubungi');
}

export function restrictedPageHtml(eportalUrl, errorDetail = null) {
  const detailAlert = errorDetail ? `
    <div class="alert-error">
      <strong>Catatan:</strong> ${escapeHtml(errorDetail)}
    </div>` : '';

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Akses Terbatas — PDF Editor UIKA</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #047857;
      --primary-hover: #065f46;
      --accent: #10b981;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 10% 20%, rgba(16, 185, 129, 0.08) 0%, rgba(248, 250, 252, 1) 90%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 1.25rem;
      padding: 2.5rem;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.03);
      text-align: center;
    }
    .icon-badge {
      width: 64px;
      height: 64px;
      margin: 0 auto 1.5rem;
      background: #ecfdf5;
      color: var(--primary);
      border-radius: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid #d1fae5;
    }
    .icon-badge svg {
      width: 32px;
      height: 32px;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 800;
      color: #064e3b;
      margin-bottom: 0.75rem;
    }
    p {
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 1.75rem;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      background: var(--primary);
      color: #ffffff;
      font-weight: 600;
      font-size: 0.95rem;
      padding: 0.85rem 1.75rem;
      border-radius: 0.75rem;
      text-decoration: none;
      transition: all 0.2s ease;
      box-shadow: 0 4px 6px -1px rgba(4, 120, 87, 0.2);
    }
    .btn:hover {
      background: var(--primary-hover);
      transform: translateY(-1px);
      box-shadow: 0 6px 10px -1px rgba(4, 120, 87, 0.3);
    }
    .alert-error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.85rem;
      margin-bottom: 1.25rem;
      text-align: left;
    }
    .footer-note {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      font-size: 0.8rem;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-badge">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <h1>Akses Melalui E-Portal</h1>
    <p>Aplikasi <strong>PDF Editor UIKA (OlahPDF)</strong> terintegrasi dengan Single Sign-On (SSO) dan hanya dapat diakses melalui portal resmi E-Portal UIKA.</p>
    ${detailAlert}
    <a class="btn" href="${escapeHtml(eportalUrl)}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
        <polyline points="10 17 15 12 10 7"></polyline>
        <line x1="15" y1="12" x2="3" y2="12"></line>
      </svg>
      Buka E-Portal UIKA
    </a>
    <div class="footer-note">
      Universitas Ibn Khaldun Bogor &bull; Sistem Terintegrasi
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function ssoMiddleware(req, res, next) {
  // 1. Lewati asset statis dan health check
  if (
    req.path === '/api/health' ||
    req.path.startsWith('/vendor/') ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/js/') ||
    req.path.startsWith('/img/') ||
    req.path === '/favicon.ico'
  ) {
    return next();
  }

  // 2. Cek apakah ada redirect token SSO dari E-Portal di URL (?token=...)
  const token = req.query.token;
  if (token && typeof token === 'string') {
    const appModuleId = req.query.appModule_id || config.sso.appModuleId;

    introspectToken(token, appModuleId)
      .then((data) => {
        if (!data?.valid) {
          throw new Error(data?.message || 'Token SSO tidak valid.');
        }

        const isAuthorized = data.access?.has_access ?? true;
        if (!isAuthorized) {
          throw new Error('Akun Anda tidak memiliki izin untuk mengakses modul PDF Editor.');
        }

        const userData = {
          sso_id: data.user?.sso_id,
          name: data.user?.name || 'Pengguna E-Portal',
          email: data.user?.email || '',
          role: data.access?.role_name || data.user?.institutional_role || 'user',
          unit: data.access?.unit_name || data.user?.unit_name || '',
          nidn: data.user?.nidn || null,
          npm: data.user?.npm || null,
          nip: data.user?.nip || null,
          permissions: data.access?.permissions || [],
        };

        const sessionToken = signSession(userData, config.sso.sessionSecret);
        const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        const cookieOptions = [
          `${config.sso.cookieName}=${encodeURIComponent(sessionToken)}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          `Max-Age=${config.sso.sessionTtlHours * 3600}`,
        ];
        if (isSecure) cookieOptions.push('Secure');

        res.setHeader('Set-Cookie', cookieOptions.join('; '));

        // Bersihkan token dari URL di address bar
        const cleanUrl = req.path || '/';
        return res.redirect(cleanUrl);
      })
      .catch((err) => {
        console.error('[sso] introspect failed:', err.message);
        if (req.path.startsWith('/api')) {
          return res.status(401).json({
            error: 'Verifikasi SSO E-Portal gagal: ' + err.message,
            eportalUrl: config.sso.eportalUrl,
          });
        }
        return res.status(401).send(restrictedPageHtml(config.sso.eportalUrl, err.message));
      });
    return;
  }

  // 3. Cek Cookie Session yang sudah ada
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[config.sso.cookieName];
  const user = verifySession(sessionToken, config.sso.sessionSecret);

  if (user) {
    req.user = user;
    return next();
  }

  // 4. Jika SSO tidak diaktifkan (misal mode dev offline tanpa koneksi E-Portal)
  if (!config.sso.enabled) {
    req.user = {
      sso_id: 'dev-offline',
      name: 'Pengembang Lokal',
      email: 'dev@uika-bogor.ac.id',
      role: 'admin',
      unit: 'BTI',
      permissions: ['*'],
    };
    return next();
  }

  // 5. Belum terautentikasi dan tidak ada token
  if (req.path.startsWith('/api')) {
    return res.status(401).json({
      error: 'Akses ditolak. Sesi E-Portal diperlukan.',
      eportalUrl: config.sso.eportalUrl,
    });
  }

  // Browser request halaman utama / HTML
  return res.status(403).send(restrictedPageHtml(config.sso.eportalUrl));
}

