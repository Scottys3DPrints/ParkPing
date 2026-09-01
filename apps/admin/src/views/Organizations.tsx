import { useState } from 'react';
import { api } from '../api.js';
import { formatDateTime, useAsync } from '../hooks.js';

/**
 * Organization verification.
 *
 * Verification is what allows an organization's name to appear on a
 * notification sent to a stranger ("Reported via Nordpark Campus"). That is a
 * borrowed-authority risk, so it stays a deliberate human decision rather than
 * a self-service switch.
 */
export function Organizations(): JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, error, loading, reload } = useAsync(() => api.organizations(), []);

  async function toggle(organizationId: string, verified: boolean): Promise<void> {
    setBusyId(organizationId);
    setActionError(null);
    try {
      await api.setVerified(organizationId, verified);
      reload();
    } catch {
      setActionError('Could not update that organization.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <h1>Organizations</h1>
      <p className="subtitle">
        Pilot sites and B2B customers. Verify only after confirming the organization is who it claims to be.
      </p>

      {error && <div className="error">{error}</div>}
      {actionError && <div className="error">{actionError}</div>}

      <div className="card">
        {loading && !data ? (
          <div className="empty">Loading…</div>
        ) : !data || data.organizations.length === 0 ? (
          <div className="empty">No organizations yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Created</th>
                <th style={{ width: 130 }} />
              </tr>
            </thead>
            <tbody>
              {data.organizations.map((org) => (
                <tr key={org.id}>
                  <td>{org.name}</td>
                  <td className="mono">{org.slug}</td>
                  <td>
                    <span className="badge">{org.plan}</span>
                  </td>
                  <td>
                    <span className={`badge ${org.verified ? 'ok' : ''}`}>
                      {org.verified ? 'verified' : 'unverified'}
                    </span>
                  </td>
                  <td className="mono">{formatDateTime(org.createdAt)}</td>
                  <td>
                    <button
                      className={org.verified ? 'danger' : 'primary'}
                      disabled={busyId === org.id}
                      onClick={() => void toggle(org.id, !org.verified)}
                    >
                      {org.verified ? 'Revoke' : 'Verify'}
                    </button>
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
