import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@custera-hris.local');
  const [password, setPassword] = useState('ChangeMe123!');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  if (user) return <Navigate to="/" replace />;

  async function submit(event) {
    event.preventDefault();
    setError(''); setLoading(true);
    try { await login(email, password); navigate('/'); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="login-page">
      <section className="login-side">
        <div className="login-brand"><div className="brand-mark">C</div><div><strong>Custera</strong><span>HRIS Management</span></div></div>
        <div className="login-copy"><span className="eyebrow">ONE SYSTEM FOR PEOPLE OPERATIONS</span><h1>Run HR operations with clarity.</h1><p>Manage employee records, applications, attendance, approvals and payroll drafts from one secure workspace.</p></div>
        <div className="feature-list"><div><b>Employee management</b><span>Profiles, employment terms and departments.</span></div><div><b>Paperless workflows</b><span>Leave and expense claims with approvals.</span></div><div><b>Operational record</b><span>Attendance, payroll drafts and audit history.</span></div></div>
      </section>
      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <span className="eyebrow">SIGN IN</span><h2>Welcome back</h2><p>Enter your approved account details to access Custera HRIS.</p>
          {error && <div className="alert alert-danger">{error}</div>}
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          <button className="button primary full" disabled={loading}>{loading ? 'Signing in…' : 'Sign in securely'}</button>
          <div className="demo-note"><b>Demo accounts</b><span>Admin: admin@custera-hris.local</span><span>Manager: manager@custera-hris.local</span><span>Employee: employee@custera-hris.local</span><span>Password: ChangeMe123!</span></div>
        </form>
      </section>
    </div>
  );
}
