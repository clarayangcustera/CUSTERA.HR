import React, { useEffect, useMemo, useState } from 'react';
import { api, formatMoney, formatDate } from '../api';
import { useAuth } from '../auth';
import Modal from '../components/Modal';
import EmptyState from '../components/EmptyState';

const blankEmployee = { employee_code: '', first_name: '', last_name: '', work_email: '', phone: '', job_title: '', employment_type: 'Permanent', hire_date: '', department_id: '', manager_employee_id: '', basic_salary: '' };

export default function EmployeesPage() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState([]); const [departments, setDepartments] = useState([]);
  const [search, setSearch] = useState(''); const [modal, setModal] = useState(null); const [form, setForm] = useState(blankEmployee);
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const canEdit = user.role !== 'EMPLOYEE'; const canArchive = user.role === 'ADMIN';

  async function load() {
    try { const [employeeData, departmentData] = await Promise.all([api('/api/employees'), api('/api/departments')]); setEmployees(employeeData); setDepartments(departmentData); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  const filtered = useMemo(() => employees.filter((employee) => `${employee.first_name} ${employee.last_name} ${employee.employee_code} ${employee.work_email || ''}`.toLowerCase().includes(search.toLowerCase())), [employees, search]);

  function field(name, value) { setForm((current) => ({ ...current, [name]: value })); }
  function openNew() { setForm(blankEmployee); setModal('new'); setError(''); }
  function openEdit(employee) { setForm({ ...blankEmployee, ...employee, hire_date: employee.hire_date ? employee.hire_date.slice(0, 10) : '', department_id: employee.department_id || '', manager_employee_id: employee.manager_employee_id || '', basic_salary: employee.basic_salary || '' }); setModal('edit'); setError(''); }

  async function save(event) {
    event.preventDefault(); setSaving(true); setError('');
    const payload = { ...form, department_id: form.department_id ? Number(form.department_id) : null, manager_employee_id: form.manager_employee_id ? Number(form.manager_employee_id) : null, basic_salary: Number(form.basic_salary || 0) };
    try { if (modal === 'new') await api('/api/employees', { method: 'POST', body: JSON.stringify(payload) }); else await api(`/api/employees/${form.id}`, { method: 'PATCH', body: JSON.stringify(payload) }); setModal(null); await load(); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  async function archive(employee) { if (!window.confirm(`Archive ${employee.first_name} ${employee.last_name}?`)) return; try { await api(`/api/employees/${employee.id}/archive`, { method: 'POST' }); await load(); } catch (err) { setError(err.message); } }

  return <div className="page">
    <div className="page-heading action-heading"><div><span className="eyebrow">EMPLOYEE MANAGEMENT</span><h1>Employee records</h1><p>Maintain employee profiles, department placement, employment details and base salary.</p></div>{canEdit && <button className="button primary" onClick={openNew}>+ Add employee</button>}</div>
    {error && <div className="alert alert-danger">{error}</div>}
    <section className="content-card"><div className="toolbar"><div className="search-input"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employee name, code or email" /></div><span className="count-label">{filtered.length} employee{filtered.length === 1 ? '' : 's'}</span></div>
      {filtered.length === 0 ? <EmptyState title="No employees found" note="Add a new employee record or change your search." /> : <div className="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Job title</th><th>Hire date</th><th>Salary</th><th></th></tr></thead><tbody>{filtered.map((employee) => <tr key={employee.id}><td><div className="person-cell"><span className="avatar">{employee.first_name?.slice(0, 1)}{employee.last_name?.slice(0, 1)}</span><div><b>{employee.first_name} {employee.last_name}</b><small>{employee.employee_code} · {employee.work_email || 'No email'}</small></div></div></td><td>{employee.department_name || 'Unassigned'}</td><td>{employee.job_title || '—'}</td><td>{formatDate(employee.hire_date)}</td><td>{formatMoney(employee.basic_salary)}</td><td className="row-actions">{canEdit && <button className="text-button" onClick={() => openEdit(employee)}>Edit</button>}{canArchive && <button className="text-button danger-text" onClick={() => archive(employee)}>Archive</button>}</td></tr>)}</tbody></table></div>}
    </section>
    {modal && <Modal title={modal === 'new' ? 'Add employee' : 'Edit employee'} onClose={() => setModal(null)} wide><form onSubmit={save} className="form-stack"><div className="form-section"><h3>Identity</h3><div className="form-grid three"><label>Employee code<input value={form.employee_code} disabled={modal === 'edit'} onChange={(event) => field('employee_code', event.target.value)} required /></label><label>First name<input value={form.first_name} onChange={(event) => field('first_name', event.target.value)} required /></label><label>Last name<input value={form.last_name} onChange={(event) => field('last_name', event.target.value)} required /></label><label>Work email<input type="email" value={form.work_email || ''} onChange={(event) => field('work_email', event.target.value)} /></label><label>Phone<input value={form.phone || ''} onChange={(event) => field('phone', event.target.value)} /></label><label>Hire date<input type="date" value={form.hire_date || ''} onChange={(event) => field('hire_date', event.target.value)} /></label></div></div><div className="form-section"><h3>Employment placement</h3><div className="form-grid three"><label>Job title<input value={form.job_title || ''} onChange={(event) => field('job_title', event.target.value)} /></label><label>Employment type<select value={form.employment_type || 'Permanent'} onChange={(event) => field('employment_type', event.target.value)}><option>Permanent</option><option>Contract</option><option>Part-time</option><option>Intern</option></select></label><label>Department<select value={form.department_id || ''} onChange={(event) => field('department_id', event.target.value)}><option value="">Unassigned</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label><label>Line manager<select value={form.manager_employee_id || ''} onChange={(event) => field('manager_employee_id', event.target.value)}><option value="">Unassigned</option>{employees.filter((employee) => employee.id !== form.id).map((employee) => <option key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name}</option>)}</select></label><label>Monthly basic salary<input type="number" min="0" step="0.01" value={form.basic_salary || ''} onChange={(event) => field('basic_salary', event.target.value)} /></label></div></div>{error && <div className="alert alert-danger">{error}</div>}<div className="form-actions"><button type="button" className="button ghost" onClick={() => setModal(null)}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save employee'}</button></div></form></Modal>}
  </div>;
}
