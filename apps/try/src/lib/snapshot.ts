import type { PrInfo } from "./api";

const PREFIX = "kodus-review:";

export type ReviewSnapshot = {
    pr: PrInfo;
    diff: string;
};

export function saveSnapshot(jobId: string, snapshot: ReviewSnapshot) {
    if (typeof window === "undefined") return;
    try {
        window.sessionStorage.setItem(
            PREFIX + jobId,
            JSON.stringify(snapshot),
        );
    } catch {
        // sessionStorage can be over quota or disabled — render path
        // falls back to a basic view (no diff/files) in that case.
    }
}

export function loadSnapshot(jobId: string): ReviewSnapshot | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.sessionStorage.getItem(PREFIX + jobId);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
