import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * API client.
 *
 * Types are declared locally rather than imported from @parkping/shared: the
 * app is outside the npm workspace so Metro does not have to resolve a
 * symlinked package, and the selectable vocabulary (categories, responses)
 * comes from `/v1/meta/catalog` at runtime anyway — so a category can be
 * withdrawn without shipping a new build.
 */

const TOKEN_KEY = 'parkping.tokens';

/**
 * Where the API lives.
 *
 * `EXPO_PUBLIC_API_URL` wins, so CI can bake a hosted URL into a release build
 * without editing app.json. Falls back to `extra.apiUrl` for local runs.
 *
 * Note that `localhost` on a phone means *the phone*, not your computer — for a
 * device on your Wi-Fi this has to be the machine's LAN address.
 *
 * Blank values are treated as absent, not as an answer. An unset GitHub
 * Actions variable expands to an empty string rather than disappearing, and
 * `??` would happily accept that empty string and leave every request pointed
 * at nowhere.
 */
function firstConfigured(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return 'http://localhost:4000';
}

export const API_URL: string = firstConfigured(
  process.env.EXPO_PUBLIC_API_URL,
  Constants.expoConfig?.extra?.apiUrl as string | undefined,
);

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface User {
  id: string;
  contactMasked: string;
  contactChannel: 'email' | 'phone';
  locale: 'en' | 'de';
  notificationPreferences: {
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    timezone: string;
  };
}

export interface Vehicle {
  id: string;
  plate: string;
  country: string;
  label: string | null;
  status: 'active' | 'pending' | 'suspended' | 'removed';
  verificationMethod: string;
  organizationName: string | null;
}

export interface ReceivedAlert {
  id: string;
  reference: string;
  vehiclePlate: string;
  category: string;
  timeframe: string | null;
  locationLabel: string | null;
  reporterHandle: string;
  reporterIsVerifiedOrganization: boolean;
  organizationName: string | null;
  response: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export interface SentAlert {
  id: string;
  reference: string;
  category: string;
  timeframe: string | null;
  plateEntered: string;
  status: 'processed' | 'responded';
  response: string | null;
  createdAt: string;
}

export interface Catalog {
  consentVersion: string;
  countries: Array<{ code: string; example: string }>;
  categories: Array<{
    id: string;
    kind: string;
    urgency: number;
    allowsTimeframe: boolean;
    label: { en: string; de: string };
  }>;
  timeframes: Array<{ id: string; label: { en: string; de: string } }>;
  responses: Array<{ id: string; label: { en: string; de: string } }>;
  abuseReasons: Array<{ id: string; label: { en: string; de: string } }>;
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

let cachedTokens: Tokens | null = null;

export async function loadTokens(): Promise<Tokens | null> {
  if (cachedTokens) return cachedTokens;
  const raw = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!raw) return null;
  try {
    cachedTokens = JSON.parse(raw) as Tokens;
    return cachedTokens;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: Tokens | null): Promise<void> {
  cachedTokens = tokens;
  if (tokens) await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

let refreshInFlight: Promise<Tokens | null> | null = null;

/** Collapses concurrent refreshes; the server rotates the token on each use. */
async function refreshTokens(): Promise<Tokens | null> {
  if (refreshInFlight) return refreshInFlight;
  const current = await loadTokens();
  if (!current) return null;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!response.ok) {
        await saveTokens(null);
        return null;
      }
      const body = (await response.json()) as { tokens: Tokens };
      await saveTokens(body.tokens);
      return body.tokens;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const tokens = await loadTokens();
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'offline', 'No connection. Check your network and try again.');
  }

  if (response.status === 401 && retry && tokens) {
    const refreshed = await refreshTokens();
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
  catalog: () => request<Catalog>('/meta/catalog'),

  requestCode: (channel: 'email' | 'phone', destination: string) =>
    request<{ devCode?: string }>('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ channel, destination, locale: 'en' }),
    }),

  async verifyCode(
    channel: 'email' | 'phone',
    destination: string,
    code: string,
    consentVersion: string,
  ): Promise<User> {
    const body = await request<{ user: User; tokens: Tokens }>('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ channel, destination, code, consentVersion }),
    });
    await saveTokens(body.tokens);
    return body.user;
  },

  me: () => request<{ user: User; consentRequired: boolean }>('/auth/me'),

  async signOut(): Promise<void> {
    const tokens = await loadTokens();
    if (tokens) {
      await request<void>('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      }).catch(() => undefined);
    }
    await saveTokens(null);
  },

  vehicles: () => request<{ vehicles: Vehicle[] }>('/vehicles'),

  addVehicle: (input: { plate: string; country: string; label?: string; inviteCode?: string }) =>
    request<{ vehicle: Vehicle; notice: string | null }>('/vehicles', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  removeVehicle: (vehicleId: string) => request<void>(`/vehicles/${vehicleId}`, { method: 'DELETE' }),

  submitAlert: (input: { plate: string; country: string; category: string; timeframe?: string | null }) =>
    request<{ reference: string; status: string; message: string }>('/alerts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  receivedAlerts: () => request<{ alerts: ReceivedAlert[] }>('/alerts/received'),
  sentAlerts: () => request<{ alerts: SentAlert[] }>('/alerts/sent'),

  markOpened: (alertId: string) => request<void>(`/alerts/${alertId}/opened`, { method: 'POST' }),

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

  registerDevice: (input: { token: string; platform: string; installationId: string }) =>
    request<void>('/account/devices', { method: 'POST', body: JSON.stringify(input) }),

  updateNotificationPreferences: (prefs: User['notificationPreferences']) =>
    request<void>('/account/notification-preferences', {
      method: 'PATCH',
      body: JSON.stringify(prefs),
    }),

  /** The full GDPR export, as an object ready to be written to a file. */
  exportData: () => request<Record<string, unknown>>('/account/export'),

  deleteAccount: () =>
    request<void>('/account/delete', { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) }),
};
