const KEY = "kodus-review-prefs";

export type DiffStyle = "split" | "unified";

export type FileTreeMode = "tree" | "grouped";

export type Preferences = {
    diffStyle: DiffStyle;
    hideHighlights: boolean;
    /** Files default to expanded; "collapse all" flips this. */
    collapseByDefault: boolean;
    /** Hide the left file-tree sidebar so the diff goes full-width. */
    fileTreeHidden: boolean;
    /** How the left sidebar renders the file list. */
    fileTreeMode: FileTreeMode;
};

const DEFAULTS: Preferences = {
    diffStyle: "unified",
    hideHighlights: false,
    collapseByDefault: false,
    fileTreeHidden: false,
    fileTreeMode: "grouped",
};

export function loadPreferences(): Preferences {
    if (typeof window === "undefined") return DEFAULTS;
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return DEFAULTS;
        const parsed = JSON.parse(raw) as Partial<Preferences>;
        return { ...DEFAULTS, ...parsed };
    } catch {
        return DEFAULTS;
    }
}

export function savePreferences(prefs: Preferences): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
        /* quota / disabled — preferences won't survive a reload */
    }
}
