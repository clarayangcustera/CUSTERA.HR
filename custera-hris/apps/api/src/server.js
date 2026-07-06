/* eslint-disable no-console */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { z } = require('zod');

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://custera:custera@localhost:5432/custera_hris';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const SEED_DEMO = (process.env.SEED_DEMO || 'true').toLowerCase() === 'true';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' && !DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN.split(',').map((value) => value.trim()), credentials: false }));
app.use(express.json({ limit: '1mb' }));

const roles = ['ADMIN', 'MANAGER', 'EMPLOYEE'];
const nowYear = () => new Date().getFullYear();

async function query(text, params = []) {
  return pool.query(text, params);
}

async function audit({ organizationId, actorUserId, action, entityType, entityId, details = {} }) {
  await query(
    `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [organizationId, actorUserId || null, action, entityType, entityId ? String(entityId) : null, JSON.stringify(details)],
  );
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dateOnly(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

function daysBetweenInclusive(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function signToken(user) {
  return jwt.sign(
    { userId: user.id, organizationId: user.organization_id, role: user.role },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

async function getActor(userId) {
  const result = await query(
    `SELECT u.id, u.organization_id, u.email, u.full_name, u.role, u.active,
            e.id AS employee_id, e.first_name, e.last_name, e.department_id
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication is required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const actor = await getActor(payload.userId);
    if (!actor || !actor.active) return res.status(401).json({ error: 'Session is no longer active.' });
    req.user = actor;
    return next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    return next();
  };
}

function canReview(user) {
  return user.role === 'ADMIN' || user.role === 'MANAGER';
}

async function initializeDatabase() {
  const schemaPath = path.resolve(__dirname, '../sql/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await query(schema);
  if (SEED_DEMO) await seedDemoData();
}

async function seedDemoData() {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM organizations WHERE code = $1', ['custera-demo']);
    // Seed exactly once. Subsequent restarts must never overwrite users or HR data.
    if (existing.rows[0]) return;
    await client.query('BEGIN');
    const orgResult = await client.query(
      `INSERT INTO organizations (name, code, timezone, currency)
       VALUES ($1, $2, 'Asia/Singapore', 'SGD')
       RETURNING id`,
      ['Custera HRIS Demo', 'custera-demo'],
    );
    const organizationId = orgResult.rows[0].id;

    const departmentSeeds = [
      ['Human Resources', 'HR'],
      ['Engineering', 'ENG'],
      ['Operations', 'OPS'],
      ['Finance', 'FIN'],
    ];
    const departmentIds = {};
    for (const [name, code] of departmentSeeds) {
      const department = await client.query(
        `INSERT INTO departments (organization_id, name, code)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, name) DO UPDATE SET code = EXCLUDED.code
         RETURNING id`,
        [organizationId, name, code],
      );
      departmentIds[code] = department.rows[0].id;
    }

    const adminEmail = process.env.DEMO_ADMIN_EMAIL || 'admin@custera-hris.local';
    const password = process.env.DEMO_PASSWORD || 'ChangeMe123!';
    const passwordHash = await bcrypt.hash(password, 12);
    const seeds = [
      { email: adminEmail, name: 'Clara Administrator', role: 'ADMIN', code: 'CUST-001', first: 'Clara', last: 'Administrator', title: 'HR Administrator', dept: 'HR', salary: 5200 },
      { email: 'manager@custera-hris.local', name: 'Willie Manager', role: 'MANAGER', code: 'CUST-002', first: 'Willie', last: 'Manager', title: 'Operations Manager', dept: 'OPS', salary: 6800 },
      { email: 'employee@custera-hris.local', name: 'Alicia Employee', role: 'EMPLOYEE', code: 'CUST-003', first: 'Alicia', last: 'Employee', title: 'Project Engineer', dept: 'ENG', salary: 3900 },
    ];

    const employeeIds = {};
    for (const seed of seeds) {
      const user = await client.query(
        `INSERT INTO users (organization_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name, role = EXCLUDED.role, active = TRUE, updated_at = NOW()
         RETURNING id`,
        [organizationId, seed.email, passwordHash, seed.name, seed.role],
      );
      const employee = await client.query(
        `INSERT INTO employees
           (organization_id, user_id, employee_code, first_name, last_name, work_email, job_title, employment_type, hire_date, department_id, basic_salary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Permanent', CURRENT_DATE - INTERVAL '180 days', $8, $9)
         ON CONFLICT (organization_id, employee_code) DO UPDATE
         SET user_id = EXCLUDED.user_id, work_email = EXCLUDED.work_email, job_title = EXCLUDED.job_title,
             department_id = EXCLUDED.department_id, basic_salary = EXCLUDED.basic_salary, active = TRUE, archived_at = NULL, updated_at = NOW()
         RETURNING id`,
        [organizationId, user.rows[0].id, seed.code, seed.first, seed.last, seed.email, seed.title, departmentIds[seed.dept], seed.salary],
      );
      employeeIds[seed.role] = employee.rows[0].id;
    }

    await client.query('UPDATE employees SET manager_employee_id = $1 WHERE organization_id = $2 AND id <> $1', [employeeIds.MANAGER, organizationId]);

    const leaveTypeSeeds = [
      ['Annual Leave', 'AL', 14],
      ['Sick Leave', 'SL', 14],
      ['Unpaid Leave', 'UPL', 0],
    ];
    for (const [name, code, days] of leaveTypeSeeds) {
      const leaveType = await client.query(
        `INSERT INTO leave_types (organization_id, name, code, default_days)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name, default_days = EXCLUDED.default_days
         RETURNING id`,
        [organizationId, name, code, days],
      );
      for (const employeeId of Object.values(employeeIds)) {
        await client.query(
          `INSERT INTO leave_entitlements (organization_id, employee_id, leave_type_id, entitlement_year, entitled_days)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (employee_id, leave_type_id, entitlement_year) DO NOTHING`,
          [organizationId, employeeId, leaveType.rows[0].id, nowYear(), days],
        );
      }
    }

    const claimSeeds = [
      ['Transport', 'TRANSPORT', false],
      ['Meal & Entertainment', 'MEAL', false],
      ['Medical', 'MEDICAL', true],
    ];
    for (const [name, code, requiresAttachment] of claimSeeds) {
      await client.query(
        `INSERT INTO claim_types (organization_id, name, code, requires_attachment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name, requires_attachment = EXCLUDED.requires_attachment`,
        [organizationId, name, code, requiresAttachment],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function handle(routeHandler) {
  return async (req, res) => {
    try {
      await routeHandler(req, res);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Invalid input.' });
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', service: 'custera-hris', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', error: 'Database is not available.' });
  }
});

app.post('/api/auth/login', handle(async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const result = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [input.email]);
  const user = result.rows[0];
  if (!user || !user.active || !(await bcrypt.compare(input.password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const actor = await getActor(user.id);
  await audit({ organizationId: user.organization_id, actorUserId: user.id, action: 'LOGIN', entityType: 'SESSION', entityId: user.id, details: { email: user.email } });
  return res.json({ token: signToken(user), user: actor });
}));

app.get('/api/auth/me', authenticate, handle(async (req, res) => {
  res.json({ user: req.user });
}));

app.post('/api/auth/change-password', authenticate, handle(async (req, res) => {
  const input = z.object({ current_password: z.string().min(1), new_password: z.string().min(10).max(128) }).parse(req.body);
  const existing = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!existing.rows[0] || !(await bcrypt.compare(input.current_password, existing.rows[0].password_hash))) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  const passwordHash = await bcrypt.hash(input.new_password, 12);
  await query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [passwordHash, req.user.id]);
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CHANGE_PASSWORD', entityType: 'USER', entityId: req.user.id });
  return res.json({ success: true });
}));

app.get('/api/dashboard', authenticate, handle(async (req, res) => {
  const orgId = req.user.organization_id;
  const personalOnly = req.user.role === 'EMPLOYEE';
  const employeeId = req.user.employee_id || -1;
  const counts = {};
  const employeeSql = personalOnly ? 'SELECT 1 AS total' : 'SELECT COUNT(*)::int AS total FROM employees WHERE organization_id = $1 AND active = TRUE';
  const employeeResult = await query(employeeSql, personalOnly ? [] : [orgId]);
  counts.employees = employeeResult.rows[0].total;
  const leaveResult = await query(
    `SELECT COUNT(*)::int AS total FROM leave_requests WHERE organization_id = $1 AND status = 'PENDING'${personalOnly ? ' AND employee_id = $2' : ''}`,
    personalOnly ? [orgId, employeeId] : [orgId],
  );
  const claimResult = await query(
    `SELECT COUNT(*)::int AS total FROM claim_requests WHERE organization_id = $1 AND status = 'PENDING'${personalOnly ? ' AND employee_id = $2' : ''}`,
    personalOnly ? [orgId, employeeId] : [orgId],
  );
  const attendanceResult = await query(
    `SELECT COUNT(*)::int AS total FROM attendance_records WHERE organization_id = $1 AND work_date = CURRENT_DATE${personalOnly ? ' AND employee_id = $2' : ''}`,
    personalOnly ? [orgId, employeeId] : [orgId],
  );
  const upcoming = await query(
    `SELECT lr.id, lr.start_date, lr.end_date, lr.requested_days, lr.status, lt.name AS leave_type,
            e.first_name || ' ' || e.last_name AS employee_name
     FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     JOIN employees e ON e.id = lr.employee_id
     WHERE lr.organization_id = $1 ${personalOnly ? 'AND lr.employee_id = $2' : ''}
     ORDER BY lr.created_at DESC LIMIT 6`,
    personalOnly ? [orgId, employeeId] : [orgId],
  );
  res.json({
    stats: { employees: counts.employees, pendingLeave: leaveResult.rows[0].total, pendingClaims: claimResult.rows[0].total, attendanceToday: attendanceResult.rows[0].total },
    recentLeave: upcoming.rows,
  });
}));

app.get('/api/departments', authenticate, handle(async (req, res) => {
  const result = await query('SELECT * FROM departments WHERE organization_id = $1 ORDER BY name', [req.user.organization_id]);
  res.json(result.rows);
}));

app.post('/api/departments', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ name: z.string().min(2).max(150), code: z.string().max(30).optional().or(z.literal('')) }).parse(req.body);
  const result = await query(
    'INSERT INTO departments (organization_id, name, code) VALUES ($1, $2, $3) RETURNING *',
    [req.user.organization_id, input.name.trim(), input.code?.trim() || null],
  );
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CREATE', entityType: 'DEPARTMENT', entityId: result.rows[0].id, details: { name: input.name } });
  res.status(201).json(result.rows[0]);
}));

app.get('/api/employees', authenticate, handle(async (req, res) => {
  const showArchived = String(req.query.archived || '') === 'true';
  const search = String(req.query.search || '').trim();
  const params = [req.user.organization_id];
  let where = 'e.organization_id = $1';
  if (!showArchived) where += ' AND e.active = TRUE';
  if (req.user.role === 'EMPLOYEE') {
    params.push(req.user.employee_id || -1);
    where += ` AND e.id = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (e.first_name ILIKE $${params.length} OR e.last_name ILIKE $${params.length} OR e.employee_code ILIKE $${params.length} OR e.work_email ILIKE $${params.length})`;
  }
  const result = await query(
    `SELECT e.*, d.name AS department_name,
            m.first_name || ' ' || m.last_name AS manager_name,
            u.role AS user_role
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN employees m ON m.id = e.manager_employee_id
     LEFT JOIN users u ON u.id = e.user_id
     WHERE ${where}
     ORDER BY e.active DESC, e.first_name, e.last_name`,
    params,
  );
  res.json(result.rows);
}));

app.post('/api/employees', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const input = z.object({
    employee_code: z.string().min(2).max(40), first_name: z.string().min(1).max(100), last_name: z.string().min(1).max(100),
    work_email: z.string().email().optional().or(z.literal('')), phone: z.string().max(60).optional().or(z.literal('')),
    job_title: z.string().max(160).optional().or(z.literal('')), employment_type: z.string().max(60).optional().or(z.literal('')),
    hire_date: z.string().optional().or(z.literal('')), department_id: z.number().int().nullable().optional(), manager_employee_id: z.number().int().nullable().optional(), basic_salary: z.union([z.number(), z.string()]).optional(),
  }).parse(req.body);
  const result = await query(
    `INSERT INTO employees (organization_id, employee_code, first_name, last_name, work_email, phone, job_title, employment_type, hire_date, department_id, manager_employee_id, basic_salary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9, '')::date,$10,$11,$12) RETURNING *`,
    [req.user.organization_id, input.employee_code.trim(), input.first_name.trim(), input.last_name.trim(), input.work_email?.trim() || null, input.phone?.trim() || null, input.job_title?.trim() || null, input.employment_type || 'Permanent', input.hire_date || '', input.department_id || null, input.manager_employee_id || null, toNumber(input.basic_salary)],
  );
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CREATE', entityType: 'EMPLOYEE', entityId: result.rows[0].id, details: { employee_code: input.employee_code } });
  res.status(201).json(result.rows[0]);
}));

app.patch('/api/employees/:id', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({
    first_name: z.string().min(1).max(100), last_name: z.string().min(1).max(100), work_email: z.string().email().optional().or(z.literal('')),
    phone: z.string().max(60).optional().or(z.literal('')), job_title: z.string().max(160).optional().or(z.literal('')),
    employment_type: z.string().max(60).optional().or(z.literal('')), hire_date: z.string().optional().or(z.literal('')),
    department_id: z.number().int().nullable().optional(), manager_employee_id: z.number().int().nullable().optional(), basic_salary: z.union([z.number(), z.string()]).optional(),
  }).parse(req.body);
  const result = await query(
    `UPDATE employees SET first_name=$1,last_name=$2,work_email=$3,phone=$4,job_title=$5,employment_type=$6,
     hire_date=NULLIF($7, '')::date,department_id=$8,manager_employee_id=$9,basic_salary=$10,updated_at=NOW()
     WHERE id=$11 AND organization_id=$12 RETURNING *`,
    [input.first_name.trim(), input.last_name.trim(), input.work_email?.trim() || null, input.phone?.trim() || null, input.job_title?.trim() || null, input.employment_type || 'Permanent', input.hire_date || '', input.department_id || null, input.manager_employee_id || null, toNumber(input.basic_salary), id, req.user.organization_id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'UPDATE', entityType: 'EMPLOYEE', entityId: id, details: { name: `${input.first_name} ${input.last_name}` } });
  res.json(result.rows[0]);
}));

app.post('/api/employees/:id/archive', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const result = await query('UPDATE employees SET active=FALSE, archived_at=NOW(), updated_at=NOW() WHERE id=$1 AND organization_id=$2 RETURNING *', [id, req.user.organization_id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'ARCHIVE', entityType: 'EMPLOYEE', entityId: id });
  res.json(result.rows[0]);
}));

app.get('/api/leave/types', authenticate, handle(async (req, res) => {
  const result = await query('SELECT * FROM leave_types WHERE organization_id = $1 AND active = TRUE ORDER BY name', [req.user.organization_id]);
  res.json(result.rows);
}));

app.post('/api/leave/types', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ name: z.string().min(2), code: z.string().min(2).max(30), default_days: z.union([z.number(), z.string()]) }).parse(req.body);
  const result = await query('INSERT INTO leave_types (organization_id,name,code,default_days) VALUES ($1,$2,$3,$4) RETURNING *', [req.user.organization_id, input.name.trim(), input.code.trim().toUpperCase(), toNumber(input.default_days)]);
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CREATE', entityType: 'LEAVE_TYPE', entityId: result.rows[0].id, details: { code: input.code } });
  res.status(201).json(result.rows[0]);
}));

app.get('/api/leave/entitlements', authenticate, handle(async (req, res) => {
  const params = [req.user.organization_id, nowYear()];
  let employeeFilter = '';
  if (req.user.role === 'EMPLOYEE') {
    params.push(req.user.employee_id || -1);
    employeeFilter = ` AND le.employee_id = $${params.length}`;
  }
  const result = await query(
    `SELECT le.*, lt.name AS leave_type, lt.code, e.first_name || ' ' || e.last_name AS employee_name,
      (le.entitled_days - le.used_days) AS balance_days
     FROM leave_entitlements le
     JOIN leave_types lt ON lt.id=le.leave_type_id
     JOIN employees e ON e.id=le.employee_id
     WHERE le.organization_id=$1 AND le.entitlement_year=$2 ${employeeFilter}
     ORDER BY employee_name, leave_type`,
    params,
  );
  res.json(result.rows);
}));

app.get('/api/leave/requests', authenticate, handle(async (req, res) => {
  const params = [req.user.organization_id];
  let filter = '';
  if (req.user.role === 'EMPLOYEE') {
    params.push(req.user.employee_id || -1);
    filter = ` AND lr.employee_id = $${params.length}`;
  }
  const result = await query(
    `SELECT lr.*, lt.name AS leave_type, e.first_name || ' ' || e.last_name AS employee_name,
      reviewer.full_name AS reviewer_name
     FROM leave_requests lr
     JOIN leave_types lt ON lt.id=lr.leave_type_id
     JOIN employees e ON e.id=lr.employee_id
     LEFT JOIN users reviewer ON reviewer.id=lr.reviewer_user_id
     WHERE lr.organization_id=$1 ${filter}
     ORDER BY lr.created_at DESC`,
    params,
  );
  res.json(result.rows);
}));

app.post('/api/leave/requests', authenticate, handle(async (req, res) => {
  if (!req.user.employee_id) return res.status(400).json({ error: 'Your account is not linked to an employee profile.' });
  const input = z.object({ leave_type_id: z.number().int(), start_date: z.string().min(10), end_date: z.string().min(10), reason: z.string().max(1000).optional().or(z.literal('')) }).parse(req.body);
  const requestedDays = daysBetweenInclusive(input.start_date, input.end_date);
  if (!requestedDays) return res.status(400).json({ error: 'End date must not be earlier than start date.' });
  const entitlement = await query(
    `SELECT * FROM leave_entitlements WHERE organization_id=$1 AND employee_id=$2 AND leave_type_id=$3 AND entitlement_year=$4`,
    [req.user.organization_id, req.user.employee_id, input.leave_type_id, nowYear()],
  );
  if (entitlement.rows[0] && toNumber(entitlement.rows[0].entitled_days) - toNumber(entitlement.rows[0].used_days) < requestedDays) {
    return res.status(400).json({ error: 'The request exceeds the remaining leave balance.' });
  }
  const result = await query(
    `INSERT INTO leave_requests (organization_id,employee_id,leave_type_id,start_date,end_date,requested_days,reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.organization_id, req.user.employee_id, input.leave_type_id, input.start_date, input.end_date, requestedDays, input.reason?.trim() || null],
  );
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'SUBMIT', entityType: 'LEAVE_REQUEST', entityId: result.rows[0].id, details: { days: requestedDays } });
  res.status(201).json(result.rows[0]);
}));

app.post('/api/leave/requests/:id/:decision', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const decision = req.params.decision === 'approve' ? 'APPROVED' : req.params.decision === 'reject' ? 'REJECTED' : null;
  if (!decision) return res.status(400).json({ error: 'Decision must be approve or reject.' });
  const input = z.object({ remark: z.string().max(1000).optional().or(z.literal('')) }).parse(req.body || {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM leave_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id, req.user.organization_id]);
    const leave = current.rows[0];
    if (!leave) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Leave request not found.' }); }
    if (leave.status !== 'PENDING') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only pending requests can be reviewed.' }); }
    await client.query(
      `UPDATE leave_requests SET status=$1, reviewer_user_id=$2, reviewer_remark=$3, reviewed_at=NOW(), updated_at=NOW() WHERE id=$4`,
      [decision, req.user.id, input.remark?.trim() || null, id],
    );
    if (decision === 'APPROVED') {
      await client.query(
        `UPDATE leave_entitlements SET used_days = used_days + $1, updated_at=NOW()
         WHERE employee_id=$2 AND leave_type_id=$3 AND entitlement_year=$4`,
        [leave.requested_days, leave.employee_id, leave.leave_type_id, nowYear()],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: decision, entityType: 'LEAVE_REQUEST', entityId: id, details: { remark: input.remark || '' } });
  res.json({ success: true, status: decision });
}));

app.get('/api/claims/types', authenticate, handle(async (req, res) => {
  const result = await query('SELECT * FROM claim_types WHERE organization_id=$1 AND active=TRUE ORDER BY name', [req.user.organization_id]);
  res.json(result.rows);
}));

app.get('/api/claims', authenticate, handle(async (req, res) => {
  const params = [req.user.organization_id];
  let filter = '';
  if (req.user.role === 'EMPLOYEE') { params.push(req.user.employee_id || -1); filter = ` AND cr.employee_id=$${params.length}`; }
  const result = await query(
    `SELECT cr.*, ct.name AS claim_type, e.first_name || ' ' || e.last_name AS employee_name, reviewer.full_name AS reviewer_name
     FROM claim_requests cr JOIN claim_types ct ON ct.id=cr.claim_type_id JOIN employees e ON e.id=cr.employee_id
     LEFT JOIN users reviewer ON reviewer.id=cr.reviewer_user_id
     WHERE cr.organization_id=$1 ${filter} ORDER BY cr.created_at DESC`,
    params,
  );
  res.json(result.rows);
}));

app.post('/api/claims', authenticate, handle(async (req, res) => {
  if (!req.user.employee_id) return res.status(400).json({ error: 'Your account is not linked to an employee profile.' });
  const input = z.object({ claim_type_id: z.number().int(), claim_date: z.string().min(10), amount: z.union([z.number(), z.string()]), description: z.string().max(1000).optional().or(z.literal('')), attachment_url: z.string().url().optional().or(z.literal('')) }).parse(req.body);
  const claimType = await query('SELECT * FROM claim_types WHERE id=$1 AND organization_id=$2 AND active=TRUE', [input.claim_type_id, req.user.organization_id]);
  if (!claimType.rows[0]) return res.status(400).json({ error: 'Claim type is not available.' });
  if (claimType.rows[0].requires_attachment && !input.attachment_url) return res.status(400).json({ error: 'This claim type requires an attachment URL.' });
  const result = await query(
    `INSERT INTO claim_requests (organization_id,employee_id,claim_type_id,claim_date,amount,description,attachment_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.organization_id, req.user.employee_id, input.claim_type_id, input.claim_date, toNumber(input.amount), input.description?.trim() || null, input.attachment_url || null],
  );
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'SUBMIT', entityType: 'CLAIM_REQUEST', entityId: result.rows[0].id, details: { amount: input.amount } });
  res.status(201).json(result.rows[0]);
}));

app.post('/api/claims/:id/:decision', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const decision = req.params.decision === 'approve' ? 'APPROVED' : req.params.decision === 'reject' ? 'REJECTED' : null;
  if (!decision) return res.status(400).json({ error: 'Decision must be approve or reject.' });
  const input = z.object({ remark: z.string().max(1000).optional().or(z.literal('')) }).parse(req.body || {});
  const result = await query(
    `UPDATE claim_requests SET status=$1, reviewer_user_id=$2, reviewer_remark=$3, reviewed_at=NOW(), updated_at=NOW()
     WHERE id=$4 AND organization_id=$5 AND status='PENDING' RETURNING *`,
    [decision, req.user.id, input.remark?.trim() || null, id, req.user.organization_id],
  );
  if (!result.rows[0]) return res.status(400).json({ error: 'Only pending claims can be reviewed.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: decision, entityType: 'CLAIM_REQUEST', entityId: id, details: { remark: input.remark || '' } });
  res.json(result.rows[0]);
}));

app.get('/api/attendance', authenticate, handle(async (req, res) => {
  const params = [req.user.organization_id];
  let filter = '';
  if (req.user.role === 'EMPLOYEE') { params.push(req.user.employee_id || -1); filter = ` AND ar.employee_id=$${params.length}`; }
  const result = await query(
    `SELECT ar.*, e.first_name || ' ' || e.last_name AS employee_name
     FROM attendance_records ar JOIN employees e ON e.id=ar.employee_id
     WHERE ar.organization_id=$1 ${filter} ORDER BY ar.work_date DESC, ar.created_at DESC LIMIT 100`,
    params,
  );
  res.json(result.rows);
}));

app.post('/api/attendance/clock-in', authenticate, handle(async (req, res) => {
  if (!req.user.employee_id) return res.status(400).json({ error: 'Your account is not linked to an employee profile.' });
  const today = dateOnly();
  const existing = await query('SELECT * FROM attendance_records WHERE employee_id=$1 AND work_date=$2', [req.user.employee_id, today]);
  if (existing.rows[0]?.clock_in_at) return res.status(400).json({ error: 'You have already clocked in today.' });
  const result = await query(
    `INSERT INTO attendance_records (organization_id,employee_id,work_date,clock_in_at,source)
     VALUES ($1,$2,$3,NOW(),'WEB')
     ON CONFLICT (employee_id,work_date) DO UPDATE SET clock_in_at=NOW(), updated_at=NOW()
     RETURNING *`,
    [req.user.organization_id, req.user.employee_id, today],
  );
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CLOCK_IN', entityType: 'ATTENDANCE', entityId: result.rows[0].id });
  res.json(result.rows[0]);
}));

app.post('/api/attendance/clock-out', authenticate, handle(async (req, res) => {
  if (!req.user.employee_id) return res.status(400).json({ error: 'Your account is not linked to an employee profile.' });
  const today = dateOnly();
  const result = await query(
    `UPDATE attendance_records
     SET clock_out_at=NOW(), work_minutes=GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - clock_in_at))/60)::int), updated_at=NOW()
     WHERE employee_id=$1 AND work_date=$2 AND clock_in_at IS NOT NULL AND clock_out_at IS NULL
     RETURNING *`,
    [req.user.employee_id, today],
  );
  if (!result.rows[0]) return res.status(400).json({ error: 'No open attendance record was found for today.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CLOCK_OUT', entityType: 'ATTENDANCE', entityId: result.rows[0].id });
  res.json(result.rows[0]);
}));

app.get('/api/payroll/runs', authenticate, handle(async (req, res) => {
  const result = await query(
    `SELECT pr.*, COUNT(ps.id)::int AS payslip_count, COALESCE(SUM(ps.net_salary),0) AS total_net
     FROM payroll_runs pr LEFT JOIN payslips ps ON ps.payroll_run_id=pr.id
     WHERE pr.organization_id=$1 GROUP BY pr.id ORDER BY pr.period_end DESC`,
    [req.user.organization_id],
  );
  res.json(result.rows);
}));

app.get('/api/payroll/payslips', authenticate, handle(async (req, res) => {
  const params = [req.user.organization_id];
  let filter = '';
  if (req.user.role === 'EMPLOYEE') { params.push(req.user.employee_id || -1); filter = ` AND ps.employee_id=$${params.length}`; }
  const result = await query(
    `SELECT ps.*, pr.title, pr.period_start, pr.period_end, pr.status AS payroll_status,
      e.first_name || ' ' || e.last_name AS employee_name
     FROM payslips ps JOIN payroll_runs pr ON pr.id=ps.payroll_run_id JOIN employees e ON e.id=ps.employee_id
     WHERE pr.organization_id=$1 ${filter} ORDER BY pr.period_end DESC, employee_name`,
    params,
  );
  res.json(result.rows);
}));

app.post('/api/payroll/runs', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ title: z.string().min(3).max(180), period_start: z.string().min(10), period_end: z.string().min(10) }).parse(req.body);
  if (!daysBetweenInclusive(input.period_start, input.period_end)) return res.status(400).json({ error: 'Payroll period is invalid.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `INSERT INTO payroll_runs (organization_id,title,period_start,period_end,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.organization_id, input.title.trim(), input.period_start, input.period_end, req.user.id],
    );
    const employees = await client.query('SELECT id,basic_salary FROM employees WHERE organization_id=$1 AND active=TRUE', [req.user.organization_id]);
    for (const employee of employees.rows) {
      const basicSalary = toNumber(employee.basic_salary);
      await client.query(
        `INSERT INTO payslips (payroll_run_id,employee_id,basic_salary,allowances,deductions,net_salary)
         VALUES ($1,$2,$3,0,0,$3)`,
        [run.rows[0].id, employee.id, basicSalary],
      );
    }
    await client.query('COMMIT');
    await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CREATE', entityType: 'PAYROLL_RUN', entityId: run.rows[0].id, details: { title: input.title } });
    res.status(201).json(run.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(400).json({ error: 'A payroll run already exists for this period.' });
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/payroll/runs/:id/publish', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const result = await query(
    `UPDATE payroll_runs SET status='PUBLISHED', published_at=NOW() WHERE id=$1 AND organization_id=$2 AND status='DRAFT' RETURNING *`,
    [id, req.user.organization_id],
  );
  if (!result.rows[0]) return res.status(400).json({ error: 'Only draft payroll runs can be published.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'PUBLISH', entityType: 'PAYROLL_RUN', entityId: id });
  res.json(result.rows[0]);
}));

app.get('/api/documents', authenticate, handle(async (req, res) => {
  const params = [req.user.organization_id];
  let filter = '';
  if (req.user.role === 'EMPLOYEE') { params.push(req.user.employee_id || -1); filter = ` AND (d.employee_id=$${params.length} OR (d.employee_id IS NULL AND d.visible_to_employee=TRUE))`; }
  const result = await query(
    `SELECT d.*, e.first_name || ' ' || e.last_name AS employee_name, u.full_name AS uploaded_by_name
     FROM documents d LEFT JOIN employees e ON e.id=d.employee_id LEFT JOIN users u ON u.id=d.uploaded_by_user_id
     WHERE d.organization_id=$1 ${filter} ORDER BY d.created_at DESC`,
    params,
  );
  res.json(result.rows);
}));

app.post('/api/documents', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const input = z.object({ title: z.string().min(2).max(220), category: z.string().min(2).max(100), document_url: z.string().url().optional().or(z.literal('')), employee_id: z.number().int().nullable().optional(), visible_to_employee: z.boolean().optional() }).parse(req.body);
  const result = await query(
    `INSERT INTO documents (organization_id,employee_id,title,category,document_url,visible_to_employee,uploaded_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.organization_id, input.employee_id || null, input.title.trim(), input.category.trim(), input.document_url || null, input.visible_to_employee !== false, req.user.id],
  );
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CREATE', entityType: 'DOCUMENT', entityId: result.rows[0].id, details: { title: input.title } });
  res.status(201).json(result.rows[0]);
}));

app.get('/api/audit-logs', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const result = await query(
    `SELECT al.*, u.full_name AS actor_name FROM audit_logs al LEFT JOIN users u ON u.id=al.actor_user_id
     WHERE al.organization_id=$1 ORDER BY al.created_at DESC LIMIT 200`,
    [req.user.organization_id],
  );
  res.json(result.rows);
}));

app.get('/api/settings', authenticate, handle(async (req, res) => {
  const result = await query('SELECT * FROM organizations WHERE id=$1', [req.user.organization_id]);
  res.json(result.rows[0]);
}));

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res) => {
    if (req.method === 'GET') return res.sendFile(path.join(webDist, 'index.html'));
    return res.status(404).json({ error: 'Route not found.' });
  });
}

async function start() {
  let retries = 20;
  while (retries > 0) {
    try {
      await initializeDatabase();
      break;
    } catch (error) {
      retries -= 1;
      if (retries === 0) throw error;
      console.log(`Waiting for database (${retries} attempts remaining)...`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  app.listen(PORT, () => console.log(`Custera HRIS API running on http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error('Unable to start Custera HRIS:', error);
  process.exit(1);
});
