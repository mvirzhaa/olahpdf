import path from 'node:path';

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

export const config = {
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://olahpdf:olahpdf@localhost:5432/olahpdf',
  storageDir: path.resolve(process.env.STORAGE_DIR || './data'),
  maxFileMb: int(process.env.MAX_FILE_MB, 100),
  maxTotalMb: int(process.env.MAX_TOTAL_MB, 300),
  jobsPerMinute: int(process.env.JOBS_PER_MINUTE, 30),
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  adminToken: process.env.ADMIN_TOKEN || '',
  htmlUrlEnabled: (process.env.HTML_URL_ENABLED || '1') === '1',
  resultTtlMinutes: int(process.env.RESULT_TTL_MINUTES, 60),
  sso: {
    enabled: (process.env.SSO_ENABLED ?? 'true') === 'true' || process.env.SSO_ENABLED === '1',
    baseUrl: (process.env.SSO_BASE_URL || 'https://eportal.uika-bogor.ac.id/api').replace(/\/+$/, ''),
    eportalUrl: (process.env.EPORTAL_URL || 'https://eportal.uika-bogor.ac.id').replace(/\/+$/, ''),
    clientId: process.env.SSO_CLIENT_ID || '',
    clientSecret: process.env.SSO_CLIENT_SECRET || '',
    appModuleId: process.env.SSO_APP_MODULE_ID || '',
    cookieName: process.env.SSO_COOKIE_NAME || 'uika_pdf_session',
    sessionSecret: process.env.SESSION_SECRET || 'olahpdf-session-secret-change-in-production',
    sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 12),
  },
};
