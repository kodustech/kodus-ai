export interface SessionEventInput {
    sessionId: string;
    type: string;
    branch: string;
    timestamp: string;
    [key: string]: unknown;
}
