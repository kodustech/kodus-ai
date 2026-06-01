export interface TrialStatus {
    fingerprint: string;
    reviewsUsed: number;
    reviewsLimit: number;
    filesLimit: number;
    linesLimit: number;
    resetsAt: string;
    isLimited: boolean;
}
