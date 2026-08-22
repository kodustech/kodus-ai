import { SELF_HOSTED_TRIAL_REQUEST_URL } from "../_constants/trial";

/**
 * Instance context we can attach to a trial request without asking the
 * user to retype what we already know. It rides along as query params so
 * the form arrives tied to the instance that opened it.
 *
 * Every field is optional on purpose: `/api/version` is best-effort and
 * the session may still be loading when the card renders. A missing value
 * is dropped from the URL rather than sent as an empty or "undefined"
 * param.
 *
 * These values are prefill, not proof — the user can edit them in the
 * URL. That's fine: this is a lead form, not authentication.
 */
export type TrialRequestContext = {
    organizationId?: string;
    email?: string;
    /** Running self-hosted release, from `/api/version` (`current`). */
    version?: string;
};

const toParams = (context: TrialRequestContext): Array<[string, string]> => {
    const entries: Array<[string, string | undefined]> = [
        ["org_id", context.organizationId],
        ["email", context.email],
        ["version", context.version],
    ];

    return entries.flatMap(([key, value]) => {
        const trimmed = value?.trim();
        return trimmed ? [[key, trimmed] as [string, string]] : [];
    });
};

export const buildTrialRequestUrl = (
    context: TrialRequestContext = {},
): string => {
    const params = new URLSearchParams(toParams(context));
    const query = params.toString();

    return query
        ? `${SELF_HOSTED_TRIAL_REQUEST_URL}?${query}`
        : SELF_HOSTED_TRIAL_REQUEST_URL;
};
