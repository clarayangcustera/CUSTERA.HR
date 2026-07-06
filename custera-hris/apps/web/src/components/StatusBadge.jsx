import React from 'react';

export default function StatusBadge({ value }) {
  const normalized = String(value || 'UNKNOWN').toLowerCase();
  return <span className={`status status-${normalized}`}>{String(value || 'Unknown').replaceAll('_', ' ')}</span>;
}
