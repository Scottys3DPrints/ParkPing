import { useState } from 'react';
import { api } from '../api.js';
import { formatDuration, formatPercent, useAsync } from '../hooks.js';

const CATEGORY_LABELS: Record<string, string> = {
  entrance_blocked: 'Entrance blocked',
  vehicle_blocked: 'Vehicle blocked',
  private_space_occupied: 'Private space occupied',
  please_move: 'Please move',
  lights_left_on: 'Lights left on',
  window_or_door_open: 'Window / door open',
  visible_vehicle_issue: 'Visible issue',
  safety_issue_other: 'Other safety issue',
};

function Kpi({ label, value, note }: { label: string; value: string; note?: string }): JSX.Element {
  return (
    <div className="card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

/**
 * The KPI set from project document §11.
 *
 * Match rate is given the most prominent note because it is the number that
 * decides whether the network is worth anything in a given site — a perfect
 * delivery rate over a 5% match rate still means the product does not work
 * there.
 */
export function Dashboard(): JSX.Element {
  const [windowDays, setWindowDays] = useState(30);
  const { data, error, loading } = useAsync(() => api.metrics(windowDays), [windowDays]);

  if (loading && !data) return <div className="empty">Loading metrics…</div>;
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="empty">No data.</div>;

  const { metrics, alertsByDay, categories } = data;
  const peak = Math.max(1, ...alertsByDay.map((d) => d.submitted));

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>Network health</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Across every organization and consumer account.
          </p>
        </div>
        <div className="spacer" />
        <select
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          style={{ width: 150 }}
          aria-label="Reporting window"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="kpi-grid">
        <Kpi
          label="Local match rate"
          value={formatPercent(metrics.localMatchRate)}
          note="Share of alerts that found a registered vehicle"
        />
        <Kpi label="Registered vehicles" value={String(metrics.registeredVehicles)} note={`${metrics.activeVehicles} routable`} />
        <Kpi label="Alerts submitted" value={String(metrics.alertsSubmitted)} note={`Last ${windowDays} days`} />
        <Kpi label="Delivery rate" value={formatPercent(metrics.deliveryRate)} note="Pushes that reached a device" />
        <Kpi label="Response rate" value={formatPercent(metrics.responseRate)} note="Of delivered alerts" />
        <Kpi
          label="Median response"
          value={formatDuration(metrics.medianResponseTimeSeconds)}
          note="Alert to first reply"
        />
        <Kpi label="30-day retention" value={formatPercent(metrics.retention30d)} note="Accounts still active" />
        <Kpi label="90-day retention" value={formatPercent(metrics.retention90d)} note="Accounts still active" />
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="kpi-label">Alerts per day</div>
        <div className="chart">
          {alertsByDay.length === 0 ? (
            <div className="empty" style={{ width: '100%' }}>
              No alerts in this window.
            </div>
          ) : (
            alertsByDay.map((day) => (
              <div className="chart-col" key={day.day} title={`${day.day}: ${day.routed}/${day.submitted} routed`}>
                <div
                  className="bar-missed"
                  style={{ height: `${((day.submitted - day.routed) / peak) * 110}px` }}
                />
                <div className="bar-routed" style={{ height: `${(day.routed / peak) * 110}px` }} />
              </div>
            ))
          )}
        </div>
        <div className="legend">
          <span>
            <i className="bar-routed" style={{ background: 'var(--accent)' }} />
            Routed
          </span>
          <span>
            <i style={{ background: 'var(--surface-2)' }} />
            No registered vehicle
          </span>
        </div>
      </div>

      <div className="card">
        <div className="kpi-label" style={{ marginBottom: 12 }}>
          Incident mix
        </div>
        {categories.length === 0 ? (
          <div className="empty">Nothing reported yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ width: 90 }}>Count</th>
                <th style={{ width: 90 }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((row) => (
                <tr key={row.category}>
                  <td>{CATEGORY_LABELS[row.category] ?? row.category}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.count}</td>
                  <td className="mono">
                    {metrics.alertsSubmitted > 0
                      ? `${((row.count / metrics.alertsSubmitted) * 100).toFixed(0)}%`
                      : '—'}
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
