import React, { useEffect, useState } from 'react';
import { api, formatDate } from '../api';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';

export default function DashboardPage() {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  useEffect(() => { api('/api/dashboard').then(setData).catch((err) => setError(err.message)); }, []);
  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <div className="loading-block">Loading your workplace overview…</div>;
  const cards = [
    ['Active employees', data.stats.employees, 'People records in this workspace'],
    ['Pending leave', data.stats.pendingLeave, 'Applications awaiting action'],
    ['Pending claims', data.stats.pendingClaims, 'Expense claims in the workflow'],
    ['Attendance today', data.stats.attendanceToday, 'Clocked-in record count'],
  ];
  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">WORKSPACE OVERVIEW</span><h1>Good day, welcome to HR operations.</h1><p>Use this overview to monitor important requests and activity in your organisation.</p></div><div className="date-chip">{new Intl.DateTimeFormat('en-SG', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date())}</div></div>
    <div className="metric-grid">{cards.map(([label, value, caption]) => <article className="metric-card" key={label}><span>{label}</span><strong>{value}</strong><small>{caption}</small></article>)}</div>
    <section className="content-card"><div className="card-heading"><div><h2>Recent leave activity</h2><p>Latest requests created in the system.</p></div></div>
      {data.recentLeave.length === 0 ? <EmptyState title="No leave activity" note="Leave applications will appear here when they are created." /> : <div className="table-wrap"><table><thead><tr><th>Employee</th><th>Leave type</th><th>Period</th><th>Days</th><th>Status</th></tr></thead><tbody>{data.recentLeave.map((item) => <tr key={item.id}><td><b>{item.employee_name}</b></td><td>{item.leave_type}</td><td>{formatDate(item.start_date)} – {formatDate(item.end_date)}</td><td>{item.requested_days}</td><td><StatusBadge value={item.status} /></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
