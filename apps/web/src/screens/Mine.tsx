import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ApiError, api } from '../api.js';
import type {
  Catalog,
  NotificationChannelDto,
  ReceivedAlertDto,
  StickerDto,
  VehicleDto,
} from '../types.js';
import { navigate } from '../router.js';

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function labelFor(catalog: Catalog | null, list: 'categories' | 'responses', id: string | null): string {
  if (!id) return '';
  return catalog?.[list].find((entry) => entry.id === id)?.label.en ?? id.replace(/_/g, ' ');
}

/** The printable sticker: a QR to /s/<code>, plus the code in readable form. */
function StickerCard({
  sticker,
  onChanged,
}: {
  sticker: StickerDto;
  onChanged: () => void;
}): JSX.Element {
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `${window.location.origin}/s/${sticker.code.replace(/-/g, '')}`;

  useEffect(() => {
    let cancelled = false;
    // Rendered client-side so a sticker code never travels to an image service.
    void QRCode.toDataURL(url, { margin: 1, width: 304, errorCorrectionLevel: 'M' })
      .then((data) => {
        if (!cancelled) setQr(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row">
        <h2 className="grow">{sticker.label ?? 'Unnamed vehicle'}</h2>
        <span className={`badge ${sticker.status === 'active' ? 'ok' : 'warn'}`}>
          {sticker.status === 'active' ? 'reachable' : sticker.status}
        </span>
      </div>

      {qr && (
        <div className="qr">
          <img src={qr} alt={`QR code linking to sticker ${sticker.code}`} />
        </div>
      )}

      <span className="badge mono">{sticker.code}</span>
      {sticker.organizationName && <p className="muted">Issued by {sticker.organizationName}</p>}
      <p className="muted">
        Print this and put it inside the windscreen. Anyone who scans it can reach you; nobody learns who
        you are.
      </p>

      <div className="row">
        <button
          disabled={busy}
          onClick={() =>
            void act(() =>
              api.updateSticker(sticker.id, {
                status: sticker.status === 'active' ? 'disabled' : 'active',
              }),
            )
          }
        >
          {sticker.status === 'active' ? 'Pause' : 'Reactivate'}
        </button>
        <button className="danger" disabled={busy} onClick={() => void act(() => api.releaseSticker(sticker.id))}>
          Release
        </button>
      </div>
    </div>
  );
}

function AlertCard({
  alert,
  catalog,
  onChanged,
}: {
  alert: ReceivedAlertDto;
  catalog: Catalog | null;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row">
        <h2 className="grow">{labelFor(catalog, 'categories', alert.category)}</h2>
        <span className="muted">{relativeTime(alert.createdAt)}</span>
      </div>
      <p className="muted">
        About {alert.targetLabel}
        {alert.locationLabel ? ` · ${alert.locationLabel}` : ''}
      </p>

      <div className="wrap">
        <span className="badge">Sender {alert.reporterHandle}</span>
        {alert.reporterIsVerifiedOrganization && alert.organizationName && (
          <span className="badge ok">via {alert.organizationName}</span>
        )}
        {alert.timeframe && <span className="badge">asked: {alert.timeframe.replace(/_/g, ' ')}</span>}
      </div>

      {error && <div className="notice error">{error}</div>}

      {alert.response ? (
        <div className="notice ok">You replied: {labelFor(catalog, 'responses', alert.response)}</div>
      ) : (
        <>
          <span className="muted">Reply</span>
          <div className="wrap">
            {(catalog?.responses ?? []).map((option) => (
              <button
                key={option.id}
                className="chip"
                disabled={busy}
                onClick={() => void act(() => api.respond(alert.id, option.id))}
              >
                {option.label.en}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="row">
        <button className="quiet" disabled={busy} onClick={() => void act(() => api.blockReporter(alert.id))}>
          Block sender
        </button>
        <button
          className="quiet"
          disabled={busy}
          onClick={() => void act(() => api.reportAbuse(alert.id, 'harassment'))}
        >
          Report
        </button>
      </div>
    </div>
  );
}

/** The owner surface: inbox, stickers, plates and how to be reached. */
export function Mine({ catalog }: { catalog: Catalog | null }): JSX.Element {
  const [tab, setTab] = useState<'alerts' | 'vehicles' | 'reachable'>('alerts');
  const [alerts, setAlerts] = useState<ReceivedAlertDto[]>([]);
  const [stickers, setStickers] = useState<StickerDto[]>([]);
  const [vehicles, setVehicles] = useState<VehicleDto[]>([]);
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [claimCode, setClaimCode] = useState('');
  const [plate, setPlate] = useState('');
  const [channelKind, setChannelKind] = useState('whatsapp');
  const [channelDestination, setChannelDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [inbox, stickerList, vehicleList, channelList] = await Promise.all([
        api.receivedAlerts(),
        api.stickers(),
        api.vehicles(),
        api.channels(),
      ]);
      setAlerts(inbox.alerts);
      setStickers(stickerList.stickers);
      setVehicles(vehicleList.vehicles);
      setChannels(channelList.channels);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        navigate('/signin');
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load your account.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, success?: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
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

  const unanswered = alerts.filter((a) => a.response === null).length;

  return (
    <div className="stack">
      <h1>My ParkPing</h1>

      <div className="wrap">
        <button className="chip" aria-pressed={tab === 'alerts'} onClick={() => setTab('alerts')}>
          Alerts{unanswered > 0 ? ` (${unanswered})` : ''}
        </button>
        <button className="chip" aria-pressed={tab === 'vehicles'} onClick={() => setTab('vehicles')}>
          My vehicles
        </button>
        <button className="chip" aria-pressed={tab === 'reachable'} onClick={() => setTab('reachable')}>
          How to reach me
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice ok">{notice}</div>}

      {tab === 'alerts' &&
        (alerts.length === 0 ? (
          <p className="muted center" style={{ padding: '2rem 0' }}>
            Nothing about your vehicles. That is the good outcome.
          </p>
        ) : (
          alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} catalog={catalog} onChanged={() => void load()} />
          ))
        ))}

      {tab === 'vehicles' && (
        <>
          {stickers.map((sticker) => (
            <StickerCard key={sticker.id} sticker={sticker} onChanged={() => void load()} />
          ))}

          <div className="card">
            <h2>Add a sticker</h2>
            <p className="muted">Type the code printed on it, or scan it with your camera.</p>
            <input
              className="code"
              value={claimCode}
              onChange={(event) => setClaimCode(event.target.value.toUpperCase())}
              placeholder="ABCD-EFGH-JK"
              autoCapitalize="characters"
              autoCorrect="off"
              maxLength={14}
            />
            <button
              className="primary block"
              disabled={busy || claimCode.replace(/[^0-9A-Z]/g, '').length < 6}
              onClick={() =>
                void run(async () => {
                  await api.claimSticker(claimCode, null);
                  setClaimCode('');
                }, 'Sticker added. You are now reachable.')
              }
            >
              Claim sticker
            </button>
          </div>

          {vehicles.map((vehicle) => (
            <div className="card" key={vehicle.id}>
              <div className="row">
                <h2 className="grow">{vehicle.plate}</h2>
                <span className={`badge ${vehicle.status === 'active' ? 'ok' : 'warn'}`}>{vehicle.status}</span>
              </div>
              {vehicle.label && <p className="muted">{vehicle.label}</p>}
              <button className="danger" disabled={busy} onClick={() => void run(() => api.removeVehicle(vehicle.id))}>
                Remove
              </button>
            </div>
          ))}

          <div className="card">
            <h2>Add a license plate</h2>
            <p className="muted">
              Optional. A sticker works without ever telling us your plate, which is the more private
              option — add a plate only if you also want to be reachable without one.
            </p>
            <input
              className="code"
              value={plate}
              onChange={(event) => setPlate(event.target.value.toUpperCase())}
              placeholder="M AB 1234"
              autoCapitalize="characters"
              autoCorrect="off"
              maxLength={24}
            />
            <button
              className="block"
              disabled={busy || plate.trim().length < 3}
              onClick={() =>
                void run(async () => {
                  await api.addVehicle(plate, 'DE', null);
                  setPlate('');
                }, 'Plate added.')
              }
            >
              Add plate
            </button>
          </div>
        </>
      )}

      {tab === 'reachable' && (
        <>
          <div className="card">
            <h2>How you get told</h2>
            <p className="muted">
              An alert is sent to every channel here. Add WhatsApp or SMS and you never need the app at
              all.
            </p>
            {channels.length === 0 && (
              <div className="notice warn">
                No channels yet — nobody can actually reach you. Add one below.
              </div>
            )}
            {channels.map((channel) => (
              <div className="row" key={channel.id}>
                <span className="badge">{channel.kind.replace('_', ' ')}</span>
                <span className="grow mono">{channel.destinationMasked}</span>
                <button className="quiet" disabled={busy} onClick={() => void run(() => api.removeChannel(channel.id))}>
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Add a channel</h2>
            <div className="wrap">
              {['whatsapp', 'sms', 'email'].map((kind) => (
                <button
                  key={kind}
                  className="chip"
                  aria-pressed={channelKind === kind}
                  onClick={() => setChannelKind(kind)}
                >
                  {kind}
                </button>
              ))}
            </div>
            <label className="field">
              <span>{channelKind === 'email' ? 'Email address' : 'Mobile number'}</span>
              <input
                value={channelDestination}
                onChange={(event) => setChannelDestination(event.target.value)}
                placeholder={channelKind === 'email' ? 'you@example.com' : '+4915112345678'}
                autoCapitalize="none"
              />
            </label>
            <button
              className="primary block"
              disabled={busy || channelDestination.trim().length < 5}
              onClick={() =>
                void run(async () => {
                  await api.addChannel(channelKind, channelDestination.trim(), channels.length + 1);
                  setChannelDestination('');
                }, 'Added. You will be reached there from now on.')
              }
            >
              Add channel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
