/**
 * The complete vocabulary a reporter and a vehicle user may exchange.
 *
 * There is no free text anywhere in the MVP. Every message that can be sent is
 * one of the constants below, which is what makes harassment structurally hard
 * rather than merely against the rules (project document §9).
 */

export const INCIDENT_CATEGORIES = [
  'entrance_blocked',
  'vehicle_blocked',
  'private_space_occupied',
  'please_move',
  'lights_left_on',
  'window_or_door_open',
  'visible_vehicle_issue',
  'safety_issue_other',
] as const;

export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

/**
 * `blocking` incidents are someone actively prevented from moving; they justify
 * a time-critical push. `courtesy` incidents help the vehicle user but nobody
 * is stuck. The distinction drives push priority and quiet-hours handling, not
 * a different set of rights.
 */
export type IncidentKind = 'blocking' | 'courtesy' | 'safety';

export interface IncidentDefinition {
  id: IncidentCategory;
  kind: IncidentKind;
  /** Higher value = more time-critical. Used for push priority and sorting. */
  urgency: 1 | 2 | 3;
  /** May the reporter attach a requested timeframe? Only for blocking cases. */
  allowsTimeframe: boolean;
  label: { en: string; de: string };
  /** Push notification body shown to the vehicle user. */
  pushBody: { en: string; de: string };
}

export const INCIDENTS: Record<IncidentCategory, IncidentDefinition> = {
  entrance_blocked: {
    id: 'entrance_blocked',
    kind: 'blocking',
    urgency: 3,
    allowsTimeframe: true,
    label: { en: 'Entrance / driveway blocked', de: 'Einfahrt / Zufahrt blockiert' },
    pushBody: {
      en: 'Someone reports your vehicle is blocking an entrance or driveway.',
      de: 'Jemand meldet, dass dein Fahrzeug eine Einfahrt blockiert.',
    },
  },
  vehicle_blocked: {
    id: 'vehicle_blocked',
    kind: 'blocking',
    urgency: 3,
    allowsTimeframe: true,
    label: { en: 'Another vehicle blocked', de: 'Anderes Fahrzeug zugeparkt' },
    pushBody: {
      en: 'Someone reports your vehicle is blocking another vehicle.',
      de: 'Jemand meldet, dass dein Fahrzeug ein anderes Fahrzeug zuparkt.',
    },
  },
  private_space_occupied: {
    id: 'private_space_occupied',
    kind: 'blocking',
    urgency: 2,
    allowsTimeframe: true,
    label: { en: 'Private parking space occupied', de: 'Privater Stellplatz belegt' },
    pushBody: {
      en: 'Someone reports your vehicle is on a private parking space.',
      de: 'Jemand meldet, dass dein Fahrzeug auf einem privaten Stellplatz steht.',
    },
  },
  please_move: {
    id: 'please_move',
    kind: 'blocking',
    urgency: 2,
    allowsTimeframe: true,
    label: { en: 'Please move vehicle', de: 'Bitte Fahrzeug umparken' },
    pushBody: {
      en: 'Someone asks whether you could move your vehicle.',
      de: 'Jemand fragt, ob du dein Fahrzeug umparken kannst.',
    },
  },
  lights_left_on: {
    id: 'lights_left_on',
    kind: 'courtesy',
    urgency: 1,
    allowsTimeframe: false,
    label: { en: 'Lights left on', de: 'Licht angelassen' },
    pushBody: {
      en: 'Someone noticed the lights on your vehicle are still on.',
      de: 'Jemand hat bemerkt, dass das Licht an deinem Fahrzeug noch an ist.',
    },
  },
  window_or_door_open: {
    id: 'window_or_door_open',
    kind: 'courtesy',
    urgency: 2,
    allowsTimeframe: false,
    label: { en: 'Window / door appears open', de: 'Fenster / Tür scheint offen' },
    pushBody: {
      en: 'Someone noticed a window or door on your vehicle appears to be open.',
      de: 'Jemand hat bemerkt, dass ein Fenster oder eine Tür offen zu sein scheint.',
    },
  },
  visible_vehicle_issue: {
    id: 'visible_vehicle_issue',
    kind: 'safety',
    urgency: 2,
    allowsTimeframe: false,
    label: { en: 'Visible issue with vehicle', de: 'Sichtbares Problem am Fahrzeug' },
    pushBody: {
      en: 'Someone noticed something on your vehicle that may need your attention.',
      de: 'Jemand hat etwas an deinem Fahrzeug bemerkt, das deine Aufmerksamkeit braucht.',
    },
  },
  safety_issue_other: {
    id: 'safety_issue_other',
    kind: 'safety',
    urgency: 3,
    allowsTimeframe: false,
    label: { en: 'Other safety-related vehicle issue', de: 'Anderes sicherheitsrelevantes Problem' },
    pushBody: {
      en: 'Someone reports a safety-related issue with your vehicle.',
      de: 'Jemand meldet ein sicherheitsrelevantes Problem an deinem Fahrzeug.',
    },
  },
};

/**
 * A timeframe is a *request from the reporter*, never a deadline granted by
 * ParkPing (project document §7). Both the wire format and the copy keep the
 * attribution attached so it cannot be presented as a legal countdown.
 */
export const TIMEFRAME_REQUESTS = ['asap', 'within_10_min', 'within_30_min', 'no_rush'] as const;
export type TimeframeRequest = (typeof TIMEFRAME_REQUESTS)[number];

export const TIMEFRAMES: Record<TimeframeRequest, { en: string; de: string }> = {
  asap: {
    en: 'The reporter asks if you can come as soon as possible.',
    de: 'Die meldende Person bittet dich, so schnell wie möglich zu kommen.',
  },
  within_10_min: {
    en: 'The reporter asks if you could come within about 10 minutes.',
    de: 'Die meldende Person fragt, ob du in etwa 10 Minuten kommen kannst.',
  },
  within_30_min: {
    en: 'The reporter asks if you could come within about 30 minutes.',
    de: 'Die meldende Person fragt, ob du in etwa 30 Minuten kommen kannst.',
  },
  no_rush: {
    en: 'The reporter says there is no time pressure.',
    de: 'Die meldende Person sagt, es eilt nicht.',
  },
};

export const RESPONSE_CODES = [
  'acknowledged',
  'on_my_way_5',
  'on_my_way_15',
  'already_moved',
  'cannot_move_now',
  'not_my_vehicle',
] as const;

export type ResponseCode = (typeof RESPONSE_CODES)[number];

export const RESPONSES: Record<ResponseCode, { en: string; de: string }> = {
  acknowledged: { en: 'Message received', de: 'Nachricht erhalten' },
  on_my_way_5: { en: 'On my way — 5 min', de: 'Ich komme — 5 Min.' },
  on_my_way_15: { en: 'On my way — 15 min', de: 'Ich komme — 15 Min.' },
  already_moved: { en: 'Vehicle already moved', de: 'Fahrzeug bereits umgeparkt' },
  cannot_move_now: { en: 'Cannot move right now', de: 'Kann gerade nicht umparken' },
  not_my_vehicle: { en: 'Not my vehicle', de: 'Nicht mein Fahrzeug' },
};

/**
 * `not_my_vehicle` is the safety valve for a mis-registered or mis-typed plate.
 * It is treated as a signal, not just a reply: it suspends further routing for
 * that vehicle pending review (see apps/api/src/services/alerts.ts).
 */
export const RESPONSES_REQUIRING_REVIEW: ResponseCode[] = ['not_my_vehicle'];

export const ABUSE_REASONS = [
  'harassment',
  'wrong_vehicle',
  'spam',
  'false_report',
  'other',
] as const;
export type AbuseReason = (typeof ABUSE_REASONS)[number];

export const ABUSE_REASON_LABELS: Record<AbuseReason, { en: string; de: string }> = {
  harassment: { en: 'Harassment', de: 'Belästigung' },
  wrong_vehicle: { en: 'Repeatedly the wrong vehicle', de: 'Wiederholt das falsche Fahrzeug' },
  spam: { en: 'Spam', de: 'Spam' },
  false_report: { en: 'Report was not true', de: 'Meldung war nicht zutreffend' },
  other: { en: 'Something else', de: 'Etwas anderes' },
};
