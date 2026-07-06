import React, { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';

const navItems = [
  ['/', 'Overview', '◈', () => true],
  ['/employees', 'Employee centre', '◉', () => true],
  ['/people-records', 'People records', '▤', (user) => user.role !== 'EMPLOYEE'],
  ['/leave', 'Leave', '◷', () => true],
  ['/claims', 'Expense claims', '¤', () => true],
  ['/attendance', 'Attendance', '◴', () => true],
  ['/documents', 'Document workflow', '▤', () => true],
  ['/incidents', 'Incidents', '▲', () => true],
  ['/payroll', 'Payroll', '$', () => true],
  ['/access', 'Roles & web access', '⚿', (user) => user.role === 'ADMIN'],
  ['/settings', 'Organisation setup', '⚙', () => true],
  ['/audit', 'Audit log', '≡', (user) => user.role !== 'EMPLOYEE'],
];

export default function Layout() {
  const { user, logout } = useAuth(); const [open,setOpen]=useState(false);
  const nav = navItems.filter(([, , , visible]) => visible(user));
  return <div className="app-shell"><aside className={`sidebar ${open?'sidebar-open':''}`}><div className="brand-block"><div className="brand-mark">C</div><div><strong>Custera</strong><span>HR Information System</span></div></div><div className="tenant-pill">{user.role === 'ADMIN' ? 'HR administration workspace' : user.role === 'MANAGER' ? 'Manager workspace' : 'Employee self-service'}</div><nav className="side-nav">{nav.map(([to,label,icon])=><NavLink key={to} to={to} end={to==='/'} className={({isActive})=>`nav-item ${isActive?'active':''}`} onClick={()=>setOpen(false)}><span className="nav-icon">{icon}</span><span>{label}</span></NavLink>)}</nav><div className="sidebar-bottom"><div className="profile-mini"><span>{user.full_name?.slice(0,1)||'U'}</span><div><b>{user.full_name}</b><small>{user.role}</small></div></div><button className="logout-button" onClick={logout}>Sign out</button></div></aside>{open&&<button className="mobile-scrim" aria-label="Close menu" onClick={()=>setOpen(false)}/>}<main className="main-content"><header className="topbar"><button className="menu-button" onClick={()=>setOpen((value)=>!value)} aria-label="Menu">☰</button><div className="topbar-title"><b>Custera HRIS</b><span>Employee, workflow and people operations</span></div><div className="topbar-user"><span className="top-avatar">{user.full_name?.slice(0,1)||'U'}</span><div><strong>{user.full_name}</strong><small>{user.email}</small></div></div></header><div className="content-wrap"><Outlet/></div></main></div>;
}
