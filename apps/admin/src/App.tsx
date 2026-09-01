import { useState } from 'react';
import { api } from './api.js';
import { AbuseQueue } from './views/AbuseQueue.js';
import { AuditLog } from './views/AuditLog.js';
import { Claims } from './views/Claims.js';
import { Dashboard } from './views/Dashboard.js';
import { Organizations } from './views/Organizations.js';
import { SignIn } from './views/SignIn.js';

const VIEWS = [
  { id: 'dashboard', label: 'Network health', render: () => <Dashboard /> },
  { id: 'abuse', label: 'Abuse & moderation', render: () => <AbuseQueue /> },
  { id: 'claims', label: 'Contested claims', render: () => <Claims /> },
  { id: 'organizations', label: 'Organizations', render: () => <Organizations /> },
  { id: 'audit', label: 'Audit log', render: () => <AuditLog /> },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

export function App(): JSX.Element {
  const [signedIn, setSignedIn] = useState(api.isSignedIn());
  const [view, setView] = useState<ViewId>('dashboard');

  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;

  const active = VIEWS.find((v) => v.id === view) ?? VIEWS[0];

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          Park<span>Ping</span>
        </div>
        {VIEWS.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${item.id === view ? 'active' : ''}`}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="spacer" />
        <button
          className="nav-item"
          onClick={() => {
            api.signOut();
            setSignedIn(false);
          }}
        >
          Sign out
        </button>
      </nav>
      <main className="main">{active.render()}</main>
    </div>
  );
}
