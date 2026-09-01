import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.js';
import type { Catalog } from '../types.js';
import { navigate } from '../router.js';

export function SignIn({ catalog, onSignedIn }: { catalog: Catalog | null; onSignedIn: () => void }): JSX.Element {
  const [step, setStep] = useState<'contact' | 'code'>('contact');
  const [channel, setChannel] = useState<'email' | 'phone'>('email');
  const [destination, setDestination] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const next = new URLSearchParams(window.location.search).get('next') ?? '/me';

  async function sendCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.requestCode(channel, destination.trim());
      setDevCode(result.devCode ?? null);
      setStep('code');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send a code.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.verifyCode(channel, destination.trim(), code.trim(), catalog?.consentVersion ?? '');
      onSignedIn();
      navigate(next);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not verify that code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>Sign in</h1>
      <p className="lede">
        No password. We send a six-digit code, and use your address only to reach you about your own
        vehicle.
      </p>

      {error && <div className="notice error">{error}</div>}

      {step === 'contact' ? (
        <form className="card" onSubmit={sendCode}>
          <div className="wrap">
            {(['email', 'phone'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="chip"
                aria-pressed={channel === option}
                onClick={() => setChannel(option)}
              >
                {option === 'email' ? 'Email' : 'Phone'}
              </button>
            ))}
          </div>
          <label className="field">
            <span>{channel === 'email' ? 'Email address' : 'Mobile number'}</span>
            <input
              type={channel === 'email' ? 'email' : 'tel'}
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder={channel === 'email' ? 'you@example.com' : '+4915112345678'}
              autoComplete={channel === 'email' ? 'email' : 'tel'}
              autoCapitalize="none"
              required
            />
          </label>
          <button className="primary block" type="submit" disabled={busy || destination.trim().length < 4}>
            {busy ? <span className="spinner" /> : 'Send code'}
          </button>
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <label className="field">
            <span>Code sent to {destination}</span>
            <input
              className="code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              autoFocus
              required
            />
          </label>
          <button className="primary block" type="submit" disabled={busy || code.length !== 6}>
            {busy ? <span className="spinner" /> : 'Sign in'}
          </button>
          <button type="button" className="quiet" onClick={() => setStep('contact')}>
            Use a different address
          </button>
          {devCode && (
            <div className="notice warn">
              Demo mode — your code is <strong className="mono">{devCode}</strong>
            </div>
          )}
        </form>
      )}

      {catalog && (
        <p className="muted center">
          Signing in accepts the terms and privacy notice, version {catalog.consentVersion}.
        </p>
      )}
    </div>
  );
}
