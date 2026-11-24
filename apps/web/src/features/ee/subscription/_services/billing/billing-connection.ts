/**
 * The Git connection the subscription page manages, kept per workspace: each
 * connection has its own plan and seats, while the trial and credits stay
 * with the workspace. Stored as `<teamId>:<connectionId>` so switching
 * workspace never applies another workspace's connection.
 */
export const BILLING_CONNECTION_COOKIE = "billing-connection";

export const encodeBillingConnection = (teamId: string, connectionId: string) =>
    `${teamId}:${connectionId}`;

export const parseBillingConnection = (
    raw: unknown,
    teamId: string,
): string | undefined => {
    if (typeof raw !== "string" || !teamId) return undefined;
    const prefix = `${teamId}:`;
    return raw.startsWith(prefix)
        ? raw.slice(prefix.length) || undefined
        : undefined;
};
