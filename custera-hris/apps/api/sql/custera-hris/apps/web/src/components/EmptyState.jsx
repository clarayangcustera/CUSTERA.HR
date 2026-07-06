import React from 'react';
export default function EmptyState({ title = 'No records yet', note = 'Create a record to start using this module.' }) {
  return <div className="empty-state"><div className="empty-icon">⌁</div><h3>{title}</h3><p>{note}</p></div>;
}
