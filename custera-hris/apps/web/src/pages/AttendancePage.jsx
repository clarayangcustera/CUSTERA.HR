import React, { useEffect, useMemo, useState } from 'react';
import { api, formatDate, formatDateTime } from '../api';
import { useAuth } from '../auth';
import EmptyState from '../components/EmptyState';

function formatMinutes(minutes) {
  const value = Number(minutes || 0); return `${Math.floor(value / 60)}h ${value % 60}m`;
}

export default function AttendancePage() {
  const { user } = useAuth(); const [records, setRecords] = useState([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  async function load() { try { setRecords(await api('/api/attendance')); } catch (err) { setError(err.message); } }
  useEffect(() => { load(); }, []);
  const today = new Date().toISOString().slice(0, 10); const todayRecord = useMemo(() => records.find((item) => item.work_date?.slice(0, 10) === today), [records, today]);
  async function clock(action) { setLoading(true); setError(''); try { await api(`/api/attendance/${action}`, { method: 'POST' }); await load(); } catch (err) { setError(err.message); } finally { setLoading(false); } }
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">TIME CLOCK & ATTENDANCE</span><h1>{user.role === 'EMPLOYEE' ? 'My attendance' : 'Attendance register'}</h1><p>{user.role === 'EMPLOYEE' ? 'Clock in and out, then review your recorded work time.' : 'Review attendance records currently submitted by your workforce.'}</p></div></div>{error && <div className="alert alert-danger">{error}</div>}{user.role === 'EMPLOYEE' && <section className="clock-card"><div><span className="eyebrow">TODAY · {formatDate(today)}</span><h2>{todayRecord?.clock_in_at ? (todayRecord.clock_out_at ? 'Workday complete' : 'You are clocked in') : 'Ready to start work?'}</h2><p>{todayRecord?.clock_in_at ? `Clock-in: ${formatDateTime(todayRecord.clock_in_at)}` : 'Use the time clock only when you are ready to begin your working day.'}</p></div><div className="clock-actions">{!todayRecord?.clock_in_at && <button className="button primary" disabled={loading} onClick={() => clock('clock-in')}>{loading ? 'Working…' : 'Clock in'}</button>}{todayRecord?.clock_in_at && !todayRecord?.clock_out_at && <button className="button warning" disabled={loading} onClick={() => clock('clock-out')}>{loading ? 'Working…' : 'Clock out'}</button>}{todayRecord?.clock_out_at && <span className="complete-indicator">✓ Completed</span>}</div></section>}<section className="content-card"><div className="card-heading"><div><h2>Attendance history</h2><p>Most recent 100 records, including pending open shifts.</p></div></div>{records.length === 0 ? <EmptyState title="No attendance records" note="Clock-in records will show here." /> : <div className="table-wrap"><table><thead><tr>{user.role !== 'EMPLOYEE' && <th>Employee</th>}<th>Work date</th><th>Clock in</th><th>Clock out</th><th>Work duration</th><th>Source</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}>{user.role !== 'EMPLOYEE' && <td><b>{record.employee_name}</b></td>}<td>{formatDate(record.work_date)}</td><td>{formatDateTime(record.clock_in_at)}</td><td>{formatDateTime(record.clock_out_at)}</td><td>{record.clock_out_at ? formatMinutes(record.work_minutes) : record.clock_in_at ? 'Open shift' : '—'}</td><td>{record.source}</td></tr>)}</tbody></table></div>}</section></div>;
}
