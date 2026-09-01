import type {
  Catalog,
  NotificationChannelDto,
  ReceivedAlertDto,
  SentAlertDto,
  StickerDto,
  StickerScanDto,
  UserDto,
  VehicleDto,
} from './types.js';

const BASE = '/api/v1';
const SESSION_KEY = 'parkping.session';

/**
 * Session handling for a surface with two kinds of caller.
 *
 * A visitor gets a *guest* session automatically on first use, because the
 * whole point of the web reporter flow is that nobody is asked to sign up
 * before they can help. Signing in upgrades that to a full account; the guest
 * token is simply replaced.
 */
export interface Session {
  kind: 'guest' | 'user';
  accessToken: string;
  refreshToken?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

function readSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

function writeSession(session: Session | null): void {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export function currentSession(): Session | null {
  return readSession();
}

export function isSignedIn(): boolean {
  return readSession()?.kind === 'user';
}

let guestInFlight: Promise<Session> | null = null;

/** Ensures there is *some* session. Creates a guest one if needed. */
export async function ensureSession(): Promise<Session> {
  const existing = readSession();
  if (existing) return existing;
  if (guestInFlight) return guestInFlight;

  guestInFlight = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/guest`, { method: 'POST' });
      if (!response.ok) throw new ApiError(response.status, 'guest_failed', 'Could not start a session.');
      const body = (await response.json()) as { tokens: { accessToken: string } };
      const session: Session = { kind: 'guest', accessToken: body.tokens.accessToken };
      writeSession(session);
      return session;
    } finally {
      guestInFlight = null;
    }
  })();

  return guestInFlight;
}

let refreshInFlight: Promise<Session | null> | null = null;

async function refresh(): Promise<Session | null> {
  const session = readSession();
  if (!session?.refreshToken) return null;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (!response.ok) {
        writeSession(null);
        return null;
      }
      const body = (await response.json()) as { tokens: { accessToken: string; refreshToken: string } };
      const next: Session = {
        kind: 'user',
        accessToken: body.tokens.accessToken,
        refreshToken: body.tokens.refreshToken,
      };
      writeSession(next);
      return next;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions extends RequestInit {
  /** Skips attaching a session. Used by public endpoints. */
  anonymous?: boolean;
}

async function request<T>(path: string, init: RequestOptions = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };

  if (!init.anonymous) {
    const session = readSession();
    if (session) headers.authorization = `Bearer ${session.accessToken}`;
  }

  const response = await fetch(`${BASE}${path}`, { ...init, headers });

  if (response.status === 401 && retry && !init.anonymous) {
    const refreshed = await refresh();
    if (refreshed) return request<T>(path, init, false);
  }

  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => null)) as
    | { error?: { code: string; message: string; retryAfter?: number } }
    | null;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'unknown',
      body?.error?.message ?? 'Something went wrong.',
      body?.error?.retryAfter,
    );
  }
  return body as T;
}

export const api = {
  catalog: () => request<Catalog>('/meta/catalog', { anonymous: true }),

  /** Public. This is the first thing that happens when a camera sees a sticker. */
  scanSticker: (code: string) =>
    request<{ sticker: StickerScanDto }>(`/stickers/${encodeURIComponent(code)}`),

  async submitAlert(input: {
    stickerCode?: string;
    plate?: string;
    country?: string;
    category: string;
    timeframe?: string | null;
  }): Promise<{ reference: string; message: string }> {
    await ensureSession();
    return request('/alerts', { method: 'POST', body: JSON.stringify(input) });
  },

  sentAlerts: () => request<{ alerts: SentAlertDto[] }>('/alerts/sent'),
  receivedAlerts: () => request<{ alerts: ReceivedAlertDto[] }>('/alerts/received'),

  respond: (alertId: string, response: string) =>
    request<void>(`/alerts/${alertId}/response`, {
      method: 'POST',
      body: JSON.stringify({ response }),
    }),

  blockReporter: (alertId: string) =>
    request<void>('/alerts/block', { method: 'POST', body: JSON.stringify({ alertId }) }),

  reportAbuse: (alertId: string, reason: string) =>
    request<void>('/account/abuse-reports', {
      method: 'POST',
      body: JSON.stringify({ alertId, reason }),
    }),

  // --- Auth ---------------------------------------------------------------

  requestCode: (channel: 'email' | 'phone', destination: string) =>
    request<{ devCode?: string }>('/auth/otp/request', {
      method: 'POST',
      anonymous: true,
      body: JSON.stringify({ channel, destination, locale: 'en' }),
    }),

  async verifyCode(
    channel: 'email' | 'phone',
    destination: string,
    code: string,
    consentVersion: string,
  ): Promise<UserDto> {
    const body = await request<{
      user: UserDto;
      tokens: { accessToken: string; refreshToken: string };
    }>('/auth/otp/verify', {
      method: 'POST',
      anonymous: true,
      body: JSON.stringify({ channel, destination, code, consentVersion }),
    });
    // Replaces any guest session. Reports already sent as a guest stay with
    // that guest identity, which is the honest behaviour — they were anonymous.
    writeSession({
      kind: 'user',
      accessToken: body.tokens.accessToken,
      refreshToken: body.tokens.refreshToken,
    });
    return body.user;
  },

  me: () => request<{ user: UserDto; consentRequired: boolean }>('/auth/me'),

  signOut: (): void => writeSession(null),

  // --- Owner --------------------------------------------------------------

  stickers: () => request<{ stickers: StickerDto[] }>('/stickers'),

  claimSticker: (code: string, label: string | null) =>
    request<{ sticker: StickerDto }>('/stickers/claim', {
      method: 'POST',
      body: JSON.stringify({ code, label }),
    }),

  updateSticker: (id: string, changes: { label?: string | null; status?: 'active' | 'disabled' }) =>
    request<{ sticker: StickerDto }>(`/stickers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),

  releaseSticker: (id: string) => request<void>(`/stickers/${id}`, { method: 'DELETE' }),

  vehicles: () => request<{ vehicles: VehicleDto[] }>('/vehicles'),

  addVehicle: (plate: string, country: string, label: string | null) =>
    request<{ vehicle: VehicleDto; notice: string | null }>('/vehicles', {
      method: 'POST',
      body: JSON.stringify({ plate, country, label }),
    }),

  removeVehicle: (id: string) => request<void>(`/vehicles/${id}`, { method: 'DELETE' }),

  channels: () => request<{ channels: NotificationChannelDto[] }>('/account/channels'),

  addChannel: (kind: string, destination: string, priority: number) =>
    request<{ channel: NotificationChannelDto }>('/account/channels', {
      method: 'POST',
      body: JSON.stringify({ kind, destination, priority }),
    }),

  removeChannel: (id: string) => request<void>(`/account/channels/${id}`, { method: 'DELETE' }),

  // --- Demo ---------------------------------------------------------------

  outbox: () =>
    request<{
      messages: Array<{ id: string; kind: string; status: string; preview: string | null; reference: string; createdAt: string }>;
    }>('/demo/outbox', { anonymous: true }),

  demoState: () =>
    request<{
      stickers: Array<{ code: string; status: string; label: string | null }>;
      users: Array<{ contact_masked: string; role: string }>;
      organizations: Array<{ name: string; slug: string; verified: boolean }>;
    }>('/demo/state', { anonymous: true }),
};
