const PREFIX = "kodus-review-viewed:";

type ViewedMap = Record<string, boolean>;

function key(jobId: string): string {
    return PREFIX + jobId;
}

export function loadViewed(jobId: string): ViewedMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.sessionStorage.getItem(key(jobId));
        return raw ? (JSON.parse(raw) as ViewedMap) : {};
    } catch {
        return {};
    }
}

export function setViewed(
    jobId: string,
    filePath: string,
    viewed: boolean,
): ViewedMap {
    const current = loadViewed(jobId);
    const next = { ...current, [filePath]: viewed };
    try {
        window.sessionStorage.setItem(key(jobId), JSON.stringify(next));
    } catch {
        /* sessionStorage quota / disabled — UI still works, state just
           won't survive a refresh. */
    }
    return next;
}
