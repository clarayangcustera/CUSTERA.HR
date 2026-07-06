import React, { useEffect, useState } from 'react';
import { api, formatDate } from '../api';
import { useAuth } from '../auth';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';

const dayCodes = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const dayNames = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };

function Tabs({ active, setActive, isAdmin }) {
  const tabs = [
    ['applications', 'Applications'],
    ['planner', 'Planner'],
    ['entitlements', 'Entitlements'],
    ...(isAdmin ? [
      ['types', 'Leave types'],
      ['policies', 'Earning policies'],
      ['workdays', 'Workdays'],
      ['holidays', 'Holidays'],
      ['workflows', 'Approval workflow'],
    ] : []),
  ];
  return <div className="tab-bar">{tabs.map(([key, label]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => setActive(key)}>{label}</button>)}</div>;
}

function ActiveFlag({ active }) {
  return <span className={`status ${active ? 'status-approved' : 'status-rejected'}`}>{active ? 'Active' : 'Inactive'}</span>;
}

export default function LeavePage() {
  const { user } = useAuth();
  const isAdmin = user.role === 'ADMIN';
  const canReview = user.role !== 'EMPLOYEE';
  const [active, setActive] = useState('applications');
  const [types, setTypes] = useState([]);
  const [requests, setRequests] = useState([]);
  const [entitlements, setEntitlements] = useState([]);
  const [planner, setPlanner] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [workdays, setWorkdays] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setError('');
      const jobs = [
        api('/api/leave/types'),
        api('/api/leave/requests'),
        api('/api/leave/entitlements'),
        api(`/api/leave/planner?month=${month}`),
      ];
      if (isAdmin) jobs.push(
        api('/api/leave/policies'),
        api('/api/workdays'),
        api(`/api/holidays?year=${month.slice(0, 4)}`),
        api('/api/workflows?module=LEAVE'),
        api('/api/employees'),
      );
      const data = await Promise.all(jobs);
      setTypes(data[0]);
      setRequests(data[1]);
      setEntitlements(data[2]);
      setPlanner(data[3]);
      if (isAdmin) {
        setPolicies(data[4]); setWorkdays(data[5]); setHolidays(data[6]); setWorkflows(data[7]); setEmployees(data[8]);
      }
    } catch (err) { setError(err.message); }
  }

  useEffect(() => { load(); }, [month]);

  function open(name, item = null) {
    setError('');
    const currentYear = new Date().getFullYear();
    const blank = {
      request: { leave_type_id: types[0]?.id || '', start_date: '', end_date: '', reason: '' },
      type: { name: '', code: '', default_days: '14', active: true },
      entitlement: { employee_id: employees[0]?.id || '', leave_type_id: types[0]?.id || '', entitlement_year: currentYear, entitled_days: '14', used_days: '0' },
      policy: { name: '', leave_type_id: types[0]?.id || '', earn_rate: '1', frequency: 'MONTHLY', active: true },
      workday: { name: '', workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start_time: '09:00', end_time: '18:00', active: true },
      holiday: { holiday_date: '', name: '', applies_to_all: true },
      workflow: { workflow_name: '', steps: [{ step: 1, approver: 'Line Manager' }], active: true },
    };
    setForm(item ? { ...item, workdays: item.workdays || [], steps: item.steps || [] } : blank[name]);
    setModal({ name, item });
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      const name = modal.name;
      let path = ''; let method = 'POST'; let payload = { ...form };
      if (name === 'request') {
        path = '/api/leave/requests'; payload.leave_type_id = Number(payload.leave_type_id);
      }
      if (name === 'type') {
        path = modal.item ? `/api/leave/types/${modal.item.id}` : '/api/leave/types'; method = modal.item ? 'PATCH' : 'POST'; payload.default_days = Number(payload.default_days);
      }
      if (name === 'entitlement') {
        path = '/api/leave/entitlements';
        payload = { ...payload, employee_id: Number(payload.employee_id), leave_type_id: Number(payload.leave_type_id), entitlement_year: Number(payload.entitlement_year), entitled_days: Number(payload.entitled_days), used_days: Number(payload.used_days) };
      }
      if (name === 'policy') {
        path = modal.item ? `/api/leave/policies/${modal.item.id}` : '/api/leave/policies'; method = modal.item ? 'PATCH' : 'POST';
        payload = { ...payload, leave_type_id: payload.leave_type_id ? Number(payload.leave_type_id) : null, earn_rate: Number(payload.earn_rate) };
      }
      if (name === 'workday') { path = modal.item ? `/api/workdays/${modal.item.id}` : '/api/workdays'; method = modal.item ? 'PATCH' : 'POST'; }
      if (name === 'holiday') path = '/api/holidays';
      if (name === 'workflow') {
        path = modal.item ? `/api/workflows/${modal.item.id}` : '/api/workflows'; method = modal.item ? 'PATCH' : 'POST';
        payload = { ...payload, module_key: 'LEAVE', steps: (payload.steps || []).map((step, index) => ({ step: Number(step.step) || index + 1, approver: step.approver })) };
      }
      await api(path, { method, body: JSON.stringify(payload) });
      setModal(null); await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function review(id, decision) {
    const remark = window.prompt(`${decision === 'approve' ? 'Approve' : 'Reject'} leave. Optional remark:`);
    if (remark === null) return;
    try { await api(`/api/leave/requests/${id}/${decision}`, { method: 'POST', body: JSON.stringify({ remark }) }); await load(); } catch (err) { setError(err.message); }
  }

  async function deleteHoliday(id) {
    if (!window.confirm('Remove this holiday?')) return;
    try { await api(`/api/holidays/${id}`, { method: 'DELETE' }); await load(); } catch (err) { setError(err.message); }
  }

  const addButton = active === 'applications' ? ['request', '+ New leave application']
    : active === 'types' ? ['type', '+ Leave type']
      : active === 'entitlements' ? ['entitlement', '+ Set entitlement']
        : active === 'policies' ? ['policy', '+ Earning policy']
          : active === 'workdays' ? ['workday', '+ Workday profile']
            : active === 'holidays' ? ['holiday', '+ Holiday']
              : active === 'workflows' ? ['workflow', '+ Workflow'] : null;
  const showButton = active === 'applications' || isAdmin;

  return <div className="page">
    <div className="page-heading action-heading">
      <div><span className="eyebrow">LEAVE MANAGEMENT</span><h1>Leave, entitlement & scheduling</h1><p>Applications, review, calendar planner, entitlement balances, leave types, earning policies, workdays, holidays and approval workflow.</p></div>
      {showButton && addButton && <button className="button primary" onClick={() => open(addButton[0])}>{addButton[1]}</button>}
    </div>
    {error && <div className="alert alert-danger">{error}</div>}
    <section className="content-card">
      <Tabs active={active} setActive={setActive} isAdmin={isAdmin} />

      {active === 'applications' && <div className="tab-content">
        <div className="card-heading"><div><h2>{canReview ? 'Leave review queue' : 'My leave applications'}</h2><p>Application dates are tracked against the employee’s current-year entitlement balance.</p></div></div>
        {requests.length === 0 ? <EmptyState title="No leave applications" /> : <div className="table-wrap"><table><thead><tr>{canReview && <th>Employee</th>}<th>Leave type</th><th>Period</th><th>Days</th><th>Status</th><th>Reason</th><th /></tr></thead><tbody>
          {requests.map((request) => <tr key={request.id}>
            {canReview && <td><b>{request.employee_name}</b></td>}
            <td>{request.leave_type}</td><td>{formatDate(request.start_date)} – {formatDate(request.end_date)}</td><td>{request.requested_days}</td><td><StatusBadge value={request.status} /></td><td>{request.reason || '—'}</td>
            <td className="row-actions">{canReview && request.status === 'PENDING' && <><button className="text-button success-text" onClick={() => review(request.id, 'approve')}>Approve</button><button className="text-button danger-text" onClick={() => review(request.id, 'reject')}>Reject</button></>}</td>
          </tr>)}
        </tbody></table></div>}
      </div>}

      {active === 'planner' && <div className="tab-content">
        <div className="toolbar"><label>Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><span className="count-label">{planner.length} scheduled leave entries</span></div>
        {planner.length === 0 ? <EmptyState title="No leave scheduled for this month" /> : <div className="planner-list">{planner.map((entry) => <div key={entry.id}><span className="planner-date">{formatDate(entry.start_date)} – {formatDate(entry.end_date)}</span><b>{entry.employee_name}</b><span>{entry.leave_type}</span><StatusBadge value={entry.status} /></div>)}</div>}
      </div>}

      {active === 'entitlements' && <div className="tab-content">
        <div className="card-heading"><div><h2>Leave entitlement report</h2><p>Entitled, used and available leave balances for {new Date().getFullYear()}.</p></div></div>
        {entitlements.length === 0 ? <EmptyState title="No entitlement data" /> : <div className="table-wrap"><table><thead><tr>{canReview && <th>Employee</th>}<th>Leave type</th><th>Entitled</th><th>Used</th><th>Available</th></tr></thead><tbody>{entitlements.map((item) => <tr key={item.id}>{canReview && <td><b>{item.employee_name}</b></td>}<td>{item.leave_type}</td><td>{item.entitled_days}</td><td>{item.used_days}</td><td><b>{item.balance_days}</b></td></tr>)}</tbody></table></div>}
      </div>}

      {active === 'types' && <div className="tab-content"><div className="table-wrap"><table><thead><tr><th>Code</th><th>Leave type</th><th>Default annual days</th><th>Status</th><th /></tr></thead><tbody>{types.map((item) => <tr key={item.id}><td><b>{item.code}</b></td><td>{item.name}</td><td>{item.default_days}</td><td><ActiveFlag active={item.active} /></td><td><button className="text-button" onClick={() => open('type', item)}>Edit</button></td></tr>)}</tbody></table></div></div>}
      {active === 'policies' && <div className="tab-content">{policies.length === 0 ? <EmptyState title="No earning policies" /> : <div className="table-wrap"><table><thead><tr><th>Policy</th><th>Leave type</th><th>Earn rate</th><th>Frequency</th><th>Status</th><th /></tr></thead><tbody>{policies.map((item) => <tr key={item.id}><td><b>{item.name}</b></td><td>{item.leave_type || 'All leave types'}</td><td>{item.earn_rate}</td><td>{item.frequency}</td><td><ActiveFlag active={item.active} /></td><td><button className="text-button" onClick={() => open('policy', item)}>Edit</button></td></tr>)}</tbody></table></div>}</div>}
      {active === 'workdays' && <div className="tab-content">{workdays.length === 0 ? <EmptyState title="No workday profile" /> : <div className="table-wrap"><table><thead><tr><th>Name</th><th>Working days</th><th>Hours</th><th>Status</th><th /></tr></thead><tbody>{workdays.map((item) => <tr key={item.id}><td><b>{item.name}</b></td><td>{(item.workdays || []).map((code) => dayNames[code]).join(', ')}</td><td>{item.start_time?.slice(0, 5) || '—'} – {item.end_time?.slice(0, 5) || '—'}</td><td><ActiveFlag active={item.active} /></td><td><button className="text-button" onClick={() => open('workday', item)}>Edit</button></td></tr>)}</tbody></table></div>}</div>}
      {active === 'holidays' && <div className="tab-content"><div className="toolbar"><label>Year<input type="number" value={month.slice(0, 4)} onChange={(event) => setMonth(`${event.target.value}-${month.slice(5, 7)}`)} /></label></div>{holidays.length === 0 ? <EmptyState title="No holidays configured for this year" /> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Holiday</th><th>Applies to</th><th /></tr></thead><tbody>{holidays.map((item) => <tr key={item.id}><td>{formatDate(item.holiday_date)}</td><td><b>{item.name}</b></td><td>{item.applies_to_all ? 'All employees' : 'Selected employees'}</td><td><button className="text-button danger-text" onClick={() => deleteHoliday(item.id)}>Remove</button></td></tr>)}</tbody></table></div>}</div>}
      {active === 'workflows' && <div className="tab-content">{workflows.length === 0 ? <EmptyState title="No leave workflows" /> : <div className="workflow-grid">{workflows.map((item) => <article key={item.id} className="workflow-card"><div><b>{item.workflow_name}</b><span>{item.active ? 'Active' : 'Inactive'}</span></div><ol>{(item.steps || []).map((step) => <li key={step.step}>Step {step.step}: {step.approver}</li>)}</ol><button className="text-button" onClick={() => open('workflow', item)}>Edit workflow</button></article>)}</div>}</div>}
    </section>

    {modal && <LeaveModal modal={modal} form={form} setForm={setForm} types={types} employees={employees} saving={saving} onClose={() => setModal(null)} onSave={save} />}
  </div>;
}

function LeaveModal({ modal, form, setForm, types, employees, saving, onClose, onSave }) {
  const name = modal.name;
  const titles = { request: 'New Leave Application', type: 'Leave Type', entitlement: 'Set Entitlement', policy: 'Leave Earning Policy', workday: 'Workday Profile', holiday: 'Holiday', workflow: 'Leave Approval Workflow' };
  return <Modal title={titles[name]} onClose={onClose} wide><form className="form-stack" onSubmit={onSave}>
    {name === 'request' && <><div className="form-grid two"><label>Leave type<select required value={form.leave_type_id} onChange={(event) => setForm({ ...form, leave_type_id: event.target.value })}>{types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Start date<input type="date" required value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} /></label><label>End date<input type="date" required value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} /></label></div><label>Reason<textarea rows="4" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label></>}
    {name === 'type' && <div className="form-grid three"><label>Code<input required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></label><label>Name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Default annual days<input type="number" min="0" step="0.5" value={form.default_days} onChange={(event) => setForm({ ...form, default_days: event.target.value })} /></label></div>}
    {name === 'entitlement' && <div className="form-grid three"><label>Employee<select value={form.employee_id} onChange={(event) => setForm({ ...form, employee_id: event.target.value })}>{employees.map((item) => <option key={item.id} value={item.id}>{item.first_name} {item.last_name}</option>)}</select></label><label>Leave type<select value={form.leave_type_id} onChange={(event) => setForm({ ...form, leave_type_id: event.target.value })}>{types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Year<input type="number" value={form.entitlement_year} onChange={(event) => setForm({ ...form, entitlement_year: event.target.value })} /></label><label>Entitled days<input type="number" step="0.5" value={form.entitled_days} onChange={(event) => setForm({ ...form, entitled_days: event.target.value })} /></label><label>Used days<input type="number" step="0.5" value={form.used_days} onChange={(event) => setForm({ ...form, used_days: event.target.value })} /></label></div>}
    {name === 'policy' && <div className="form-grid three"><label>Policy name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Leave type<select value={form.leave_type_id || ''} onChange={(event) => setForm({ ...form, leave_type_id: event.target.value })}><option value="">All types</option>{types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Earn rate<input type="number" step="0.01" value={form.earn_rate} onChange={(event) => setForm({ ...form, earn_rate: event.target.value })} /></label><label>Frequency<select value={form.frequency} onChange={(event) => setForm({ ...form, frequency: event.target.value })}><option>MONTHLY</option><option>ANNUALLY</option><option>ON_CONFIRMATION</option></select></label></div>}
    {name === 'workday' && <><div className="form-grid three"><label>Name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Start time<input type="time" value={form.start_time || ''} onChange={(event) => setForm({ ...form, start_time: event.target.value })} /></label><label>End time<input type="time" value={form.end_time || ''} onChange={(event) => setForm({ ...form, end_time: event.target.value })} /></label></div><div className="day-toggle-row">{dayCodes.map((code) => <label className="checkbox-row" key={code}><input type="checkbox" checked={(form.workdays || []).includes(code)} onChange={(event) => setForm({ ...form, workdays: event.target.checked ? [...(form.workdays || []), code] : (form.workdays || []).filter((item) => item !== code) })} />{dayNames[code]}</label>)}</div></>}
    {name === 'holiday' && <div className="form-grid two"><label>Date<input type="date" required value={form.holiday_date} onChange={(event) => setForm({ ...form, holiday_date: event.target.value })} /></label><label>Holiday name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label></div>}
    {name === 'workflow' && <><label>Workflow name<input required value={form.workflow_name} onChange={(event) => setForm({ ...form, workflow_name: event.target.value })} /></label><div className="stack-list">{(form.steps || []).map((step, index) => <div className="inline-form-card" key={index}><label>Step {index + 1} approver<input required value={step.approver} onChange={(event) => { const next = [...(form.steps || [])]; next[index] = { ...step, approver: event.target.value }; setForm({ ...form, steps: next }); }} /></label>{form.steps.length > 1 && <button type="button" className="text-button danger-text" onClick={() => setForm({ ...form, steps: form.steps.filter((_, row) => row !== index) })}>Remove</button>}</div>)}</div><button type="button" className="button compact" onClick={() => setForm({ ...form, steps: [...(form.steps || []), { step: (form.steps || []).length + 1, approver: 'HR Manager' }] })}>+ Approval step</button></>}
    <div className="form-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
  </form></Modal>;
}
