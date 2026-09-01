import { useEffect, useState } from 'react';
import { ApiError, api, isSignedIn } from '../api.js';
import type { Catalog, StickerScanDto } from '../types.js';
import { navigate } from '../router.js';
import { Report } from './Report.js';

/**
 * What happens when a camera sees a windscreen (project document v0.2 §3.1).
 *
 * This screen is the whole argument for the sticker model: a stranger arrives
 * here with no account, no app and no prior relationship, and within one tap
 * they can either help the driver or learn that this particular car is not set
 * up yet. Nothing about the owner is revealed either way.
 */
export function Sticker({ code, catalog }: { code: string; catalog: Catalog | null }): JSX.Element {
  const [sticker, setSticker] = useState<StickerScanDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reporting, setReporting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .scanSticker(code)
      .then((result) => {
        if (!cancelled) setSticker(result.sticker);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof ApiError && caught.status === 404
              ? 'That sticker code does not exist. Check the characters and try again.'
              : 'Could not read that sticker.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function claim(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.claimSticker(code, label.trim() || null);
      navigate('/me');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not claim that sticker.');
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="stack center" style={{ paddingTop: '3rem' }}>
        <span className="spinner" />
      </div>
    );
  }

  if (error && !sticker) {
    return (
      <div className="stack">
        <h1>Sticker not found</h1>
        <div className="notice error">{error}</div>
        <button className="primary block" onClick={() => navigate('/')}>
          Try another way
        </button>
      </div>
    );
  }

  if (!sticker) return <div className="notice error">Something went wrong.</div>;

  if (reporting) {
    return (
      <Report
        catalog={catalog}
        target={{
          kind: 'sticker',
          value: code,
          label: sticker.label,
          organizationName: sticker.organizationName,
        }}
        onCancel={() => setReporting(false)}
      />
    );
  }

  // --- The owner scanning their own sticker -------------------------------
  if (sticker.ownedByViewer) {
    return (
      <div className="stack">
        <h1>This is your sticker</h1>
        <p className="lede">
          {sticker.label ? `${sticker.label} — ` : ''}anyone who scans it can reach you without seeing who
          you are.
        </p>
        <button className="primary block" onClick={() => navigate('/me')}>
          Manage my ParkPing
        </button>
      </div>
    );
  }

  // --- An unclaimed sticker ------------------------------------------------
  if (sticker.status === 'unclaimed') {
    return (
      <div className="stack">
        <h1>Not set up yet</h1>
        <p className="lede">
          This sticker exists but nobody has claimed it, so there is no one to notify. If it is on your
          car, claim it now and you will be reachable from the next scan on.
        </p>

        {error && <div className="notice error">{error}</div>}

        {claiming ? (
          <div className="card">
            <label className="field">
              <span>Name this vehicle (optional)</span>
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Blue Golf"
                maxLength={40}
                autoFocus
              />
            </label>
            <p className="muted">
              Only you see this name. It appears in your own alerts so you know which car is meant.
            </p>
            <button className="primary block" disabled={busy} onClick={() => void claim()}>
              {busy ? <span className="spinner" /> : 'Claim this sticker'}
            </button>
          </div>
        ) : (
          <button
            className="primary block"
            onClick={() => {
              if (isSignedIn()) setClaiming(true);
              else navigate(`/signin?next=${encodeURIComponent(`/s/${code}`)}`);
            }}
          >
            This is my car — claim it
          </button>
        )}

        <div className="card">
          <span className="badge mono">{sticker.code}</span>
          <p className="muted">
            Not your car? There is nothing to do here. We cannot tell you who it belongs to — that is the
            point.
          </p>
        </div>
      </div>
    );
  }

  if (sticker.status === 'disabled') {
    return (
      <div className="stack">
        <h1>This sticker is paused</h1>
        <p className="lede">
          Its owner turned it off, or it was reported as being on the wrong car. Nothing will be delivered.
        </p>
        <button className="block" onClick={() => navigate('/')}>
          Back
        </button>
      </div>
    );
  }

  // --- The normal case: an active sticker, a stranger holding a phone ------
  return (
    <div className="stack">
      <h1>Reach this driver</h1>
      <p className="lede">
        {sticker.label ? (
          <>
            This is <strong>{sticker.label}</strong>. Its driver
          </>
        ) : (
          <>This vehicle&rsquo;s driver</>
        )}{' '}
        gets a notification in seconds. You stay anonymous, and so do they.
      </p>

      {sticker.organizationName && (
        <div className="notice ok">Registered through {sticker.organizationName}</div>
      )}

      <button className="primary block" onClick={() => setReporting(true)}>
        Send an alert
      </button>

      <div className="card">
        <div className="row">
          <span className="badge mono">{sticker.code}</span>
          <span className="badge ok">reachable</span>
        </div>
        <p className="muted">
          No account needed. You will be able to see a reply if the driver sends one.
        </p>
      </div>
    </div>
  );
}
