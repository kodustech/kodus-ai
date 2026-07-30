export interface ICockpitMetricsVisibility {
    /** Whole-tab visibility. At least one tab must stay enabled. */
    readonly tabs: {
        readonly kodusReview: boolean;
        readonly productivity: boolean;
    };
    readonly summary: {
        readonly deployFrequency: boolean;
        readonly prCycleTime: boolean;
        readonly kodySuggestions: boolean;
        readonly bugRatio: boolean;
        readonly prSize: boolean;
    };
    readonly details: {
        readonly leadTimeBreakdown: boolean;
        readonly prCycleTime: boolean;
        readonly prsOpenedVsClosed: boolean;
        readonly prsMergedByDeveloper: boolean;
        readonly teamActivity: boolean;
    };
}

export const DEFAULT_COCKPIT_METRICS_VISIBILITY: ICockpitMetricsVisibility = {
    tabs: {
        kodusReview: true,
        productivity: true,
    },
    summary: {
        deployFrequency: true,
        prCycleTime: true,
        kodySuggestions: true,
        bugRatio: true,
        prSize: true,
    },
    details: {
        leadTimeBreakdown: true,
        prCycleTime: true,
        prsOpenedVsClosed: true,
        prsMergedByDeveloper: true,
        teamActivity: true,
    },
};

/**
 * Deep-merges a stored (possibly partial / older-shape) config over the
 * defaults so newly-added fields like `tabs` are always present — orgs
 * that saved a config before those fields existed don't break.
 */
export function mergeCockpitMetricsVisibility(
    stored: Partial<ICockpitMetricsVisibility> | null | undefined,
): ICockpitMetricsVisibility {
    if (!stored) return DEFAULT_COCKPIT_METRICS_VISIBILITY;
    return {
        tabs: {
            ...DEFAULT_COCKPIT_METRICS_VISIBILITY.tabs,
            ...stored.tabs,
        },
        summary: {
            ...DEFAULT_COCKPIT_METRICS_VISIBILITY.summary,
            ...stored.summary,
        },
        details: {
            ...DEFAULT_COCKPIT_METRICS_VISIBILITY.details,
            ...stored.details,
        },
    };
}
