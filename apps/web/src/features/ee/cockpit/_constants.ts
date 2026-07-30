export type TabValue = keyof typeof tabs;

// "Kodus Review" replaced the old "Code health" tab — its two charts
// (suggestions by category/repository) were absorbed as implementation-rate
// versions inside the review tab.
export const tabs = {
    "kodus-review": "Kodus Review",
    "productivity": "Productivity",
} satisfies Record<string, string>;

// URL search-param keys that carry the dashboard's current view, so it
// can be deep-linked/shared. The URL is the source of truth; cookies
// only provide the cross-session default when a param is absent.
export const COCKPIT_PARAM = {
    repository: "repository",
    start: "start",
    end: "end",
    tab: "tab",
} as const;

// In-card filter state for the Kodus Review tab. These operate on
// already-loaded data (no server refetch), so they're synced to the URL
// shallowly via `useShallowParam` — purely to make the view shareable.
export const COCKPIT_REVIEW_PARAM = {
    rulesHealth: "rulesHealth",
    rulesQuery: "rulesQ",
    reposQuery: "reposQ",
    severitySource: "sevSource",
    weeklyMode: "weeklyMode",
    feedbackMode: "feedbackMode",
} as const;
