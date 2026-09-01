import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, ensureSession } from '../api.js';
import type { Catalog, SentAlertDto } from '../types.js';
import { navigate } from '../router.js';

/**
 * What a reporter is allowed to know about their own reports.
 *
 * `processed` never becomes `delivered`, because the API does not tell us and
 * must not. A reply appears only when the driver chose to send one.
 */
export function Sent({ catalog }: { catalog: Catalog | null }): JSX.Element {
  const [alerts, setAlerts] = useState<SentAlertDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureSession();
      const result = await api.sentAlerts();
      setAlerts(result.alerts);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your reports.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const label = (id: string | null, list: 'categories' | 'responses'): string =>
    id ? (catalog?.[list].find((entry) => entry.id === id)?.label.en ?? id.replace(/_/g, ' ')) : '';

  return (
    <div className="stack">
      <h1>My reports</h1>
      <p className="lede">Reports you sent, and any replies the drivers chose to send back.</p>

      {error && <div className="notice error">{error}</div>}

      {loading ? (
        <div className="center" style={{ padding: '2rem' }}>
          <span className="spinner" />
        </div>
      ) : alerts.length === 0 ? (
        <>
          <p className="muted center" style={{ padding: '2rem 0' }}>
            You have not reported a vehicle yet.
          </p>
          <button className="primary block" onClick={() => navigate('/')}>
            Reach a driver
          </button>
        </>
      ) : (
        alerts.map((alert) => (
          <div className="card" key={alert.id}>
            <div className="row">
              <h2 className="grow mono">{alert.target}</h2>
              <span className="badge">{alert.source}</span>
            </div>
            <p className="muted">{label(alert.category, 'categories')}</p>
            {alert.response ? (
              <div className="notice ok">Driver replied: {label(alert.response, 'responses')}</div>
            ) : (
              <p className="muted">Processed · no reply yet</p>
            )}
            <span className="muted mono">{alert.reference}</span>
          </div>
        ))
      )}
    </div>
  );
}
