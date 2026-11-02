import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

pool.on('error', (err) => console.error('[db] koneksi idle bermasalah:', err.message));

/** Jalankan db/init.sql (idempoten) — dipakai saat start & oleh `npm run migrate`. */
export async function migrate() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../db/init.sql'), path.resolve(here, '../../db/init.sql')];
  for (const file of candidates) {
    try {
      const sql = await fs.readFile(file, 'utf8');
      await pool.query(sql);
      return file;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  throw new Error('db/init.sql tidak ditemukan');
}
