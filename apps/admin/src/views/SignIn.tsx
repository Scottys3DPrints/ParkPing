import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.js';

export function SignIn({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitEmail(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.requestCode(email.trim());
      // Development convenience: the API echoes the code when OTP_ECHO is on,
      // so the console is usable without an email provider configured.
      setDevCode(result.devCode ?? null);
      setStep('code');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send a code.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { role } = await api.verifyCode(email.trim(), code.trim());
      if (role !== 'platform_admin') {
        api.signOut();
        setError('That account is not a platform administrator.');
        return;
      }
      onSignedIn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not verify that code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sign-in">
      <div className="card">
        <div className="brand" style={{ padding: '0 0 14px' }}>
          Park<span>Ping</span> Console
        </div>
        {error && <div className="error">{error}</div>}

        {step === 'email' ? (
          <form onSubmit={submitEmail}>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@parkping.test"
              />
            </div>
            <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Sending…' : 'Send sign-in code'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <div className="field">
              <label htmlFor="code">Six-digit code sent to {email}</label>
              <input
                id="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
              />
            </div>
            <div className="row">
              <button type="button" onClick={() => setStep('email')} disabled={busy}>
                Back
              </button>
              <button className="primary" type="submit" disabled={busy || code.length !== 6} style={{ flex: 1 }}>
                {busy ? 'Checking…' : 'Sign in'}
              </button>
            </div>
            {devCode && (
              <p className="hint">
                Development mode — your code is <strong className="mono">{devCode}</strong>
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
