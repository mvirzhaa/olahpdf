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

router.post('/logout', (req, res) => {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookieOptions = [
    `${config.sso.cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isSecure) cookieOptions.push('Secure');

  res.setHeader('Set-Cookie', cookieOptions.join('; '));
  res.json({
    success: true,
    redirect: config.sso.eportalUrl,
  });
});

