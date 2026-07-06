import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import Modal from '../components/Modal';
import EmptyState from '../components/EmptyState';

const referenceGroups = [
  ['JOB_POSITION', 'Job positions'], ['BRANCH', 'Branches'], ['LEVEL', 'Job levels'], ['BANK', 'Banks'],
  ['ETHNICITY', 'Ethnicity'], ['RELIGION', 'Religion'], ['PAYMENT_METHOD', 'Payment methods'], ['JOB_TYPE', 'Job types'],
  ['MARITAL_STATUS', 'Marital status'], ['RELATIONSHIP', 'Relationships'], ['BLOOD_TYPE', 'Blood types'],
];

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user.role === 'ADMIN';
  const [active, setActive] = useState('structure');
  const [organization, setOrganization] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [referenceOptions, setReferenceOptions] = useState({});
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ name: '', code: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  async function load() {
    try {
      setError('');
      const [organizationData, departmentData, ...references] = await Promise.all([
        api('/api/settings'), api('/api/departments'), ...referenceGroups.map(([type]) => api(`/api/reference-options?type=${type}`)),
      ]);
      setOrganization(organizationData); setDepartments(departmentData);
      setReferenceOptions(Object.fromEntries(referenceGroups.map(([type], index) => [type, references[index]])));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  function openDepartment() { setForm({ name: '', code: '' }); setModal({ name: 'department' }); }
  function openReference(type, item = null) { setForm(item ? { ...item } : { option_type: type, label: '', code: '' }); setModal({ name: 'reference', type, item }); }

  async function save(event) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      if (modal.name === 'department') await api('/api/departments', { method: 'POST', body: JSON.stringify({ name: form.name, code: form.code }) });
      if (modal.name === 'reference') {
        const path = modal.item ? `/api/reference-options/${modal.item.id}` : '/api/reference-options';
        const method = modal.item ? 'PATCH' : 'POST';
        const payload = modal.item ? { label: form.label, code: form.code, active: form.active !== false } : { option_type: modal.type, label: form.label, code: form.code };
        await api(path, { method, body: JSON.stringify(payload) });
      }
      setModal(null); await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function deactivateReference(id) {
    if (!window.confirm('Deactivate this reference option? It will no longer appear in new forms.')) return;
    try { await api(`/api/reference-options/${id}`, { method: 'DELETE' }); await load(); } catch (err) { setError(err.message); }
  }

  async function changePassword(event) {
    event.preventDefault(); setPasswordError(''); setPasswordMessage('');
    if (passwordForm.new_password !== passwordForm.confirm_password) { setPasswordError('New password and confirmation do not match.'); return; }
    setChangingPassword(true);
    try { await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify(passwordForm) }); setPasswordForm({ current_password: '', new_password: '', confirm_password: '' }); setPasswordMessage('Password updated successfully.'); }
    catch (err) { setPasswordError(err.message); } finally { setChangingPassword(false); }
  }

  const tabs = [['structure', 'Organisation & departments'], ...(isAdmin ? [['references', 'Reference data']] : []), ['security', 'Account security']];
  return <div className="page">
    <div className="page-heading action-heading"><div><span className="eyebrow">ORGANISATION SETTINGS</span><h1>Organisation & reference data</h1><p>Manage the controlled values used in employee dossiers, placement, employment terms and payments.</p></div>{isAdmin && active === 'structure' && <button className="button primary" onClick={openDepartment}>+ Add department</button>}</div>
    {error && <div className="alert alert-danger">{error}</div>}
    <section className="content-card"><div className="tab-bar">{tabs.map(([key, label]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => setActive(key)}>{label}</button>)}</div>
      {active === 'structure' && <div className="tab-content"><div className="settings-grid"><section className="content-card inset-card"><div className="card-heading"><div><h2>Organisation profile</h2><p>Core settings for the selected workspace.</p></div></div>{organization ? <dl className="definition-list"><div><dt>Organisation</dt><dd>{organization.name}</dd></div><div><dt>Code</dt><dd>{organization.code}</dd></div><div><dt>Time zone</dt><dd>{organization.timezone}</dd></div><div><dt>Currency</dt><dd>{organization.currency}</dd></div></dl> : <div className="loading-block">Loading organisation settings…</div>}</section><section className="content-card inset-card"><div className="card-heading"><div><h2>Role policy</h2><p>System roles and HR permission matrix are configured under Access control.</p></div></div><div className="role-list"><div><b>Administrator</b><span>Full organisation access, payroll publishing and audit logs.</span></div><div><b>Manager</b><span>People records, reviews, attendance and documents.</span></div><div><b>Employee</b><span>Self-service leave, claims, attendance, payslips and shared documents.</span></div></div></section></div><section className="content-card inset-card"><div className="card-heading"><div><h2>Departments</h2><p>Active departments available in employee placement.</p></div></div>{departments.length === 0 ? <EmptyState title="No departments" /> : <div className="department-list">{departments.map((department) => <div key={department.id}><span className="department-icon">⌁</span><div><b>{department.name}</b><small>{department.code || 'No department code'}</small></div><span className={department.active ? 'active-dot' : 'inactive-dot'}>{department.active ? 'Active' : 'Inactive'}</span></div>)}</div>}</section></div>}
      {active === 'references' && <div className="tab-content"><div className="reference-grid">{referenceGroups.map(([type, label]) => <section className="content-card inset-card" key={type}><div className="card-heading"><div><h2>{label}</h2><p>Used by employee and configuration forms.</p></div>{isAdmin && <button className="button compact" onClick={() => openReference(type)}>+ Add</button>}</div>{(referenceOptions[type] || []).length === 0 ? <p className="muted">No options configured.</p> : <div className="compact-config-list">{referenceOptions[type].map((item) => <div key={item.id}><div><b>{item.label}</b><small>{item.code || 'No code'}</small></div><span>{item.active ? 'Active' : 'Inactive'}</span>{isAdmin && <div><button className="text-button" onClick={() => openReference(type, item)}>Edit</button>{item.active && <button className="text-button danger-text" onClick={() => deactivateReference(item.id)}>Deactivate</button>}</div>}</div>)}</div>}</section>)}</div></div>}
      {active === 'security' && <div className="tab-content"><section className="content-card inset-card"><div className="card-heading"><div><h2>Account security</h2><p>Change the initial demo password before sharing this system with anyone.</p></div></div><form className="form-stack narrow-form" onSubmit={changePassword}><div className="form-grid three"><label>Current password<input required type="password" value={passwordForm.current_password} onChange={(event) => setPasswordForm({ ...passwordForm, current_password: event.target.value })} /></label><label>New password<input required minLength="10" type="password" value={passwordForm.new_password} onChange={(event) => setPasswordForm({ ...passwordForm, new_password: event.target.value })} /></label><label>Confirm new password<input required minLength="10" type="password" value={passwordForm.confirm_password} onChange={(event) => setPasswordForm({ ...passwordForm, confirm_password: event.target.value })} /></label></div>{passwordError && <div className="alert alert-danger">{passwordError}</div>}{passwordMessage && <div className="alert alert-info">{passwordMessage}</div>}<div><button className="button primary" disabled={changingPassword}>{changingPassword ? 'Updating…' : 'Update password'}</button></div></form></section></div>}
    </section>
    {modal && <Modal title={modal.name === 'department' ? 'Add department' : `${modal.item ? 'Edit' : 'Add'} reference option`} onClose={() => setModal(null)}><form className="form-stack" onSubmit={save}>{modal.name === 'department' ? <><label>Department name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Department code<input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="HR" /></label></> : <><label>Name<input required value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></label><label>Code<input value={form.code || ''} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="Optional code" /></label></>}<div className="form-actions"><button className="button ghost" type="button" onClick={() => setModal(null)}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div></form></Modal>}
  </div>;
}
