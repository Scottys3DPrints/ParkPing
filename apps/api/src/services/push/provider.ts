import { logger } from '../../logger.js';

export interface PushMessage {
  token: string;
  platform: 'ios' | 'android' | 'web';
  title: string;
  body: string;
  /** Deep-link payload. Values must be strings; no personal data. */
  data: Record<string, string>;
  priority: 'high' | 'normal';
}

export interface PushSendResult {
  token: string;
  ok: boolean;
  error?: string;
  /** True when the provider says the token is permanently invalid. */
  tokenInvalid?: boolean;
}

export interface PushProvider {
  readonly name: string;
  send(messages: PushMessage[]): Promise<PushSendResult[]>;
}

/** Development provider: prints what would have been sent. */
export class ConsolePushProvider implements PushProvider {
  readonly name = 'console';

  async send(messages: PushMessage[]): Promise<PushSendResult[]> {
    for (const message of messages) {
      logger.info('push.console', {
        token: `${message.token.slice(0, 8)}…`,
        platform: message.platform,
        title: message.title,
        body: message.body,
        priority: message.priority,
      });
    }
    return messages.map((m) => ({ token: m.token, ok: true }));
  }
}

/**
 * Expo push service, which fans out to APNs and FCM behind one endpoint.
 *
 * The project document specifies APNs + FCM directly (§8). Expo is the
 * pragmatic choice while the client is an Expo app: it needs no per-platform
 * credential handling for the pilot. This interface is the seam — swapping in
 * a direct APNs/FCM provider later means implementing `PushProvider` and
 * changing one config value, with no change to the alert pipeline.
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo';

  constructor(private readonly accessToken: string | null) {}

  async send(messages: PushMessage[]): Promise<PushSendResult[]> {
    if (messages.length === 0) return [];

    const body = messages.map((m) => ({
      to: m.token,
      title: m.title,
      body: m.body,
      data: m.data,
      sound: m.priority === 'high' ? 'default' : null,
      priority: m.priority,
      channelId: m.priority === 'high' ? 'urgent' : 'default',
    }));

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;

    let payload: { data?: Array<{ status: string; message?: string; details?: { error?: string } }> };
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return messages.map((m) => ({
          token: m.token,
          ok: false,
          error: `expo_http_${response.status}: ${text.slice(0, 120)}`,
        }));
      }
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      return messages.map((m) => ({
        token: m.token,
        ok: false,
        error: error instanceof Error ? error.message : 'expo_request_failed',
      }));
    }

    const tickets = payload.data ?? [];
    return messages.map((message, index) => {
      const ticket = tickets[index];
      if (!ticket) return { token: message.token, ok: false, error: 'expo_missing_ticket' };
      if (ticket.status === 'ok') return { token: message.token, ok: true };
      const detail = ticket.details?.error;
      return {
        token: message.token,
        ok: false,
        error: ticket.message ?? detail ?? 'expo_error',
        // Expo reports a retired token this way; we deactivate the device row.
        tokenInvalid: detail === 'DeviceNotRegistered',
      };
    });
  }
}
