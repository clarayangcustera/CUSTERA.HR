import React, { useEffect, useState } from 'react';
import { api, formatDateTime } from '../api';
import EmptyState from '../components/EmptyState';

export default function AuditPage() {
  const [logs, setLogs] = useState([]); const [error, setError] = useState('');
  useEffect(() => { api('/api/audit-logs').then(setLogs).catch((err) => setError(err.message)); }, []);
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">AUDIT LOG</span><h1>System activity history</h1><p>Review material actions captured across HR operations for traceability.</p></div></div>{error && <div className="alert alert-danger">{error}</div>}<section className="content-card"><div className="card-heading"><div><h2>Recent activity</h2><p>Showing the most recent 200 recorded actions.</p></div></div>{logs.length === 0 ? <EmptyState title="No audit history" /> : <div className="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td>{formatDateTime(log.created_at)}</td><td><b>{log.actor_name || 'System'}</b></td><td><span className="audit-action">{log.action}</span></td><td>{log.entity_type}{log.entity_id ? ` #${log.entity_id}` : ''}</td><td><code>{JSON.stringify(log.details)}</code></td></tr>)}</tbody></table></div>}</section></div>;
}
