import { useEffect, useState } from 'react';
import { api, ensureSession, isSignedIn } from './api.js';
import type { Catalog } from './types.js';
import { navigate, useRoute } from './router.js';
import { Home } from './screens/Home.js';
import { Sticker } from './screens/Sticker.js';
import { SignIn } from './screens/SignIn.js';
import { Mine } from './screens/Mine.js';
import { Sent } from './screens/Sent.js';
import { Demo } from './screens/Demo.js';

export function App(): JSX.Element {
  const route = useRoute();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [signedIn, setSignedIn] = useState(isSignedIn());

  useEffect(() => {
    // The catalog drives every selectable value, so a category can be
    // withdrawn without redeploying this app.
    void api
      .catalog()
      .then(setCatalog)
      .catch(() => undefined);

    // A visitor gets a session before they need one, so the first tap in the
    // reporter flow is never blocked on a round trip.
    void ensureSession().catch(() => undefined);
  }, []);

  useEffect(() => {
    setSignedIn(isSignedIn());
  }, [route]);

  return (
    <div className="shell">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
        >
          Park<span>Ping</span>
        </a>
        <span className="spacer" />
        {signedIn ? (
          <button
            className="quiet"
            onClick={() => {
              api.signOut();
              setSignedIn(false);
              navigate('/');
            }}
          >
            Sign out
          </button>
        ) : (
          <button className="quiet" onClick={() => navigate('/signin')}>
            Sign in
          </button>
        )}
      </header>

      <main className="grow">
        {route.name === 'home' && <Home catalog={catalog} />}
        {route.name === 'plate' && <Home catalog={catalog} />}
        {route.name === 'sticker' && <Sticker code={route.code} catalog={catalog} />}
        {route.name === 'signin' && <SignIn catalog={catalog} onSignedIn={() => setSignedIn(true)} />}
        {route.name === 'mine' && <Mine catalog={catalog} />}
        {route.name === 'sent' && <Sent catalog={catalog} />}
        {route.name === 'demo' && <Demo />}
      </main>

      <nav className="tabbar">
        <button aria-current={route.name === 'home' ? 'page' : undefined} onClick={() => navigate('/')}>
          Report
        </button>
        <button aria-current={route.name === 'sent' ? 'page' : undefined} onClick={() => navigate('/sent')}>
          My reports
        </button>
        <button
          aria-current={route.name === 'mine' ? 'page' : undefined}
          onClick={() => navigate(signedIn ? '/me' : '/signin')}
        >
          My vehicles
        </button>
      </nav>
    </div>
  );
}
