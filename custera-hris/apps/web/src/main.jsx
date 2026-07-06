import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import EmployeesPage from './pages/EmployeesPage';
import LeavePage from './pages/LeavePage';
import ClaimsPage from './pages/ClaimsPage';
import AttendancePage from './pages/AttendancePage';
import PayrollPage from './pages/PayrollPage';
import DocumentsPage from './pages/DocumentsPage';
import SettingsPage from './pages/SettingsPage';
import AuditPage from './pages/AuditPage';
import './styles.css';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading">Loading Custera HRIS…</div>;
  return user ? children : <Navigate to="/login" replace />;
}

function App() {
  return <Routes><Route path="/login" element={<LoginPage />} /><Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}><Route index element={<DashboardPage />} /><Route path="employees" element={<EmployeesPage />} /><Route path="leave" element={<LeavePage />} /><Route path="claims" element={<ClaimsPage />} /><Route path="attendance" element={<AttendancePage />} /><Route path="payroll" element={<PayrollPage />} /><Route path="documents" element={<DocumentsPage />} /><Route path="settings" element={<SettingsPage />} /><Route path="audit" element={<AuditPage />} /></Route><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><BrowserRouter><App /></BrowserRouter></AuthProvider></React.StrictMode>);
