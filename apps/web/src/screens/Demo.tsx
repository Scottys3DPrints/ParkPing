import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { navigate } from '../router.js';

/**
 * The demo console.
 *
 * The most important thing to see when evaluating ParkPing is the message a
 * driver actually receives, and in a real deployment that leaves through
 * WhatsApp or SMS where an observer cannot follow it. This page shows what the
 * demo transports rendered, which makes the whole loop inspectable without a
 * Meta business account.
 *
 * The API only mounts these endpoints outside production.
 */
export function Demo(): JSX.Element {
  const [messages, setMessages] = useState<
    Array<{ id: string; kind: string; status: string; preview: string | null; reference: string; createdAt: string }>
  >([]);
  const [stickers, setStickers] = useState<Array<{ code: string; status: string; label: string | null }>>([]);
  const [users, setUsers] = useState<Array<{ contact_masked: string; role: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [outbox, state] = await Promise.all([api.outbox(), api.demoState()]);
      setMessages(outbox.messages);
      setStickers(state.stickers);
      setUsers(state.users);
      setError(null);
    } catch {
      setError('Demo endpoints are unavailable. They are disabled in production.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="stack">
      <h1>Demo console</h1>
      <p className="lede">
        Everything a walkthrough needs. Messages refresh every few seconds, so you can send an alert on a
        phone and watch it arrive here.
      </p>

      {error && <div className="notice error">{error}</div>}

      <div className="card">
        <h2>Stickers you can scan</h2>
        <p className="muted">Open one on a phone, or type the code on the home screen.</p>
        {stickers.map((sticker) => (
          <div className="row" key={sticker.code}>
            <button className="chip mono grow" onClick={() => navigate(`/s/${sticker.code}`)}>
              {sticker.code}
            </button>
            <span className={`badge ${sticker.status === 'active' ? 'ok' : ''}`}>
              {sticker.label ?? sticker.status}
            </span>
          </div>
        ))}
        {stickers.length === 0 && <p className="muted">None seeded. Run `npm run seed`.</p>}
      </div>

      <div className="card">
        <h2>Accounts</h2>
        <p className="muted">
          Sign in with any of these. The six-digit code appears on screen while demo mode is on.
        </p>
        {users.map((user) => (
          <div className="row" key={user.contact_masked}>
            <span className="grow mono">{user.contact_masked}</span>
            {user.role === 'platform_admin' && <span className="badge warn">admin</span>}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Outbox — what drivers received</h2>
        <p className="muted">
          These are the real rendered notifications. In production they leave over WhatsApp or SMS and are
          never stored.
        </p>
        {messages.length === 0 && <p className="muted">Nothing sent yet. Send an alert to a sticker.</p>}
        {messages.map((message) => (
          <div className="card" key={message.id} style={{ background: 'var(--surface-alt)' }}>
            <div className="row">
              <span className="badge">{message.kind}</span>
              <span className={`badge ${message.status === 'sent' ? 'ok' : 'danger'}`}>{message.status}</span>
              <span className="grow" />
              <span className="muted mono">{message.reference}</span>
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                fontSize: '0.9rem',
                fontFamily: 'inherit',
              }}
            >
              {message.preview}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
