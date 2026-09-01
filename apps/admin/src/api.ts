import type {
  AbuseReportDto,
  MetricsDto,
  OrganizationDto,
} from '@parkping/shared';

const BASE = '/api/v1';
const TOKEN_KEY = 'parkping.admin.tokens';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface AbuseQueueItem extends AbuseReportDto {
  source: 'user' | 'system';
  subjectUserId: string | null;
  subjectVehicleId: string | null;
  subjectAlertsLast24h: number;
  subjectDistinctTargetsLast24h: number;
}

export interface ContestedVehicle {
  vehicleId: string;
  userId: string;
  country: string;
  createdAt: string;
  competingClaims: number;
}

export interface MetricsResponse {
  metrics: MetricsDto;
  alertsByDay: Array<{ day: string; submitted: number; routed: number }>;
  categories: Array<{ category: string; count: number }>;
}

export interface AuditEvent {
  id: string;
  actor_user_id: string | null;
  actor_type: string;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function readTokens(): Tokens | null {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Tokens;
  } catch {
    return null;
  }
}

function writeTokens(tokens: Tokens | null): void {
  if (tokens) localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  else localStorage.removeItem(TOKEN_KEY);
}

let refreshInFlight: Promise<Tokens | null> | null = null;

/**
 * Refreshes the access token, collapsing concurrent 401s into one refresh.
 *
 * Without the shared promise, a dashboard that loads five panels at once would
 * fire five refreshes; the API rotates refresh tokens, so four of them would
 * present an already-spent token and log the operator out.
 */
async function refreshTokens(): Promise<Tokens | null> {
  if (refreshInFlight) return refreshInFlight;
  const current = readTokens();
  if (!current) return null;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!response.ok) {
        writeTokens(null);
        return null;
      }
      const body = (await response.json()) as { tokens: Tokens };
      writeTokens(body.tokens);
      return body.tokens;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const tokens = readTokens();
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`;

  const response = await fetch(`${BASE}${path}`, { ...init, headers });

  if (response.status === 401 && retry && tokens) {
    const refreshed = await refreshTokens();
    if (refreshed) return request<T>(path, init, false);
  }

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'unknown', error?.message ?? 'Request failed.');
  }
  return body as T;
}

export const api = {
  isSignedIn: (): boolean => readTokens() !== null,
  signOut: (): void => writeTokens(null),

  async requestCode(email: string): Promise<{ devCode?: string }> {
    return request('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ channel: 'email', destination: email, locale: 'en' }),
    });
  },

  async verifyCode(email: string, code: string): Promise<{ role: string }> {
    const body = await request<{ user: { role: string }; tokens: Tokens }>('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ channel: 'email', destination: email, code }),
    });
    writeTokens(body.tokens);
    return { role: body.user.role };
  },

  metrics: (windowDays: number) => request<MetricsResponse>(`/admin/metrics?windowDays=${windowDays}`),

  abuseReports: (status: string) =>
    request<{ reports: AbuseQueueItem[] }>(`/admin/abuse-reports?status=${status}`),

  resolveReport: (reportId: string, status: string, action: string) =>
    request<void>(`/admin/abuse-reports/${reportId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ status, action }),
    }),

  contestedVehicles: () => request<{ vehicles: ContestedVehicle[] }>('/admin/vehicles/contested'),

  approveClaim: (vehicleId: string) =>
    request<void>(`/admin/vehicles/${vehicleId}/approve-claim`, { method: 'POST' }),

  organizations: () => request<{ organizations: OrganizationDto[] }>('/admin/organizations'),

  setVerified: (organizationId: string, verified: boolean) =>
    request<void>(`/admin/organizations/${organizationId}/verification`, {
      method: 'POST',
      body: JSON.stringify({ verified }),
    }),

  audit: (limit = 100) => request<{ events: AuditEvent[] }>(`/admin/audit?limit=${limit}`),
};
