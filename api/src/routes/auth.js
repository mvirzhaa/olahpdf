import { Router } from 'express';
import { config } from '../config.js';

export const router = Router();

router.get('/me', (req, res) => {
  res.json({
    authenticated: Boolean(req.user),
    user: req.user || null,
    eportalUrl: config.sso.eportalUrl,
  });
});

const clearCookieHeaders = (req) => {
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
  return cookieOptions.join('; ');
};

router.all('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearCookieHeaders(req));
  if (req.method === 'GET' || !req.xhr) {
    return res.redirect(config.sso.eportalUrl);
  }
  res.json({
    success: true,
    redirect: config.sso.eportalUrl,
  });
});

