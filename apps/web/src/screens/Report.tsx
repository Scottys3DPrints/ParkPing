import { useMemo, useState } from 'react';
import { ApiError, api } from '../api.js';
import type { Catalog } from '../types.js';
import { navigate } from '../router.js';

interface ReportTarget {
  kind: 'sticker' | 'plate';
  /** Sticker code, or the plate as typed. */
  value: string;
  country?: string;
  /** The owner's own name for the car, when a sticker exposed one. */
  label?: string | null;
  organizationName?: string | null;
}

/**
 * The reporter flow (project document v0.2 §4.1).
 *
 * Two taps from a scan to a sent alert. No account, no install, no free text.
 * The confirmation is deliberately uninformative — the API cannot tell us
 * whether the car was reachable, and the copy must not imply it did, or this
 * screen becomes the plate-lookup oracle the whole design avoids.
 */
export function Report({
  catalog,
  target,
  onCancel,
}: {
  catalog: Catalog | null;
  target: ReportTarget;
  onCancel: () => void;
}): JSX.Element {
  const [category, setCategory] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  const selected = useMemo(
    () => catalog?.categories.find((c) => c.id === category) ?? null,
    [catalog, category],
  );

  async function send(): Promise<void> {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.submitAlert({
        ...(target.kind === 'sticker'
          ? { stickerCode: target.value }
          : { plate: target.value, country: target.country }),
        category,
        timeframe: selected?.allowsTimeframe ? timeframe : null,
      });
      setReference(result.reference);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send that report.');
    } finally {
      setBusy(false);
    }
  }

  if (reference) {
    return (
      <div className="stack">
        <h1>Report sent</h1>
        <div className="notice ok">
          Your report has been processed. If this vehicle is in the ParkPing network, its driver has been
          notified.
        </div>
        <div className="card">
          <span className="muted">Reference</span>
          <strong className="mono" style={{ fontSize: '1.25rem' }}>
            {reference}
          </strong>
          <p className="muted">
            Keep this if you need to contact support. You will see a reply here if the driver chooses to
            send one — we cannot tell you anything else about them.
          </p>
        </div>
        <button className="primary block" onClick={() => navigate('/sent')}>
          See replies
        </button>
        <button className="block" onClick={() => navigate('/')}>
          Report another vehicle
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>What is the problem?</h1>
      <p className="lede">
        {target.kind === 'sticker' ? (
          <>
            Reporting {target.label ? <strong>{target.label}</strong> : 'this vehicle'}
            {target.organizationName ? ` at ${target.organizationName}` : ''}. The driver never learns who
            you are.
          </>
        ) : (
          <>
            Reporting <strong>{target.value}</strong>. The driver never learns who you are, and you never
            learn who they are.
          </>
        )}
      </p>

      {error && <div className="notice error">{error}</div>}

      <div className="stack" role="group" aria-label="Reason">
        {(catalog?.categories ?? []).map((option) => (
          <button
            key={option.id}
            className="choice"
            aria-pressed={category === option.id}
            onClick={() => {
              setCategory(option.id);
              if (!option.allowsTimeframe) setTimeframe(null);
            }}
          >
            {option.label.en}
          </button>
        ))}
      </div>

      {selected?.allowsTimeframe && (
        <div className="card">
          <h2>How urgent is it for you?</h2>
          <div className="wrap">
            {(catalog?.timeframes ?? []).map((option) => (
              <button
                key={option.id}
                className="chip"
                aria-pressed={timeframe === option.id}
                onClick={() => setTimeframe(timeframe === option.id ? null : option.id)}
              >
                {option.id.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <p className="muted">
            This is passed on as your request, not as a deadline. ParkPing does not grant deadlines and
            cannot enforce one.
          </p>
        </div>
      )}

      <button className="primary block" disabled={busy || !category} onClick={() => void send()}>
        {busy ? <span className="spinner" /> : 'Send alert'}
      </button>
      <button className="quiet" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export type { ReportTarget };
