export const COCKPIT_SOURCE = {
    INTERNAL: 'internal',
    LEGACY_BQ: 'legacy-bq',
} as const;

export type CockpitSource = (typeof COCKPIT_SOURCE)[keyof typeof COCKPIT_SOURCE];
