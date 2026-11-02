import { migrate, pool } from './db.js';

const file = await migrate();
console.log(`Skema database siap (${file}).`);
await pool.end();
