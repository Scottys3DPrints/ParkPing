import { useState } from 'react';
import { api } from '../api.js';
import { formatDateTime, useAsync } from '../hooks.js';

/**
 * Contested plate claims.
 *
 * Two accounts claiming one plate is expected — a car changes hands, a pool
 * vehicle moves between employees. The incumbent keeps routing until a human
 * decides, so the failure mode is "the new owner waits", not "a stranger
 * starts receiving someone else's alerts".
 *
 * Note that the plate itself is never shown. A reviewer decides on the shape
 * of the claim (when, how many competing claims, how the vehicle was verified),
 * which keeps this console from becoming the lookup table the product refuses
 * to be. A genuine dispute is resolved with the account holders directly.
 */
export function Claims(): JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, error, loading, reload } = useAsync(() => api.contestedVehicles(), []);

  async function approve(vehicleId: string): Promise<void> {
    setBusyId(vehicleId);
    setActionError(null);
    try {
      await api.approveClaim(vehicleId);
      reload();
    } catch {
      setActionError('Could not approve that claim.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <h1>Contested vehicle claims</h1>
      <p className="subtitle">
        A second account tried to register a plate that is already routing. Approving moves routing to the
        newer claim and suspends the incumbent.
      </p>

      {error && <div className="error">{error}</div>}
      {actionError && <div className="error">{actionError}</div>}

      <div className="card">
        {loading && !data ? (
          <div className="empty">Loading…</div>
        ) : !data || data.vehicles.length === 0 ? (
          <div className="empty">No contested claims.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Claim</th>
                <th>Country</th>
                <th>Competing claims</th>
                <th>Submitted</th>
                <th style={{ width: 170 }} />
              </tr>
            </thead>
            <tbody>
              {data.vehicles.map((vehicle) => (
                <tr key={vehicle.vehicleId}>
                  <td className="mono">{vehicle.vehicleId.slice(0, 8)}</td>
                  <td>{vehicle.country}</td>
                  <td>
                    <span className={`badge ${vehicle.competingClaims > 2 ? 'alarm' : ''}`}>
                      {vehicle.competingClaims}
                    </span>
                  </td>
                  <td className="mono">{formatDateTime(vehicle.createdAt)}</td>
                  <td>
                    <button
                      className="primary"
                      disabled={busyId === vehicle.vehicleId}
                      onClick={() => void approve(vehicle.vehicleId)}
                    >
                      Approve this claim
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
