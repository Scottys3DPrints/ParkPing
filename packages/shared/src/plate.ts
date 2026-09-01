/**
 * License plate normalization.
 *
 * Normalization has to be deterministic and identical on every code path,
 * because the normalized string is the only input to the blind index used for
 * routing (see apps/api/src/domain/plateIndex.ts). If the reporter's
 * normalization differs from the vehicle user's by a single character, the
 * alert silently fails to route and the user has no way to find out why.
 */

export const SUPPORTED_COUNTRIES = ['DE', 'AT', 'CH', 'NL', 'FR', 'PL', 'IT', 'CZ'] as const;
export type CountryCode = (typeof SUPPORTED_COUNTRIES)[number];

export function isSupportedCountry(value: string): value is CountryCode {
  return (SUPPORTED_COUNTRIES as readonly string[]).includes(value);
}

/**
 * Umlauts are canonicalized to their base letter. German district codes do
 * contain umlauts (LÖ, MÜR, SÄK), and users type them inconsistently as "LO",
 * "LOE" or "LÖ". Folding to the base letter means a plate is found however it
 * was typed, at the cost of a theoretical collision between an umlaut district
 * and its non-umlaut counterpart. That trade-off is deliberate: a rare
 * mis-route delivers a *request to move a car* to the wrong person, which is
 * recoverable and rate-limited, whereas a normalization miss breaks the core
 * promise of the product. See docs/DECISIONS.md (ADR-002).
 */
const CHAR_FOLD: Record<string, string> = {
  Ä: 'A',
  Ö: 'O',
  Ü: 'U',
  ß: 'S',
  Å: 'A',
  É: 'E',
  È: 'E',
  Ê: 'E',
  Á: 'A',
  À: 'A',
  Í: 'I',
  Ó: 'O',
  Ú: 'U',
  Ç: 'C',
  Ń: 'N',
  Ł: 'L',
  Ś: 'S',
  Ź: 'Z',
  Ż: 'Z',
  Ą: 'A',
  Ę: 'E',
};

export interface PlateFormat {
  /** Minimum length after normalization. */
  min: number;
  /** Maximum length after normalization. */
  max: number;
  /** Optional strict pattern; a plate that fails it is accepted but flagged. */
  pattern?: RegExp;
  /** Human-readable example used in UI placeholders. */
  example: string;
}

export const PLATE_FORMATS: Record<CountryCode, PlateFormat> = {
  // City code (1-3) + recognition letters (1-2) + digits (1-4) + optional E/H suffix.
  DE: { min: 4, max: 10, pattern: /^[A-Z]{1,3}[A-Z]{1,2}[0-9]{1,4}[EH]?$/, example: 'M AB 1234' },
  AT: { min: 4, max: 10, pattern: /^[A-Z]{1,2}[0-9A-Z]{2,8}$/, example: 'W 12345A' },
  CH: { min: 4, max: 10, pattern: /^[A-Z]{2}[0-9]{1,6}$/, example: 'ZH 123456' },
  NL: { min: 6, max: 8, example: 'XX-123-X' },
  FR: { min: 6, max: 9, pattern: /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/, example: 'AB-123-CD' },
  PL: { min: 4, max: 8, example: 'WA 12345' },
  IT: { min: 6, max: 8, pattern: /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/, example: 'AB 123 CD' },
  CZ: { min: 5, max: 8, example: '1A2 3456' },
};

export type PlateRejectionReason = 'empty' | 'too_short' | 'too_long' | 'no_alphanumeric';

export interface NormalizedPlate {
  /** Canonical uppercase alphanumeric form used for hashing and comparison. */
  normalized: string;
  /** ISO 3166-1 alpha-2 country of registration. */
  country: CountryCode;
  /**
   * True when the plate parsed cleanly against the country pattern. A false
   * value does not block registration — plate formats change and special
   * series exist — but it is recorded so support can review odd entries.
   */
  matchesCountryFormat: boolean;
}

export class PlateNormalizationError extends Error {
  constructor(
    public readonly reason: PlateRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'PlateNormalizationError';
  }
}

function fold(input: string): string {
  let out = '';
  for (const char of input) {
    out += CHAR_FOLD[char] ?? char;
  }
  return out;
}

/**
 * Convert user input into the canonical plate representation.
 *
 * Throws {@link PlateNormalizationError} for input that cannot represent a
 * plate at all. Country-format mismatches are reported, not rejected.
 */
export function normalizePlate(raw: string, country: CountryCode): NormalizedPlate {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new PlateNormalizationError('empty', 'Enter a license plate.');
  }

  let value = raw.normalize('NFC').toUpperCase();
  value = fold(value);
  // Drop separators, whitespace, seal characters and anything non-alphanumeric.
  value = value.replace(/[^A-Z0-9]/g, '');

  const format = PLATE_FORMATS[country];
  if (value.length === 0) {
    throw new PlateNormalizationError('no_alphanumeric', 'That does not look like a license plate.');
  }
  if (value.length < format.min) {
    throw new PlateNormalizationError('too_short', `A ${country} plate has at least ${format.min} characters.`);
  }
  if (value.length > format.max) {
    throw new PlateNormalizationError('too_long', `A ${country} plate has at most ${format.max} characters.`);
  }

  return {
    normalized: value,
    country,
    matchesCountryFormat: format.pattern ? format.pattern.test(value) : true,
  };
}

/**
 * Best-effort pretty printer used when showing a plate back to the account
 * that registered it. Never used for matching.
 *
 * Once separators are stripped, the split is genuinely ambiguous — "MAB1234"
 * is both M-AB 1234 (München) and MA-B 1234 (Mannheim). The lazy quantifier on
 * the district group picks the shortest district that still parses, which is a
 * consistent convention rather than a correct answer. It only affects how the
 * plate is drawn for its own owner, so a wrong guess is cosmetic.
 */
export function formatPlateForDisplay(normalized: string, country: CountryCode): string {
  if (country === 'DE') {
    const match = /^([A-Z]{1,3}?)([A-Z]{1,2})([0-9]{1,4}[EH]?)$/.exec(normalized);
    if (match) return `${match[1]}-${match[2]} ${match[3]}`;
  }
  if (country === 'FR' || country === 'IT') {
    const match = /^([A-Z]{2})([0-9]{3})([A-Z]{2})$/.exec(normalized);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return normalized;
}
