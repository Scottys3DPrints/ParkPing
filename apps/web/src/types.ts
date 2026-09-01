/**
 * Client-side view of the API contract.
 *
 * Declared here rather than imported from `@parkping/shared` so the web bundle
 * carries no server types, and so the selectable vocabulary comes from
 * `/v1/meta/catalog` at runtime — which is what lets a category be withdrawn
 * without redeploying this app.
 */

export interface Catalog {
  consentVersion: string;
  countries: Array<{ code: string; example: string }>;
  categories: Array<{
    id: string;
    kind: 'blocking' | 'courtesy' | 'safety';
    urgency: number;
    allowsTimeframe: boolean;
    label: { en: string; de: string };
  }>;
  timeframes: Array<{ id: string; label: { en: string; de: string } }>;
  responses: Array<{ id: string; label: { en: string; de: string } }>;
  abuseReasons: Array<{ id: string; label: { en: string; de: string } }>;
}

export interface StickerScanDto {
  code: string;
  status: 'unclaimed' | 'active' | 'disabled';
  label: string | null;
  organizationName: string | null;
  ownedByViewer: boolean;
}

export interface StickerDto {
  id: string;
  code: string;
  status: 'unclaimed' | 'active' | 'disabled';
  label: string | null;
  organizationId: string | null;
  organizationName: string | null;
  vehicleId: string | null;
  claimedAt: string | null;
  createdAt: string;
}

export interface VehicleDto {
  id: string;
  plate: string;
  country: string;
  label: string | null;
  status: 'active' | 'pending' | 'suspended' | 'removed';
  verificationMethod: string;
  organizationName: string | null;
}

export interface SentAlertDto {
  id: string;
  reference: string;
  source: 'sticker' | 'plate';
  category: string;
  timeframe: string | null;
  target: string;
  country: string | null;
  status: 'processed' | 'responded';
  response: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export interface ReceivedAlertDto {
  id: string;
  reference: string;
  source: 'sticker' | 'plate';
  stickerId: string | null;
  vehicleId: string | null;
  targetLabel: string;
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

export interface NotificationChannelDto {
  id: string;
  kind: 'whatsapp' | 'sms' | 'web_push' | 'expo' | 'email';
  destinationMasked: string;
  priority: number;
  verifiedAt: string | null;
  createdAt: string;
}

export interface UserDto {
  id: string;
  contactMasked: string;
  contactChannel: 'email' | 'phone';
  locale: 'en' | 'de';
}
