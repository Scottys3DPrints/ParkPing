import { useState } from 'react';
import { ApiError, api, isSignedIn } from '../api.js';
import type { Catalog } from '../types.js';
import { navigate } from '../router.js';
import { Report } from './Report.js';

/**
 * The entry point for someone who needs to reach a driver.
 *
 * The sticker path leads. Plate entry is offered second and behind a
 * sign-in, because it is the enumerable one — that asymmetry is the whole of
 * project document v0.2 §3.3, expressed as page order.
 */
export function Home({ catalog }: { catalog: Catalog | null }): JSX.Element {
  const [code, setCode] = useState('');
  const [plate, setPlate] = useState('');
  const [country, setCountry] = useState('DE');
  const [showPlate, setShowPlate] = useState(false);
  const [reportingPlate, setReportingPlate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function openSticker(): Promise<void> {
    const cleaned = code.replace(/[^0-9A-Za-z]/g, '');
    if (cleaned.length < 6) {
      setError('A sticker code is ten characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.scanSticker(cleaned);
      navigate(`/s/${cleaned.toUpperCase()}`);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? 'No sticker with that code. Check the characters.'
          : 'Could not look that up.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (reportingPlate) {
    return (
      <Report
        catalog={catalog}
        target={{ kind: 'plate', value: plate.trim(), country }}
        onCancel={() => setReportingPlate(false)}
      />
    );
  }

  const example = catalog?.countries.find((c) => c.code === country)?.example ?? 'M AB 1234';

  return (
    <div className="stack">
      <h1>Reach the driver, not the tow truck</h1>
      <p className="lede">
        Blocked in? Lights left on? Tell the driver in seconds — without either of you learning who the
        other is.
      </p>

      {error && <div className="notice error">{error}</div>}

      <div className="card">
        <h2>Scan or type the sticker</h2>
        <p className="muted">
          Point your camera at the ParkPing sticker on the windscreen, or type the code beneath it.
        </p>
        <input
          className="code"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="ABCD-EFGH-JK"
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={14}
          aria-label="Sticker code"
        />
        <button
          className="primary block"
          disabled={busy || code.length < 6}
          onClick={() => void openSticker()}
        >
          {busy ? <span className="spinner" /> : 'Continue'}
        </button>
      </div>

      {showPlate ? (
        <div className="card">
          <h2>No sticker on the car?</h2>
          <p className="muted">
            You can try the license plate instead. It only works if the driver registered it, and it needs
            an account — plates can be guessed, sticker codes cannot.
          </p>
          <label className="field">
            <span>License plate</span>
            <input
              className="code"
              value={plate}
              onChange={(event) => setPlate(event.target.value.toUpperCase())}
              placeholder={example}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={24}
            />
          </label>
          <div className="wrap">
            {(catalog?.countries ?? [{ code: 'DE', example: '' }]).map((option) => (
              <button
                key={option.code}
                className="chip"
                aria-pressed={country === option.code}
                onClick={() => setCountry(option.code)}
              >
                {option.code}
              </button>
            ))}
          </div>
          <button
            className="primary block"
            disabled={plate.trim().length < 3}
            onClick={() => {
              if (isSignedIn()) setReportingPlate(true);
              else navigate('/signin?next=%2Fplate');
            }}
          >
            {isSignedIn() ? 'Continue' : 'Sign in to report by plate'}
          </button>
        </div>
      ) : (
        <button className="quiet" onClick={() => setShowPlate(true)}>
          No sticker on the car? Try the license plate →
        </button>
      )}

      <div className="card">
        <h2>Is this your car?</h2>
        <p className="muted">
          Put a sticker on your windscreen and people can tell you about a problem before it becomes a tow
          truck. We never publish your plate, your name, or your number.
        </p>
        <button className="block" onClick={() => navigate(isSignedIn() ? '/me' : '/signin')}>
          {isSignedIn() ? 'My ParkPing' : 'Set up my vehicle'}
        </button>
      </div>
    </div>
  );
}
