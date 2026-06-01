import { PostHog } from "posthog-node";

import { auth } from "../config/auth";
import type { AwaitedReturnType } from "../types";

const PosthogServerSide = async <P>(promise: (instance: PostHog) => P) => {
    const apiKey = process.env.WEB_POSTHOG_KEY;
    if (!apiKey) {
        throw new Error("PostHog API key (WEB_POSTHOG_KEY) is not configured.");
    }

    const posthog = new PostHog(apiKey, {
        flushAt: 1,
        flushInterval: 0,
        host: "https://us.i.posthog.com",
    });

    try {
        return await promise(posthog);
    } finally {
        await posthog.shutdown();
    }
};

/**
 * **Usage *(SERVER-SIDE ONLY)***:
 * feature flags in client-side would flash, hydration errors would be thrown, page redirects could not be done
 *
 * default identifier is "user"
 * ```
 *  const feature1ForUser = await getFeatureFlagWithPayload({ feature: "FEATURE-NAME-SET-IN-POSTHOG" });
 *  if (feature1ForUser?.value === 'VALUE-SET-IN-POSTHOG') doSomething();
 * ```
 *
 * explicitly setting identifier to "user"
 * ```
 *  const feature1ForUser = await getFeatureFlagWithPayload({ feature: "FEATURE-NAME-SET-IN-POSTHOG", identifier: "user" });
 *  if (feature1ForUser?.value === 'VALUE-SET-IN-POSTHOG') doSomething();
 * ```
 *
 * setting identifier to "organization"
 * ```
 *  const feature1ForOrg = await getFeatureFlagWithPayload({ feature: "FEATURE-NAME-SET-IN-POSTHOG", identifier: "organization" });
 *  if (feature1ForOrg?.value === 'VALUE-SET-IN-POSTHOG') doSomething();
 * ```
 * */
export const getFeatureFlagWithPayload = async ({
    feature,
    identifier = "user",
}: {
    feature: string;
    identifier?: "user" | "organization";
}): Promise<
    | {
          value: AwaitedReturnType<PostHog["getFeatureFlag"]>;
          payload: AwaitedReturnType<PostHog["getFeatureFlagPayload"]>;
      }
    | undefined
> => {
    // if no environment key is provided, assume self-hosted with all features enabled
    if (!process.env.WEB_POSTHOG_KEY)
        return { value: true, payload: undefined };

    const jwtPayload = await auth();
    const id =
        identifier === "user"
            ? jwtPayload?.user?.userId
            : jwtPayload?.user?.organizationId;

    // if no user is provided, there's no way to get feature flag
    if (!id) return undefined;

    return PosthogServerSide(async (p) => {
        const [value, payload] = await Promise.all([
            p.getFeatureFlag(feature, id).catch(() => undefined),
            p.getFeatureFlagPayload(feature, id).catch(() => undefined),
        ]);

        // if no value was provided, it doesn't exists so it also has no payload
        if (value === undefined) return undefined;

        return { value, payload };
    });
};

/**
 * **Usage *(SERVER-SIDE ONLY)***:
 * feature flags in client-side would flash, hydration errors would be thrown, page redirects could not be done
 *
 * default identifier is "user"
 * ```
 * const isEnabledForUser = await isFeatureEnabled({ feature: "FEATURE-NAME-SET-IN-POSTHOG" });
 * if (isEnabledForUser) doSomething();
 * ```
 *
 * explicitly setting identifier to "user"
 * ```
 * const isEnabledForUser = await isFeatureEnabled({ feature: "FEATURE-NAME-SET-IN-POSTHOG", identifier: "user" });
 * if (isEnabledForUser) doSomething();
 * ```
 *
 * setting identifier to "organization"
 * ```
 * const isEnabledForOrg = await isFeatureEnabled({ feature: "FEATURE-NAME-SET-IN-POSTHOG", identifier: "organization" });
 * if (isEnabledForOrg) doSomething();
 * ```
 * */
export const isFeatureEnabled = async ({
    feature,
    identifier = "user",
}: {
    feature: string;
    identifier?: "user" | "organization";
}): Promise<boolean> => {
    try {
        // if no environment key is provided, assume self-hosted with all features enabled
        if (!process.env.WEB_POSTHOG_KEY) return true;

        const jwtPayload = await auth();
        const id =
            identifier === "user"
                ? jwtPayload?.user?.userId
                : jwtPayload?.user?.organizationId;

        if (!id) return false;

        return PosthogServerSide(async (p) => {
            const value = await p
                .isFeatureEnabled(feature, id, {
                    groups: {
                        organization: jwtPayload?.user?.organizationId || "",
                    },
                })
                .catch(() => false);

            return value === true;
        });
    } catch (error) {
        if ((error as { digest?: string })?.digest === "DYNAMIC_SERVER_USAGE") {
            throw error;
        }
        console.error("Error checking feature flag:", error);
        return false;
    }
};
