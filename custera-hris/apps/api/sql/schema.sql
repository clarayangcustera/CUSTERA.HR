CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  code VARCHAR(80) NOT NULL UNIQUE,
  timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Singapore',
  currency VARCHAR(10) NOT NULL DEFAULT 'SGD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  code VARCHAR(30),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(180) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'EMPLOYEE' CHECK (role IN ('ADMIN', 'MANAGER', 'EMPLOYEE')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  employee_code VARCHAR(40) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  work_email VARCHAR(255),
  phone VARCHAR(60),
  job_title VARCHAR(160),
  employment_type VARCHAR(60) NOT NULL DEFAULT 'Permanent',
  hire_date DATE,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  manager_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, employee_code)
);

CREATE TABLE IF NOT EXISTS leave_types (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30) NOT NULL,
  default_days NUMERIC(6,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS leave_entitlements (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  entitlement_year INTEGER NOT NULL,
  entitled_days NUMERIC(6,2) NOT NULL DEFAULT 0,
  used_days NUMERIC(6,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, leave_type_id, entitlement_year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  requested_days NUMERIC(6,2) NOT NULL,
  reason TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  reviewer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_remark TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claim_types (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30) NOT NULL,
  requires_attachment BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS claim_requests (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  claim_type_id INTEGER NOT NULL REFERENCES claim_types(id) ON DELETE RESTRICT,
  claim_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  description TEXT,
  attachment_url TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAID')),
  reviewer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_remark TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  clock_in_at TIMESTAMPTZ,
  clock_out_at TIMESTAMPTZ,
  work_minutes INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(40) NOT NULL DEFAULT 'WEB',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title VARCHAR(180) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS payslips (
  id SERIAL PRIMARY KEY,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  allowances NUMERIC(12,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payroll_run_id, employee_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  title VARCHAR(220) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'General',
  document_url TEXT,
  visible_to_employee BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(120) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_org_active ON employees (organization_id, active);
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_status ON leave_requests (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_claim_requests_org_status ON claim_requests (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance_records (employee_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs (organization_id, created_at DESC);
