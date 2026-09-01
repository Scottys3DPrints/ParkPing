import { api } from '../api.js';
import { formatDateTime, useAsync } from '../hooks.js';

/**
 * Audit trail.
 *
 * Deliberately shows the metadata verbatim: the value of an audit log is that
 * a reviewer sees exactly what was recorded. The write path is what guarantees
 * there is nothing sensitive in it (see AuditService), not a filter here.
 */
export function AuditLog(): JSX.Element {
  const { data, error, loading } = useAsync(() => api.audit(150), []);

  return (
    <>
      <h1>Audit log</h1>
      <p className="subtitle">
        Security-relevant actions, most recent first. Retained for {180} days, then purged.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="card">
        {loading && !data ? (
          <div className="empty">Loading…</div>
        ) : !data || data.events.length === 0 ? (
          <div className="empty">No events recorded.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Subject</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                <tr key={event.id}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {formatDateTime(event.created_at)}
                  </td>
                  <td>{event.action}</td>
                  <td>
                    <span className={`badge ${event.actor_type === 'system' ? 'system' : ''}`}>
                      {event.actor_type}
                    </span>
                  </td>
                  <td className="mono">
                    {event.subject_type ? `${event.subject_type} ${event.subject_id?.slice(0, 8) ?? ''}` : '—'}
                  </td>
                  <td className="mono">
                    {Object.keys(event.metadata ?? {}).length > 0 ? JSON.stringify(event.metadata) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
