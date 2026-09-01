import type { ChannelKind } from '@parkping/shared';
import { logger } from '../../logger.js';

export interface OutboundMessage {
  title: string;
  body: string;
  /** Deep-link payload. Strings only, never personal data. */
  data: Record<string, string>;
  priority: 'high' | 'normal';
  /** Absolute URL the recipient can open to reply. */
  actionUrl: string;
}

export interface TransportResult {
  ok: boolean;
  error?: string;
  /** The destination is permanently unusable; deactivate the channel. */
  destinationInvalid?: boolean;
  /** Rendered message, stored only by non-production transports. */
  preview?: string;
}

export interface ChannelTransport {
  readonly kind: ChannelKind;
  /** False when credentials are missing, so the caller can fall back. */
  readonly configured: boolean;
  send(destination: string, message: OutboundMessage): Promise<TransportResult>;
}

/**
 * Renders the one-message-per-alert body shared by the text channels.
 *
 * Every channel says the same thing, because the vocabulary is fixed and the
 * message must not vary with how the person happens to be reachable.
 */
export function renderText(message: OutboundMessage): string {
  return `${message.title}\n\n${message.body}\n\n${message.actionUrl}`;
}

/**
 * Development and demo transport. Records what would have been sent so it can
 * be shown in the demo outbox, and logs a masked line.
 */
export class DemoTransport implements ChannelTransport {
  readonly configured = true;
  constructor(readonly kind: ChannelKind) {}

  async send(destination: string, message: OutboundMessage): Promise<TransportResult> {
    const preview = renderText(message);
    logger.info('channel.demo_send', {
      kind: this.kind,
      destination: `${destination.slice(0, 4)}…`,
      title: message.title,
    });
    return { ok: true, preview };
  }
}

/**
 * WhatsApp via the Meta Cloud API.
 *
 * Business-initiated messages must use a pre-approved template, which is why
 * the structured vocabulary matters commercially as well as for safety: eight
 * incident categories become eight templates, and there is no free text that
 * could fail review. `WHATSAPP_TEMPLATE_NAME` names the template whose single
 * body parameter receives the rendered incident line.
 */
export class WhatsAppTransport implements ChannelTransport {
  readonly kind = 'whatsapp' as const;

  constructor(
    private readonly phoneNumberId: string | null,
    private readonly accessToken: string | null,
    private readonly templateName: string,
    private readonly templateLocale: string,
  ) {}

  get configured(): boolean {
    return this.phoneNumberId !== null && this.accessToken !== null;
  }

  async send(destination: string, message: OutboundMessage): Promise<TransportResult> {
    if (!this.configured) return { ok: false, error: 'whatsapp_not_configured' };

    const body = {
      messaging_product: 'whatsapp',
      to: destination.replace(/[^0-9]/g, ''),
      type: 'template',
      template: {
        name: this.templateName,
        language: { code: this.templateLocale },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: message.title },
              { type: 'text', text: message.body },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: message.data.alertId ?? '' }],
          },
        ],
      },
    };

    try {
      const response = await fetch(
        `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          ok: false,
          error: `whatsapp_http_${response.status}: ${text.slice(0, 160)}`,
          // 131026 is "recipient not on WhatsApp"; nothing will fix that number.
          destinationInvalid: text.includes('131026'),
        };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'whatsapp_failed' };
    }
  }
}

/** SMS via Twilio's REST API. */
export class SmsTransport implements ChannelTransport {
  readonly kind = 'sms' as const;

  constructor(
    private readonly accountSid: string | null,
    private readonly authToken: string | null,
    private readonly fromNumber: string | null,
  ) {}

  get configured(): boolean {
    return this.accountSid !== null && this.authToken !== null && this.fromNumber !== null;
  }

  async send(destination: string, message: OutboundMessage): Promise<TransportResult> {
    if (!this.configured) return { ok: false, error: 'sms_not_configured' };

    const form = new URLSearchParams({
      To: destination,
      From: this.fromNumber as string,
      Body: renderText(message),
    });

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          ok: false,
          error: `sms_http_${response.status}: ${text.slice(0, 160)}`,
          // 21211 is an invalid 'To' number.
          destinationInvalid: text.includes('21211'),
        };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'sms_failed' };
    }
  }
}

/**
 * Email. Last resort only — a blocked entrance is not an email-speed problem,
 * and the channel is offered mainly so an owner is never completely
 * unreachable.
 */
export class EmailTransport implements ChannelTransport {
  readonly kind = 'email' as const;

  constructor(
    private readonly apiKey: string | null,
    private readonly fromAddress: string,
  ) {}

  get configured(): boolean {
    return this.apiKey !== null;
  }

  async send(destination: string, message: OutboundMessage): Promise<TransportResult> {
    if (!this.configured) return { ok: false, error: 'email_not_configured' };
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: destination,
          subject: message.title,
          text: renderText(message),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, error: `email_http_${response.status}: ${text.slice(0, 160)}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'email_failed' };
    }
  }
}
