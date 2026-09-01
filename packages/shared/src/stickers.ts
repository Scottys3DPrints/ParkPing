/**
 * The sticker path (project document v0.2 §3.1).
 *
 * A sticker carries an opaque code, never a plate. That single substitution is
 * what removes plate verification, enumeration risk, and the "is this car even
 * reachable?" uncertainty from the reporter's side — and it makes the owner's
 * consent a physical act rather than a checkbox.
 */

export type StickerStatus = 'unclaimed' | 'active' | 'disabled';

export interface StickerDto {
  id: string;
  /** Human-readable code as printed, e.g. "7Q2K4M8TXV". */
  code: string;
  status: StickerStatus;
  label: string | null;
  organizationId: string | null;
  organizationName: string | null;
  /** Set only when the owner also chose to attach a plate. Usually null. */
  vehicleId: string | null;
  claimedAt: string | null;
  createdAt: string;
}

/**
 * What a reporter is told when they scan. Deliberately thin: enough to write a
 * useful report, nothing that identifies anyone.
 */
export interface StickerScanDto {
  code: string;
  /** `active` means an alert can be sent. Anything else means it cannot. */
  status: StickerStatus;
  /** The owner's own name for the car ("Blue Golf"), if they set one. */
  label: string | null;
  /** Shown only for a verified organization, e.g. "Nordpark Campus". */
  organizationName: string | null;
  /** True when the viewer is the account that claimed this sticker. */
  ownedByViewer: boolean;
}

/** How a sticker code is printed and scanned. */
export const STICKER_CODE_LENGTH = 10;

/** Crockford base32 minus I, L, O, U — no ambiguity when read aloud or typed. */
const STICKER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const STICKER_CODE_PATTERN = new RegExp(`^[${STICKER_ALPHABET}]{${STICKER_CODE_LENGTH}}$`);

/**
 * Accepts a code however it was typed or pasted — from a URL, read off a
 * windscreen in the rain, or with the hyphens people add on their own.
 *
 * The confusable characters are folded rather than rejected: someone reading
 * a sticker through a windscreen will type O for 0 and I for 1, and failing
 * them for it would be a self-inflicted wound.
 */
export function normalizeStickerCode(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const folded = raw
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  return STICKER_CODE_PATTERN.test(folded) ? folded : null;
}

/** "7Q2K4M8TXV" -> "7Q2K-4M8T-XV", which is what gets printed on the sticker. */
export function formatStickerCode(code: string): string {
  return code.replace(/(.{4})(.{4})(.{2})/, '$1-$2-$3');
}
