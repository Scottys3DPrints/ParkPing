import { useState } from 'react';
import { api } from '../api.js';
import { formatDateTime, useAsync } from '../hooks.js';

const REASON_LABELS: Record<string, string> = {
  harassment: 'Harassment',
  wrong_vehicle: 'Wrong vehicle',
  spam: 'Spam',
  false_report: 'False report',
  other: 'Other',
};

const ACTIONS: Array<{ id: string; label: string; description: string }> = [
  { id: 'none', label: 'No action', description: 'Close without enforcement' },
  { id: 'throttle_reporter', label: 'Throttle 24h', description: 'Reporter is rate-limited for a day' },
  { id: 'suspend_reporter', label: 'Suspend account', description: 'Reporter can no longer sign in' },
  { id: 'suspend_vehicle', label: 'Suspend vehicle', description: 'Stops routing to that vehicle' },
];

/**
 * The moderation queue. Both human reports and system flags land here.
 *
 * The two "last 24h" columns are the context that makes a decision possible
 * without exposing identities: a report against someone who sent 3 alerts to 3
 * plates reads very differently from one against someone who sent 40 to 38.
 */
export function AbuseQueue(): JSX.Element {
  const [status, setStatus] = useState('open');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, error, loading, reload } = useAsync(() => api.abuseReports(status), [status]);

  async function resolve(reportId: string, action: string): Promise<void> {
    setBusyId(reportId);
    setActionError(null);
    try {
      await api.resolveReport(reportId, action === 'none' ? 'dismissed' : 'actioned', action);
      reload();
    } catch {
      setActionError('Could not apply that action.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>Abuse & moderation</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Reports from users, and patterns the system flagged on its own.
          </p>
        </div>
        <div className="spacer" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }} aria-label="Filter">
          <option value="open">Open</option>
          <option value="reviewing">Reviewing</option>
          <option value="actioned">Actioned</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">All</option>
        </select>
      </div>

      {error && <div className="error">{error}</div>}
      {actionError && <div className="error">{actionError}</div>}

      <div className="card">
        {loading && !data ? (
          <div className="empty">Loading…</div>
        ) : !data || data.reports.length === 0 ? (
          <div className="empty">Nothing in this queue.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Reason</th>
                <th>Source</th>
                <th>Subject activity (24h)</th>
                <th>Raised</th>
                <th style={{ width: 300 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((report) => (
                <tr key={report.id}>
                  <td>{REASON_LABELS[report.reason] ?? report.reason}</td>
                  <td>
                    <span className={`badge ${report.source === 'system' ? 'system' : ''}`}>{report.source}</span>
                  </td>
                  <td className="mono">
                    {report.subjectUserId
                      ? `${report.subjectAlertsLast24h} alerts · ${report.subjectDistinctTargetsLast24h} plates`
                      : '—'}
                  </td>
                  <td className="mono">{formatDateTime(report.createdAt)}</td>
                  <td>
                    {report.status === 'open' || report.status === 'reviewing' ? (
                      <div className="row wrap">
                        {ACTIONS.map((action) => (
                          <button
                            key={action.id}
                            title={action.description}
                            className={action.id === 'suspend_reporter' ? 'danger' : ''}
                            disabled={busyId === report.id}
                            onClick={() => void resolve(report.id, action.id)}
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="badge">{report.status}</span>
                    )}
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
