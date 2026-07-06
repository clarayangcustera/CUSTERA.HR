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

function sumSalaryComponents(items) {
  return asArray(items).reduce((total, item) => total + toNumber(item?.amount), 0);
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
    `SELECT u.id, u.organization_id, u.email, u.full_name, u.role, u.active, u.custom_role_id, u.hr_role_id, u.invitation_status,
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
  await ensurePlatformDefaults();
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


function asObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function employeeAccessible(req, employeeId) {
  return req.user.role !== 'EMPLOYEE' || Number(req.user.employee_id) === Number(employeeId);
}

async function requireEmployeeAccess(req, res, employeeId) {
  if (!employeeAccessible(req, employeeId)) {
    res.status(403).json({ error: 'You may only access your own employee profile.' });
    return false;
  }
  return true;
}

const profileSections = ['personal', 'job', 'salary', 'family', 'contact', 'health', 'directory', 'others', 'custom_values'];
const validRecordTypes = ['PLACEMENT', 'EMPLOYMENT_TERM', 'EDUCATION', 'EXPERIENCE', 'TRAINING', 'LEGAL_DOCUMENT'];
const validOptionTypes = ['JOB_POSITION', 'BRANCH', 'LEVEL', 'BANK', 'ETHNICITY', 'RELIGION', 'PAYMENT_METHOD', 'JOB_TYPE', 'MARITAL_STATUS', 'RELATIONSHIP', 'BLOOD_TYPE'];
const validWorkflowModules = ['LEAVE', 'CLAIM', 'DOCUMENT'];
const validPermissionLevels = ['NONE', 'VIEW', 'MODIFY'];

async function ensureProfile(employeeId, organizationId) {
  await query(
    `INSERT INTO employee_profiles (employee_id, organization_id)
     VALUES ($1, $2) ON CONFLICT (employee_id) DO NOTHING`,
    [employeeId, organizationId],
  );
}

async function ensurePlatformDefaults() {
  const organizations = await query('SELECT id FROM organizations');
  const referenceSeed = [
    ['JOB_POSITION', 'HR_EXEC', 'HR Executive'], ['JOB_POSITION', 'ENGINEER', 'Project Engineer'], ['JOB_POSITION', 'OPS_MANAGER', 'Operations Manager'],
    ['BRANCH', 'SG_HQ', 'Singapore HQ'], ['LEVEL', 'EXEC', 'Executive'], ['LEVEL', 'MANAGER', 'Manager'], ['LEVEL', 'DIRECTOR', 'Director'],
    ['BANK', 'DBS', 'DBS / POSB'], ['BANK', 'UOB', 'UOB'], ['BANK', 'OCBC', 'OCBC'],
    ['ETHNICITY', 'CHINESE', 'Chinese'], ['ETHNICITY', 'MALAY', 'Malay'], ['ETHNICITY', 'INDIAN', 'Indian'], ['ETHNICITY', 'OTHER', 'Others'],
    ['RELIGION', 'BUDDHISM', 'Buddhism'], ['RELIGION', 'CHRISTIANITY', 'Christianity'], ['RELIGION', 'ISLAM', 'Islam'], ['RELIGION', 'NONE', 'No religion'],
    ['PAYMENT_METHOD', 'BANK_TRANSFER', 'Bank Transfer'], ['PAYMENT_METHOD', 'CASH', 'Cash'],
    ['JOB_TYPE', 'PERMANENT', 'Permanent'], ['JOB_TYPE', 'CONTRACT', 'Contract'], ['JOB_TYPE', 'TEMPORARY', 'Temporary'],
    ['MARITAL_STATUS', 'SINGLE', 'Single'], ['MARITAL_STATUS', 'MARRIED', 'Married'], ['MARITAL_STATUS', 'DIVORCED', 'Divorced'],
    ['RELATIONSHIP', 'PARENT', 'Parent'], ['RELATIONSHIP', 'SPOUSE', 'Spouse'], ['RELATIONSHIP', 'SIBLING', 'Sibling'], ['RELATIONSHIP', 'FRIEND', 'Friend'],
    ['BLOOD_TYPE', 'A_POSITIVE', 'A+'], ['BLOOD_TYPE', 'B_POSITIVE', 'B+'], ['BLOOD_TYPE', 'O_POSITIVE', 'O+'], ['BLOOD_TYPE', 'AB_POSITIVE', 'AB+'],
    ['INCIDENT_CATEGORY', 'SAFETY', 'Safety'], ['INCIDENT_CATEGORY', 'DISCIPLINARY', 'Disciplinary'], ['INCIDENT_CATEGORY', 'QUALITY', 'Quality'],
    ['INCIDENT_TYPE', 'NEAR_MISS', 'Near miss'], ['INCIDENT_TYPE', 'MISCONDUCT', 'Misconduct'], ['INCIDENT_TYPE', 'INJURY', 'Injury'],
    ['INCIDENT_DECISION', 'COUNSELLING', 'Counselling'], ['INCIDENT_DECISION', 'WARNING', 'Written warning'], ['INCIDENT_DECISION', 'CLOSED', 'No further action'],
  ];
  const permissionModules = ['EMPLOYEE_MANAGEMENT', 'EMPLOYEE_REQUEST', 'PLACEMENT', 'EMPLOYMENT_TERMS', 'EDUCATION', 'EXPERIENCE', 'TRAINING', 'LEGAL_DOCUMENT', 'CUSTOM_ROLE', 'WEB_ACCOUNT', 'HR_ROLE', 'EXPENSE_CLAIM', 'LEAVE', 'ATTENDANCE', 'DOCUMENT_WORKFLOW', 'INCIDENT'];

  for (const org of organizations.rows) {
    for (const [optionType, code, label] of referenceSeed) {
      await query(
        `INSERT INTO reference_options (organization_id, option_type, code, label)
         VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id, option_type, label) DO NOTHING`,
        [org.id, optionType, code, label],
      );
    }
    await query(
      `INSERT INTO workday_profiles (organization_id, name, workdays, start_time, end_time)
       VALUES ($1, 'DEFAULT', '["MON","TUE","WED","THU","FRI"]'::jsonb, '09:00', '18:00')
       ON CONFLICT (organization_id, name) DO NOTHING`, [org.id],
    );
    for (const [moduleKey, workflowName] of [['LEAVE', 'DEFAULT'], ['CLAIM', 'DEFAULT'], ['DOCUMENT', 'DEFAULT']]) {
      await query(
        `INSERT INTO approval_workflows (organization_id, module_key, workflow_name, steps)
         VALUES ($1,$2,$3,'[{"step":1,"approver":"Line Manager"}]'::jsonb)
         ON CONFLICT (organization_id, module_key, workflow_name) DO NOTHING`, [org.id, moduleKey, workflowName],
      );
    }
    for (const [code, description] of [['HR_ADMIN', 'Full HR configuration and workflow access'], ['HR_MANAGER', 'People management and review access']]) {
      const role = await query(
        `INSERT INTO hr_roles (organization_id, code, description) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, code) DO UPDATE SET description = EXCLUDED.description
         RETURNING id`, [org.id, code, description],
      );
      for (const moduleKey of permissionModules) {
        await query(
          `INSERT INTO hr_role_permissions (hr_role_id, module_key, permission_level)
           VALUES ($1,$2,$3) ON CONFLICT (hr_role_id, module_key) DO NOTHING`,
          [role.rows[0].id, moduleKey, code === 'HR_ADMIN' ? 'MODIFY' : (moduleKey === 'HR_ROLE' ? 'VIEW' : 'MODIFY')],
        );
      }
    }
    await query(
      `INSERT INTO claim_categories (organization_id, name, code) VALUES
       ($1,'Business Travel','TRAVEL'),($1,'Staff Welfare','WELFARE'),($1,'Medical','MEDICAL')
       ON CONFLICT (organization_id, code) DO NOTHING`, [org.id],
    );
    await query(
      `INSERT INTO employee_profiles (employee_id, organization_id)
       SELECT e.id, e.organization_id FROM employees e
       WHERE e.organization_id=$1 ON CONFLICT (employee_id) DO NOTHING`, [org.id],
    );
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
  const result = await query(`SELECT ct.*, cc.name AS category_name FROM claim_types ct LEFT JOIN claim_categories cc ON cc.id=ct.category_id WHERE ct.organization_id=$1 AND ct.active=TRUE ORDER BY ct.name`, [req.user.organization_id]);
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
  if (req.user.role === 'EMPLOYEE') { params.push(req.user.employee_id || -1); filter = ` AND ps.employee_id=$${params.length} AND pr.status='PUBLISHED'`; }
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
    const employees = await client.query(
      `SELECT e.id,e.basic_salary,ep.salary
       FROM employees e LEFT JOIN employee_profiles ep ON ep.employee_id=e.id
       WHERE e.organization_id=$1 AND e.active=TRUE`,
      [req.user.organization_id],
    );
    for (const employee of employees.rows) {
      const salary = asObject(employee.salary);
      const basicSalary = toNumber(employee.basic_salary);
      const allowances = sumSalaryComponents(salary.earnings) + sumSalaryComponents(salary.bonus);
      const deductions = sumSalaryComponents(salary.deductions) + sumSalaryComponents(salary.statutory_contributions);
      const netSalary = Math.max(0, basicSalary + allowances - deductions);
      await client.query(
        `INSERT INTO payslips (payroll_run_id,employee_id,basic_salary,allowances,deductions,net_salary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [run.rows[0].id, employee.id, basicSalary, allowances, deductions, netSalary],
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


// --- Resource-aligned Employee Centre --------------------------------------
app.get('/api/employees/:id/profile', authenticate, handle(async (req, res) => {
  const employeeId = Number(req.params.id);
  if (!Number.isInteger(employeeId) || !(await requireEmployeeAccess(req, res, employeeId))) return;
  const result = await query(
    `SELECT e.*, d.name AS department_name,
            m.first_name || ' ' || m.last_name AS manager_name,
            u.id AS account_user_id, u.email AS account_email, u.active AS account_active,
            u.role AS account_role, u.invitation_status, u.custom_role_id, u.hr_role_id,
            ep.personal, ep.job, ep.salary, ep.family, ep.contact, ep.health, ep.directory, ep.others, ep.custom_values
     FROM employees e
     LEFT JOIN departments d ON d.id=e.department_id
     LEFT JOIN employees m ON m.id=e.manager_employee_id
     LEFT JOIN users u ON u.id=e.user_id
     LEFT JOIN employee_profiles ep ON ep.employee_id=e.id
     WHERE e.id=$1 AND e.organization_id=$2`,
    [employeeId, req.user.organization_id],
  );
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: 'Employee not found.' });
  await ensureProfile(employeeId, req.user.organization_id);
  const profile = {};
  for (const section of profileSections) profile[section] = asObject(row[section]);
  res.json({ employee: row, profile });
}));

app.put('/api/employees/:id/profile', authenticate, handle(async (req, res) => {
  const employeeId = Number(req.params.id);
  if (!Number.isInteger(employeeId) || !(await requireEmployeeAccess(req, res, employeeId))) return;
  if (req.user.role === 'EMPLOYEE' && !req.user.employee_id) return res.status(403).json({ error: 'Your account is not linked to an employee record.' });
  const input = z.object({
    core: z.object({
      employee_code: z.string().min(2).max(40).optional(), first_name: z.string().min(1).max(100).optional(), middle_name: z.string().max(100).optional().or(z.literal('')), last_name: z.string().min(1).max(100).optional(),
      work_email: z.string().email().optional().or(z.literal('')), phone: z.string().max(60).optional().or(z.literal('')), job_title: z.string().max(160).optional().or(z.literal('')),
      employment_type: z.string().max(60).optional().or(z.literal('')), hire_date: z.string().optional().or(z.literal('')), department_id: z.union([z.number().int(), z.string(), z.null()]).optional(),
      manager_employee_id: z.union([z.number().int(), z.string(), z.null()]).optional(), basic_salary: z.union([z.number(), z.string()]).optional(),
      photo_url: z.string().url().optional().or(z.literal('')), national_id: z.string().max(80).optional().or(z.literal('')), passport_number: z.string().max(80).optional().or(z.literal('')),
      birth_date: z.string().optional().or(z.literal('')), nationality: z.string().max(100).optional().or(z.literal('')), gender: z.string().max(30).optional().or(z.literal('')),
      allow_self_profile_update: z.boolean().optional(),
    }).partial().optional(),
    profile: z.object({
      personal: z.record(z.any()).optional(), job: z.record(z.any()).optional(), salary: z.record(z.any()).optional(), family: z.record(z.any()).optional(),
      contact: z.record(z.any()).optional(), health: z.record(z.any()).optional(), directory: z.record(z.any()).optional(), others: z.record(z.any()).optional(), custom_values: z.record(z.any()).optional(),
    }).partial().optional(),
  }).parse(req.body || {});

  const exists = await query('SELECT * FROM employees WHERE id=$1 AND organization_id=$2', [employeeId, req.user.organization_id]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  if (req.user.role === 'EMPLOYEE' && !exists.rows[0].allow_self_profile_update) {
    // Employees may always update contact and health information; manager-controlled fields remain protected.
    const supplied = Object.keys(input.profile || {});
    if (input.core || supplied.some((key) => !['contact', 'health', 'personal', 'custom_values'].includes(key))) {
      return res.status(403).json({ error: 'Profile updates are not currently enabled for this employee.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let employee = exists.rows[0];
    if (input.core && Object.keys(input.core).length) {
      const core = { ...employee, ...input.core };
      const update = await client.query(
        `UPDATE employees SET employee_code=$1, first_name=$2, middle_name=$3, last_name=$4, work_email=$5, phone=$6, job_title=$7,
          employment_type=$8, hire_date=NULLIF($9,'')::date, department_id=$10, manager_employee_id=$11, basic_salary=$12,
          photo_url=$13, national_id=$14, passport_number=$15, birth_date=NULLIF($16,'')::date, nationality=$17, gender=$18,
          allow_self_profile_update=$19, updated_at=NOW()
         WHERE id=$20 AND organization_id=$21 RETURNING *`,
        [
          String(core.employee_code || '').trim(), String(core.first_name || '').trim(), String(core.middle_name || '').trim() || null, String(core.last_name || '').trim(),
          String(core.work_email || '').trim() || null, String(core.phone || '').trim() || null, String(core.job_title || '').trim() || null,
          String(core.employment_type || 'Permanent').trim(), core.hire_date || '', Number(core.department_id) || null, Number(core.manager_employee_id) || null, toNumber(core.basic_salary),
          String(core.photo_url || '').trim() || null, String(core.national_id || '').trim() || null, String(core.passport_number || '').trim() || null, core.birth_date || '',
          String(core.nationality || '').trim() || null, String(core.gender || '').trim() || null, Boolean(core.allow_self_profile_update), employeeId, req.user.organization_id,
        ],
      );
      employee = update.rows[0];
    }
    await client.query(`INSERT INTO employee_profiles (employee_id, organization_id) VALUES ($1,$2) ON CONFLICT (employee_id) DO NOTHING`, [employeeId, req.user.organization_id]);
    if (input.profile && Object.keys(input.profile).length) {
      const existing = await client.query('SELECT * FROM employee_profiles WHERE employee_id=$1 FOR UPDATE', [employeeId]);
      const current = existing.rows[0] || {};
      const merged = {};
      for (const section of profileSections) merged[section] = input.profile?.[section] !== undefined ? asObject(input.profile[section]) : asObject(current[section]);
      await client.query(
        `UPDATE employee_profiles SET personal=$1::jsonb, job=$2::jsonb, salary=$3::jsonb, family=$4::jsonb, contact=$5::jsonb,
          health=$6::jsonb, directory=$7::jsonb, others=$8::jsonb, custom_values=$9::jsonb, updated_at=NOW() WHERE employee_id=$10`,
        [JSON.stringify(merged.personal), JSON.stringify(merged.job), JSON.stringify(merged.salary), JSON.stringify(merged.family), JSON.stringify(merged.contact), JSON.stringify(merged.health), JSON.stringify(merged.directory), JSON.stringify(merged.others), JSON.stringify(merged.custom_values), employeeId],
      );
    }
    await client.query('COMMIT');
    await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'UPDATE_PROFILE', entityType: 'EMPLOYEE', entityId: employeeId });
    res.json({ employee });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(400).json({ error: 'Employee code or email is already in use.' });
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/employees/:id/records', authenticate, handle(async (req, res) => {
  const employeeId = Number(req.params.id);
  if (!Number.isInteger(employeeId) || !(await requireEmployeeAccess(req, res, employeeId))) return;
  const recordType = String(req.query.type || '').toUpperCase();
  if (recordType && !validRecordTypes.includes(recordType)) return res.status(400).json({ error: 'Unsupported record type.' });
  const params = [req.user.organization_id, employeeId];
  const filter = recordType ? ` AND er.record_type=$3` : '';
  if (recordType) params.push(recordType);
  const records = await query(
    `SELECT er.*, u.full_name AS created_by_name FROM employee_records er LEFT JOIN users u ON u.id=er.created_by_user_id
     WHERE er.organization_id=$1 AND er.employee_id=$2 ${filter} ORDER BY er.effective_date DESC NULLS LAST, er.created_at DESC`, params,
  );
  res.json(records.rows.map((record) => ({ ...record, details: asObject(record.details) })));
}));

app.get('/api/employee-records', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const recordType = String(req.query.type || '').toUpperCase();
  if (recordType && !validRecordTypes.includes(recordType)) return res.status(400).json({ error: 'Unsupported record type.' });
  const params = [req.user.organization_id];
  const filter = recordType ? ' AND er.record_type=$2' : '';
  if (recordType) params.push(recordType);
  const records = await query(
    `SELECT er.*, e.employee_code, e.first_name || ' ' || e.last_name AS employee_name
     FROM employee_records er JOIN employees e ON e.id=er.employee_id
     WHERE er.organization_id=$1 ${filter} ORDER BY er.effective_date DESC NULLS LAST, er.created_at DESC`, params,
  );
  res.json(records.rows.map((record) => ({ ...record, details: asObject(record.details) })));
}));

app.post('/api/employees/:id/records', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const employeeId = Number(req.params.id);
  const input = z.object({ record_type: z.enum(validRecordTypes), title: z.string().min(2).max(220), effective_date: z.string().optional().or(z.literal('')), end_date: z.string().optional().or(z.literal('')), details: z.record(z.any()).optional() }).parse(req.body);
  const result = await query(
    `INSERT INTO employee_records (organization_id,employee_id,record_type,title,effective_date,end_date,details,created_by_user_id)
     SELECT $1,$2,$3,$4,NULLIF($5,'')::date,NULLIF($6,'')::date,$7::jsonb,$8 WHERE EXISTS (SELECT 1 FROM employees WHERE id=$2 AND organization_id=$1)
     RETURNING *`,
    [req.user.organization_id, employeeId, input.record_type, input.title.trim(), input.effective_date || '', input.end_date || '', JSON.stringify(asObject(input.details)), req.user.id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CREATE', entityType: input.record_type, entityId: result.rows[0].id, details: { employee_id: employeeId, title: input.title } });
  res.status(201).json({ ...result.rows[0], details: asObject(result.rows[0].details) });
}));

app.patch('/api/employee-records/:id', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ title: z.string().min(2).max(220), effective_date: z.string().optional().or(z.literal('')), end_date: z.string().optional().or(z.literal('')), details: z.record(z.any()).optional() }).parse(req.body);
  const result = await query(
    `UPDATE employee_records SET title=$1,effective_date=NULLIF($2,'')::date,end_date=NULLIF($3,'')::date,details=$4::jsonb,updated_at=NOW()
     WHERE id=$5 AND organization_id=$6 RETURNING *`,
    [input.title.trim(), input.effective_date || '', input.end_date || '', JSON.stringify(asObject(input.details)), id, req.user.organization_id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Record not found.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'UPDATE', entityType: result.rows[0].record_type, entityId: id });
  res.json({ ...result.rows[0], details: asObject(result.rows[0].details) });
}));

app.delete('/api/employee-records/:id', authenticate, requireRole('ADMIN', 'MANAGER'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const result = await query('DELETE FROM employee_records WHERE id=$1 AND organization_id=$2 RETURNING *', [id, req.user.organization_id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Record not found.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'DELETE', entityType: result.rows[0].record_type, entityId: id });
  res.json({ success: true });
}));

app.get('/api/custom-fields', authenticate, handle(async (req, res) => {
  const section = String(req.query.section || '').toUpperCase();
  const params = [req.user.organization_id];
  const filter = section ? ' AND section_key=$2' : '';
  if (section) params.push(section);
  const result = await query(`SELECT * FROM custom_fields WHERE organization_id=$1 AND active=TRUE ${filter} ORDER BY section_key, sort_order, id`, params);
  res.json(result.rows.map((field) => ({ ...field, options: asArray(field.options) })));
}));

app.post('/api/custom-fields', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ section_key: z.string().max(40).optional().or(z.literal('')), label: z.string().min(2).max(160), field_type: z.enum(['SHORT_TEXT','MULTI_LINE_TEXT','YES_NO','DROPDOWN','DATE']), options: z.array(z.string().max(120)).optional(), is_required: z.boolean().optional(), sort_order: z.union([z.number(), z.string()]).optional() }).parse(req.body);
  if (input.field_type === 'DROPDOWN' && (!input.options || input.options.length === 0)) return res.status(400).json({ error: 'A dropdown field requires at least one option.' });
  const result = await query(
    `INSERT INTO custom_fields (organization_id,section_key,label,field_type,options,is_required,sort_order)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
    [req.user.organization_id, (input.section_key || 'CUSTOM').toUpperCase(), input.label.trim(), input.field_type, JSON.stringify(input.options || []), Boolean(input.is_required), Number(input.sort_order) || 0],
  );
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CREATE', entityType: 'CUSTOM_FIELD', entityId: result.rows[0].id, details: { label: input.label } });
  res.status(201).json({ ...result.rows[0], options: asArray(result.rows[0].options) });
}));

app.patch('/api/custom-fields/:id', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ label: z.string().min(2).max(160), options: z.array(z.string().max(120)).optional(), is_required: z.boolean().optional(), active: z.boolean().optional(), sort_order: z.union([z.number(), z.string()]).optional() }).parse(req.body);
  const result = await query(
    `UPDATE custom_fields SET label=$1,options=$2::jsonb,is_required=$3,active=$4,sort_order=$5,updated_at=NOW()
     WHERE id=$6 AND organization_id=$7 RETURNING *`,
    [input.label.trim(), JSON.stringify(input.options || []), Boolean(input.is_required), input.active !== false, Number(input.sort_order) || 0, id, req.user.organization_id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Custom field not found.' });
  res.json({ ...result.rows[0], options: asArray(result.rows[0].options) });
}));

app.delete('/api/custom-fields/:id', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const result = await query('UPDATE custom_fields SET active=FALSE,updated_at=NOW() WHERE id=$1 AND organization_id=$2 RETURNING id', [id, req.user.organization_id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Custom field not found.' });
  res.json({ success: true });
}));

app.get('/api/reference-options', authenticate, handle(async (req, res) => {
  const optionType = String(req.query.type || '').toUpperCase();
  if (optionType && !validOptionTypes.includes(optionType)) return res.status(400).json({ error: 'Unsupported reference list.' });
  const params = [req.user.organization_id];
  const filter = optionType ? ' AND option_type=$2' : '';
  if (optionType) params.push(optionType);
  const result = await query(`SELECT * FROM reference_options WHERE organization_id=$1 AND active=TRUE ${filter} ORDER BY option_type,label`, params);
  res.json(result.rows.map((item) => ({ ...item, metadata: asObject(item.metadata) })));
}));

app.post('/api/reference-options', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ option_type: z.enum(validOptionTypes), code: z.string().max(50).optional().or(z.literal('')), label: z.string().min(2).max(160), metadata: z.record(z.any()).optional() }).parse(req.body);
  const result = await query(
    `INSERT INTO reference_options (organization_id,option_type,code,label,metadata) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
    [req.user.organization_id, input.option_type, input.code?.trim() || null, input.label.trim(), JSON.stringify(asObject(input.metadata))],
  );
  res.status(201).json({ ...result.rows[0], metadata: asObject(result.rows[0].metadata) });
}));

app.patch('/api/reference-options/:id', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ code: z.string().max(50).optional().or(z.literal('')), label: z.string().min(2).max(160), active: z.boolean().optional(), metadata: z.record(z.any()).optional() }).parse(req.body);
  const result = await query(
    `UPDATE reference_options SET code=$1,label=$2,active=$3,metadata=$4::jsonb,updated_at=NOW() WHERE id=$5 AND organization_id=$6 RETURNING *`,
    [input.code?.trim() || null, input.label.trim(), input.active !== false, JSON.stringify(asObject(input.metadata)), id, req.user.organization_id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Reference option not found.' });
  res.json({ ...result.rows[0], metadata: asObject(result.rows[0].metadata) });
}));

app.delete('/api/reference-options/:id', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const result = await query('UPDATE reference_options SET active=FALSE,updated_at=NOW() WHERE id=$1 AND organization_id=$2 RETURNING id', [id, req.user.organization_id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Reference option not found.' });
  res.json({ success: true });
}));


// --- Access, custom roles, web accounts and HR permission matrix ------------
app.get('/api/custom-roles', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const result = await query(
    `SELECT cr.*, e.first_name || ' ' || e.last_name AS employee_name
     FROM custom_roles cr LEFT JOIN employees e ON e.id=cr.employee_id
     WHERE cr.organization_id=$1 ORDER BY cr.active DESC, cr.role_name`, [req.user.organization_id],
  );
  res.json(result.rows.map((role) => ({ ...role, modules: asObject(role.modules) })));
}));

app.post('/api/custom-roles', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ code: z.string().min(2).max(50), role_name: z.string().min(2).max(160), employee_id: z.union([z.number().int(), z.null()]).optional(), modules: z.record(z.any()).optional(), active: z.boolean().optional() }).parse(req.body);
  const result = await query(
    `INSERT INTO custom_roles (organization_id,code,role_name,employee_id,modules,active) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
    [req.user.organization_id, input.code.trim().toUpperCase(), input.role_name.trim(), input.employee_id || null, JSON.stringify(asObject(input.modules)), input.active !== false],
  );
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'CREATE', entityType: 'CUSTOM_ROLE', entityId: result.rows[0].id, details: { code: input.code } });
  res.status(201).json({ ...result.rows[0], modules: asObject(result.rows[0].modules) });
}));

app.patch('/api/custom-roles/:id', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ code: z.string().min(2).max(50), role_name: z.string().min(2).max(160), employee_id: z.union([z.number().int(), z.null()]).optional(), modules: z.record(z.any()).optional(), active: z.boolean().optional() }).parse(req.body);
  const result = await query(
    `UPDATE custom_roles SET code=$1,role_name=$2,employee_id=$3,modules=$4::jsonb,active=$5,updated_at=NOW()
     WHERE id=$6 AND organization_id=$7 RETURNING *`,
    [input.code.trim().toUpperCase(), input.role_name.trim(), input.employee_id || null, JSON.stringify(asObject(input.modules)), input.active !== false, id, req.user.organization_id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Custom role not found.' });
  res.json({ ...result.rows[0], modules: asObject(result.rows[0].modules) });
}));

app.get('/api/hr-roles', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const roles = await query('SELECT * FROM hr_roles WHERE organization_id=$1 ORDER BY active DESC, code', [req.user.organization_id]);
  const ids = roles.rows.map((role) => role.id);
  let permissionRows = [];
  if (ids.length) permissionRows = (await query('SELECT * FROM hr_role_permissions WHERE hr_role_id = ANY($1::int[]) ORDER BY module_key', [ids])).rows;
  res.json(roles.rows.map((role) => ({ ...role, permissions: permissionRows.filter((item) => item.hr_role_id === role.id) })));
}));

app.post('/api/hr-roles', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ code: z.string().min(2).max(50), description: z.string().min(2).max(220), active: z.boolean().optional(), permissions: z.record(z.enum(validPermissionLevels)).optional() }).parse(req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query(
      `INSERT INTO hr_roles (organization_id,code,description,active) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.organization_id, input.code.trim().toUpperCase(), input.description.trim(), input.active !== false],
    );
    for (const [moduleKey, permissionLevel] of Object.entries(input.permissions || {})) {
      await client.query(`INSERT INTO hr_role_permissions (hr_role_id,module_key,permission_level) VALUES ($1,$2,$3)`, [role.rows[0].id, moduleKey, permissionLevel]);
    }
    await client.query('COMMIT');
    res.status(201).json(role.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(400).json({ error: 'An HR role with this code already exists.' });
    throw error;
  } finally { client.release(); }
}));

app.put('/api/hr-roles/:id', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ code: z.string().min(2).max(50), description: z.string().min(2).max(220), active: z.boolean().optional(), permissions: z.record(z.enum(validPermissionLevels)).optional() }).parse(req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query(`UPDATE hr_roles SET code=$1,description=$2,active=$3,updated_at=NOW() WHERE id=$4 AND organization_id=$5 RETURNING *`, [input.code.trim().toUpperCase(), input.description.trim(), input.active !== false, id, req.user.organization_id]);
    if (!role.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'HR role not found.' }); }
    await client.query('DELETE FROM hr_role_permissions WHERE hr_role_id=$1', [id]);
    for (const [moduleKey, permissionLevel] of Object.entries(input.permissions || {})) {
      await client.query(`INSERT INTO hr_role_permissions (hr_role_id,module_key,permission_level) VALUES ($1,$2,$3)`, [id, moduleKey, permissionLevel]);
    }
    await client.query('COMMIT');
    await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'UPDATE', entityType: 'HR_ROLE', entityId: id });
    res.json(role.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.get('/api/web-accounts', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const result = await query(
    `SELECT e.id AS employee_id,e.employee_code,e.first_name || ' ' || e.last_name AS employee_name,e.work_email,
      u.id AS user_id,u.email,u.role,u.active,u.invitation_status,u.must_change_password,
      hr.code AS hr_role_code,cr.role_name AS custom_role_name
     FROM employees e LEFT JOIN users u ON u.id=e.user_id
     LEFT JOIN hr_roles hr ON hr.id=u.hr_role_id LEFT JOIN custom_roles cr ON cr.id=u.custom_role_id
     WHERE e.organization_id=$1 ORDER BY e.first_name,e.last_name`, [req.user.organization_id],
  );
  res.json(result.rows);
}));

app.post('/api/employees/:id/web-account', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const employeeId = Number(req.params.id);
  const input = z.object({ email: z.string().email(), temporary_password: z.string().min(10).max(128), system_role: z.enum(['ADMIN','MANAGER','EMPLOYEE']).optional(), hr_role_id: z.union([z.number().int(), z.null()]).optional(), custom_role_id: z.union([z.number().int(), z.null()]).optional(), active: z.boolean().optional() }).parse(req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const employee = await client.query('SELECT * FROM employees WHERE id=$1 AND organization_id=$2 FOR UPDATE', [employeeId, req.user.organization_id]);
    if (!employee.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Employee not found.' }); }
    const passwordHash = await bcrypt.hash(input.temporary_password, 12);
    let user;
    if (employee.rows[0].user_id) {
      user = await client.query(
        `UPDATE users SET email=$1,password_hash=$2,full_name=$3,role=$4,hr_role_id=$5,custom_role_id=$6,active=$7,invitation_status='ENABLED',must_change_password=TRUE,updated_at=NOW()
         WHERE id=$8 RETURNING *`,
        [input.email.toLowerCase(), passwordHash, `${employee.rows[0].first_name} ${employee.rows[0].last_name}`, input.system_role || 'EMPLOYEE', input.hr_role_id || null, input.custom_role_id || null, input.active !== false, employee.rows[0].user_id],
      );
    } else {
      user = await client.query(
        `INSERT INTO users (organization_id,email,password_hash,full_name,role,hr_role_id,custom_role_id,active,invitation_status,must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ENABLED',TRUE) RETURNING *`,
        [req.user.organization_id, input.email.toLowerCase(), passwordHash, `${employee.rows[0].first_name} ${employee.rows[0].last_name}`, input.system_role || 'EMPLOYEE', input.hr_role_id || null, input.custom_role_id || null, input.active !== false],
      );
      await client.query('UPDATE employees SET user_id=$1,work_email=$2,updated_at=NOW() WHERE id=$3', [user.rows[0].id, input.email.toLowerCase(), employeeId]);
    }
    await client.query('COMMIT');
    await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: 'ENABLE_WEB_ACCOUNT', entityType: 'EMPLOYEE', entityId: employeeId, details: { email: input.email } });
    res.json({ user: user.rows[0], temporary_password: input.temporary_password });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(400).json({ error: 'This email address is already used by another account.' });
    throw error;
  } finally { client.release(); }
}));

app.post('/api/web-accounts/:id/status', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ active: z.boolean() }).parse(req.body);
  const result = await query('UPDATE users SET active=$1,invitation_status=$2,updated_at=NOW() WHERE id=$3 AND organization_id=$4 RETURNING *', [input.active, input.active ? 'ENABLED' : 'DISABLED', id, req.user.organization_id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Web account not found.' });
  await audit({ organizationId: req.user.organization_id, actorUserId: req.user.id, action: input.active ? 'ENABLE' : 'DISABLE', entityType: 'WEB_ACCOUNT', entityId: id });
  res.json(result.rows[0]);
}));

// --- Workflow configuration ---------------------------------------------------
app.get('/api/workflows', authenticate, handle(async (req, res) => {
  const moduleKey = String(req.query.module || '').toUpperCase();
  if (moduleKey && !validWorkflowModules.includes(moduleKey)) return res.status(400).json({ error: 'Unsupported workflow module.' });
  const params = [req.user.organization_id];
  const filter = moduleKey ? ' AND module_key=$2' : '';
  if (moduleKey) params.push(moduleKey);
  const result = await query(`SELECT * FROM approval_workflows WHERE organization_id=$1 ${filter} ORDER BY module_key,workflow_name`, params);
  res.json(result.rows.map((workflow) => ({ ...workflow, steps: asArray(workflow.steps) })));
}));

app.post('/api/workflows', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ module_key: z.enum(validWorkflowModules), workflow_name: z.string().min(2).max(160), steps: z.array(z.object({ step: z.union([z.number(),z.string()]), approver: z.string().min(2).max(120) })).min(1), active: z.boolean().optional() }).parse(req.body);
  const normalisedSteps = input.steps.map((step, index) => ({ step: Number(step.step) || index + 1, approver: step.approver.trim() }));
  const result = await query(`INSERT INTO approval_workflows (organization_id,module_key,workflow_name,steps,active) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`, [req.user.organization_id, input.module_key, input.workflow_name.trim(), JSON.stringify(normalisedSteps), input.active !== false]);
  res.status(201).json({ ...result.rows[0], steps: asArray(result.rows[0].steps) });
}));

app.patch('/api/workflows/:id', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ workflow_name: z.string().min(2).max(160), steps: z.array(z.object({ step: z.union([z.number(),z.string()]), approver: z.string().min(2).max(120) })).min(1), active: z.boolean().optional() }).parse(req.body);
  const steps = input.steps.map((step, index) => ({ step: Number(step.step) || index + 1, approver: step.approver.trim() }));
  const result = await query(`UPDATE approval_workflows SET workflow_name=$1,steps=$2::jsonb,active=$3,updated_at=NOW() WHERE id=$4 AND organization_id=$5 RETURNING *`, [input.workflow_name.trim(), JSON.stringify(steps), input.active !== false, id, req.user.organization_id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Workflow not found.' });
  res.json({ ...result.rows[0], steps: asArray(result.rows[0].steps) });
}));

// --- Leave configuration, calendar and entitlement administration -----------
app.get('/api/leave/planner', authenticate, handle(async (req, res) => {
  const month = String(req.query.month || dateOnly().slice(0, 7));
  const start = `${month}-01`;
  const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1);
  const endDate = end.toISOString().slice(0, 10);
  const params = [req.user.organization_id, start, endDate];
  let personalFilter = '';
  if (req.user.role === 'EMPLOYEE') { params.push(req.user.employee_id || -1); personalFilter = ` AND lr.employee_id=$4`; }
  const result = await query(
    `SELECT lr.*,lt.name AS leave_type,e.first_name || ' ' || e.last_name AS employee_name
     FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id JOIN employees e ON e.id=lr.employee_id
     WHERE lr.organization_id=$1 AND lr.start_date < $3 AND lr.end_date >= $2 ${personalFilter}
     ORDER BY lr.start_date,e.first_name`, params,
  );
  res.json(result.rows);
}));

app.post('/api/leave/entitlements', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const input = z.object({ employee_id: z.number().int(), leave_type_id: z.number().int(), entitlement_year: z.union([z.number(),z.string()]), entitled_days: z.union([z.number(),z.string()]), used_days: z.union([z.number(),z.string()]).optional() }).parse(req.body);
  const result = await query(
    `INSERT INTO leave_entitlements (organization_id,employee_id,leave_type_id,entitlement_year,entitled_days,used_days)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (employee_id,leave_type_id,entitlement_year) DO UPDATE SET entitled_days=EXCLUDED.entitled_days,used_days=EXCLUDED.used_days,updated_at=NOW()
     RETURNING *`,
    [req.user.organization_id, input.employee_id, input.leave_type_id, Number(input.entitlement_year), toNumber(input.entitled_days), toNumber(input.used_days)],
  );
  res.json(result.rows[0]);
}));

app.patch('/api/leave/types/:id', authenticate, requireRole('ADMIN'), handle(async (req, res) => {
  const id=Number(req.params.id); const input=z.object({ name:z.string().min(2).max(120),code:z.string().min(2).max(30),default_days:z.union([z.number(),z.string()]),active:z.boolean().optional() }).parse(req.body);
  const result=await query('UPDATE leave_types SET name=$1,code=$2,default_days=$3,active=$4 WHERE id=$5 AND organization_id=$6 RETURNING *',[input.name.trim(),input.code.trim().toUpperCase(),toNumber(input.default_days),input.active!==false,id,req.user.organization_id]);
  if(!result.rows[0]) return res.status(404).json({error:'Leave type not found.'}); res.json(result.rows[0]);
}));

app.get('/api/leave/policies', authenticate, handle(async (req,res)=>{
  const result=await query(`SELECT lep.*,lt.name AS leave_type FROM leave_earning_policies lep LEFT JOIN leave_types lt ON lt.id=lep.leave_type_id WHERE lep.organization_id=$1 ORDER BY lep.name`,[req.user.organization_id]); res.json(result.rows);
}));
app.post('/api/leave/policies', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const input=z.object({name:z.string().min(2).max(160),leave_type_id:z.union([z.number().int(),z.null()]).optional(),earn_rate:z.union([z.number(),z.string()]),frequency:z.string().min(2).max(30),active:z.boolean().optional()}).parse(req.body);
  const result=await query(`INSERT INTO leave_earning_policies (organization_id,name,leave_type_id,earn_rate,frequency,active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,[req.user.organization_id,input.name.trim(),input.leave_type_id||null,toNumber(input.earn_rate),input.frequency.trim().toUpperCase(),input.active!==false]); res.status(201).json(result.rows[0]);
}));
app.patch('/api/leave/policies/:id', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const id=Number(req.params.id);const input=z.object({name:z.string().min(2).max(160),leave_type_id:z.union([z.number().int(),z.null()]).optional(),earn_rate:z.union([z.number(),z.string()]),frequency:z.string().min(2).max(30),active:z.boolean().optional()}).parse(req.body);
  const result=await query(`UPDATE leave_earning_policies SET name=$1,leave_type_id=$2,earn_rate=$3,frequency=$4,active=$5,updated_at=NOW() WHERE id=$6 AND organization_id=$7 RETURNING *`,[input.name.trim(),input.leave_type_id||null,toNumber(input.earn_rate),input.frequency.trim().toUpperCase(),input.active!==false,id,req.user.organization_id]);if(!result.rows[0])return res.status(404).json({error:'Earning policy not found.'});res.json(result.rows[0]);
}));

app.get('/api/workdays', authenticate, handle(async(req,res)=>{
  const result=await query('SELECT * FROM workday_profiles WHERE organization_id=$1 ORDER BY active DESC,name',[req.user.organization_id]);res.json(result.rows.map((item)=>({...item,workdays:asArray(item.workdays)})));
}));
app.post('/api/workdays', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const input=z.object({name:z.string().min(2).max(160),workdays:z.array(z.enum(['MON','TUE','WED','THU','FRI','SAT','SUN'])).min(1),start_time:z.string().optional().or(z.literal('')),end_time:z.string().optional().or(z.literal('')),active:z.boolean().optional()}).parse(req.body);
  const result=await query(`INSERT INTO workday_profiles (organization_id,name,workdays,start_time,end_time,active) VALUES($1,$2,$3::jsonb,NULLIF($4,'')::time,NULLIF($5,'')::time,$6) RETURNING *`,[req.user.organization_id,input.name.trim(),JSON.stringify(input.workdays),input.start_time||'',input.end_time||'',input.active!==false]);res.status(201).json({...result.rows[0],workdays:asArray(result.rows[0].workdays)});
}));
app.patch('/api/workdays/:id', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const id=Number(req.params.id);const input=z.object({name:z.string().min(2).max(160),workdays:z.array(z.enum(['MON','TUE','WED','THU','FRI','SAT','SUN'])).min(1),start_time:z.string().optional().or(z.literal('')),end_time:z.string().optional().or(z.literal('')),active:z.boolean().optional()}).parse(req.body);
  const result=await query(`UPDATE workday_profiles SET name=$1,workdays=$2::jsonb,start_time=NULLIF($3,'')::time,end_time=NULLIF($4,'')::time,active=$5,updated_at=NOW() WHERE id=$6 AND organization_id=$7 RETURNING *`,[input.name.trim(),JSON.stringify(input.workdays),input.start_time||'',input.end_time||'',input.active!==false,id,req.user.organization_id]);if(!result.rows[0])return res.status(404).json({error:'Workday profile not found.'});res.json({...result.rows[0],workdays:asArray(result.rows[0].workdays)});
}));

app.get('/api/holidays', authenticate, handle(async(req,res)=>{
  const year=Number(req.query.year)||nowYear();const result=await query(`SELECT * FROM holidays WHERE organization_id=$1 AND EXTRACT(YEAR FROM holiday_date)=$2 ORDER BY holiday_date`,[req.user.organization_id,year]);res.json(result.rows);
}));
app.post('/api/holidays', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const input=z.object({holiday_date:z.string().min(10),name:z.string().min(2).max(180),applies_to_all:z.boolean().optional()}).parse(req.body);const result=await query(`INSERT INTO holidays (organization_id,holiday_date,name,applies_to_all) VALUES ($1,$2,$3,$4) RETURNING *`,[req.user.organization_id,input.holiday_date,input.name.trim(),input.applies_to_all!==false]);res.status(201).json(result.rows[0]);
}));
app.delete('/api/holidays/:id', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{const id=Number(req.params.id);const result=await query('DELETE FROM holidays WHERE id=$1 AND organization_id=$2 RETURNING *',[id,req.user.organization_id]);if(!result.rows[0])return res.status(404).json({error:'Holiday not found.'});res.json({success:true});}));


// --- Expense claim configuration, review reports and attendance field check-in
app.get('/api/claims/categories', authenticate, handle(async (req, res) => {
  const result = await query('SELECT * FROM claim_categories WHERE organization_id=$1 AND active=TRUE ORDER BY name', [req.user.organization_id]);
  res.json(result.rows);
}));
app.post('/api/claims/categories', authenticate, requireRole('ADMIN'), handle(async (req,res)=>{
  const input=z.object({name:z.string().min(2).max(160),code:z.string().min(2).max(50),active:z.boolean().optional()}).parse(req.body);
  const result=await query('INSERT INTO claim_categories (organization_id,name,code,active) VALUES($1,$2,$3,$4) RETURNING *',[req.user.organization_id,input.name.trim(),input.code.trim().toUpperCase(),input.active!==false]);res.status(201).json(result.rows[0]);
}));
app.patch('/api/claims/categories/:id', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const id=Number(req.params.id);const input=z.object({name:z.string().min(2).max(160),code:z.string().min(2).max(50),active:z.boolean().optional()}).parse(req.body);const result=await query('UPDATE claim_categories SET name=$1,code=$2,active=$3 WHERE id=$4 AND organization_id=$5 RETURNING *',[input.name.trim(),input.code.trim().toUpperCase(),input.active!==false,id,req.user.organization_id]);if(!result.rows[0])return res.status(404).json({error:'Category not found.'});res.json(result.rows[0]);
}));
app.post('/api/claims/types', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const input=z.object({name:z.string().min(2).max(120),code:z.string().min(2).max(30),category_id:z.union([z.number().int(),z.null()]).optional(),requires_attachment:z.boolean().optional(),active:z.boolean().optional()}).parse(req.body);
  const result=await query('INSERT INTO claim_types (organization_id,name,code,category_id,requires_attachment,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.user.organization_id,input.name.trim(),input.code.trim().toUpperCase(),input.category_id||null,Boolean(input.requires_attachment),input.active!==false]);res.status(201).json(result.rows[0]);
}));
app.patch('/api/claims/types/:id', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const id=Number(req.params.id);const input=z.object({name:z.string().min(2).max(120),code:z.string().min(2).max(30),category_id:z.union([z.number().int(),z.null()]).optional(),requires_attachment:z.boolean().optional(),active:z.boolean().optional()}).parse(req.body);const result=await query('UPDATE claim_types SET name=$1,code=$2,category_id=$3,requires_attachment=$4,active=$5 WHERE id=$6 AND organization_id=$7 RETURNING *',[input.name.trim(),input.code.trim().toUpperCase(),input.category_id||null,Boolean(input.requires_attachment),input.active!==false,id,req.user.organization_id]);if(!result.rows[0])return res.status(404).json({error:'Expense type not found.'});res.json(result.rows[0]);
}));

app.get('/api/claims/report', authenticate, requireRole('ADMIN','MANAGER'), handle(async(req,res)=>{
  const result=await query(`SELECT cr.*,ct.name AS claim_type,cc.name AS category,e.employee_code,e.first_name || ' ' || e.last_name AS employee_name
    FROM claim_requests cr JOIN claim_types ct ON ct.id=cr.claim_type_id LEFT JOIN claim_categories cc ON cc.id=ct.category_id JOIN employees e ON e.id=cr.employee_id
    WHERE cr.organization_id=$1 ORDER BY cr.claim_date DESC,cr.created_at DESC`,[req.user.organization_id]);res.json(result.rows);
}));

app.post('/api/attendance/field-check-in', authenticate, handle(async(req,res)=>{
  if(!req.user.employee_id)return res.status(400).json({error:'Your account is not linked to an employee profile.'});
  const input=z.object({location_note:z.string().min(2).max(500),notes:z.string().max(1000).optional().or(z.literal(''))}).parse(req.body);
  const today=dateOnly();
  const result=await query(`INSERT INTO attendance_records (organization_id,employee_id,work_date,clock_in_at,source,location_note,notes)
    VALUES ($1,$2,$3,NOW(),'FIELD',$4,$5)
    ON CONFLICT (employee_id,work_date) DO UPDATE SET clock_in_at=COALESCE(attendance_records.clock_in_at,NOW()),source='FIELD',location_note=EXCLUDED.location_note,notes=EXCLUDED.notes,updated_at=NOW()
    RETURNING *`,[req.user.organization_id,req.user.employee_id,today,input.location_note.trim(),input.notes?.trim()||null]);
  await audit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'FIELD_CHECK_IN',entityType:'ATTENDANCE',entityId:result.rows[0].id,details:{location:input.location_note}});res.json(result.rows[0]);
}));

// --- Document workflow review ------------------------------------------------
app.post('/api/documents/:id/:decision', authenticate, requireRole('ADMIN','MANAGER'), handle(async(req,res)=>{
  const id=Number(req.params.id); const decision=req.params.decision==='approve'?'APPROVED':req.params.decision==='reject'?'REJECTED':null;
  if(!decision)return res.status(400).json({error:'Decision must be approve or reject.'});
  const input=z.object({remark:z.string().max(1000).optional().or(z.literal(''))}).parse(req.body||{});
  const result=await query(`UPDATE documents SET status=$1,reviewer_user_id=$2,reviewer_remark=$3,reviewed_at=NOW() WHERE id=$4 AND organization_id=$5 AND status='PENDING' RETURNING *`,[decision,req.user.id,input.remark?.trim()||null,id,req.user.organization_id]);
  if(!result.rows[0])return res.status(400).json({error:'Only pending documents can be reviewed.'});
  await audit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:decision,entityType:'DOCUMENT',entityId:id,details:{remark:input.remark||''}});res.json(result.rows[0]);
}));

// --- Incident management and configurable causes / types / decisions --------
app.get('/api/incidents', authenticate, handle(async(req,res)=>{
  const params=[req.user.organization_id];let filter='';if(req.user.role==='EMPLOYEE'){params.push(req.user.employee_id||-1);filter=` AND i.employee_id=$${params.length}`;}
  const result=await query(`SELECT i.*,e.first_name || ' ' || e.last_name AS employee_name,cat.label AS category_name,typ.label AS type_name,dec.label AS decision_name,
    reporter.full_name AS reporter_name,reviewer.full_name AS reviewer_name
    FROM incidents i LEFT JOIN employees e ON e.id=i.employee_id LEFT JOIN reference_options cat ON cat.id=i.category_id LEFT JOIN reference_options typ ON typ.id=i.type_id LEFT JOIN reference_options dec ON dec.id=i.decision_id
    LEFT JOIN users reporter ON reporter.id=i.reported_by_user_id LEFT JOIN users reviewer ON reviewer.id=i.reviewed_by_user_id
    WHERE i.organization_id=$1 ${filter} ORDER BY i.incident_date DESC,i.created_at DESC`,params);res.json(result.rows);
}));
app.post('/api/incidents', authenticate, handle(async(req,res)=>{
  const input=z.object({employee_id:z.union([z.number().int(),z.null()]).optional(),incident_date:z.string().min(10),category_id:z.union([z.number().int(),z.null()]).optional(),type_id:z.union([z.number().int(),z.null()]).optional(),title:z.string().min(3).max(220),description:z.string().max(4000).optional().or(z.literal(''))}).parse(req.body);
  const targetEmployee=req.user.role==='EMPLOYEE'?req.user.employee_id:(input.employee_id||null);if(req.user.role==='EMPLOYEE'&&!targetEmployee)return res.status(400).json({error:'Your account is not linked to an employee profile.'});
  const result=await query(`INSERT INTO incidents (organization_id,employee_id,incident_date,category_id,type_id,title,description,reported_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[req.user.organization_id,targetEmployee,input.incident_date,input.category_id||null,input.type_id||null,input.title.trim(),input.description?.trim()||null,req.user.id]);
  await audit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'REPORT',entityType:'INCIDENT',entityId:result.rows[0].id,details:{title:input.title}});res.status(201).json(result.rows[0]);
}));
app.post('/api/incidents/:id/review', authenticate, requireRole('ADMIN','MANAGER'), handle(async(req,res)=>{
  const id=Number(req.params.id);const input=z.object({status:z.enum(['OPEN','UNDER_REVIEW','CLOSED']),decision_id:z.union([z.number().int(),z.null()]).optional(),review_note:z.string().max(2000).optional().or(z.literal(''))}).parse(req.body);
  const result=await query(`UPDATE incidents SET status=$1,decision_id=$2,review_note=$3,reviewed_by_user_id=$4,reviewed_at=NOW(),updated_at=NOW() WHERE id=$5 AND organization_id=$6 RETURNING *`,[input.status,input.decision_id||null,input.review_note?.trim()||null,req.user.id,id,req.user.organization_id]);if(!result.rows[0])return res.status(404).json({error:'Incident not found.'});await audit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'REVIEW',entityType:'INCIDENT',entityId:id,details:{status:input.status}});res.json(result.rows[0]);
}));

app.get('/api/incidents/options/:type', authenticate, handle(async(req,res)=>{
  const type=String(req.params.type||'').toUpperCase();const map={CATEGORIES:'INCIDENT_CATEGORY',TYPES:'INCIDENT_TYPE',DECISIONS:'INCIDENT_DECISION'};if(!map[type])return res.status(400).json({error:'Unsupported incident option type.'});
  const result=await query('SELECT * FROM reference_options WHERE organization_id=$1 AND option_type=$2 AND active=TRUE ORDER BY label',[req.user.organization_id,map[type]]);res.json(result.rows);
}));
app.post('/api/incidents/options/:type', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const type=String(req.params.type||'').toUpperCase();const map={CATEGORIES:'INCIDENT_CATEGORY',TYPES:'INCIDENT_TYPE',DECISIONS:'INCIDENT_DECISION'};if(!map[type])return res.status(400).json({error:'Unsupported incident option type.'});const input=z.object({label:z.string().min(2).max(160),code:z.string().max(50).optional().or(z.literal(''))}).parse(req.body);
  const result=await query('INSERT INTO reference_options (organization_id,option_type,code,label) VALUES($1,$2,$3,$4) RETURNING *',[req.user.organization_id,map[type],input.code?.trim()||null,input.label.trim()]);res.status(201).json(result.rows[0]);
}));
app.patch('/api/incidents/options/:type/:id', authenticate, requireRole('ADMIN'), handle(async(req,res)=>{
  const type=String(req.params.type||'').toUpperCase();const map={CATEGORIES:'INCIDENT_CATEGORY',TYPES:'INCIDENT_TYPE',DECISIONS:'INCIDENT_DECISION'};if(!map[type])return res.status(400).json({error:'Unsupported incident option type.'});const id=Number(req.params.id);const input=z.object({label:z.string().min(2).max(160),code:z.string().max(50).optional().or(z.literal('')),active:z.boolean().optional()}).parse(req.body);
  const result=await query('UPDATE reference_options SET code=$1,label=$2,active=$3,updated_at=NOW() WHERE id=$4 AND organization_id=$5 AND option_type=$6 RETURNING *',[input.code?.trim()||null,input.label.trim(),input.active!==false,id,req.user.organization_id,map[type]]);if(!result.rows[0])return res.status(404).json({error:'Incident option not found.'});res.json(result.rows[0]);
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
