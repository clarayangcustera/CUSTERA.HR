require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://custera:custera@localhost:5432/custera_hris' });

async function main() {
  const schema = fs.readFileSync(path.resolve(__dirname, '../sql/schema.sql'), 'utf8');
  await pool.query(schema);
  const org = await pool.query(
    `INSERT INTO organizations (name, code, timezone, currency)
     VALUES ('Custera HRIS Demo', 'custera-demo', 'Asia/Singapore', 'SGD')
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
  );
  const password = process.env.DEMO_PASSWORD || 'ChangeMe123!';
  const email = process.env.DEMO_ADMIN_EMAIL || 'admin@custera-hris.local';
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (organization_id,email,password_hash,full_name,role)
     VALUES ($1,$2,$3,'Clara Administrator','ADMIN')
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, active=TRUE, updated_at=NOW()`,
    [org.rows[0].id, email, hash],
  );
  console.log(`Seed completed. Sign in with ${email}`);
  await pool.end();
}
main().catch(async (error) => { console.error(error); await pool.end(); process.exit(1); });
