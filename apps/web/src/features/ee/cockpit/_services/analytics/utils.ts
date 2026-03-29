import { typedFetch } from "@services/fetch";
import { getOrganizationId } from "@services/organizations/fetch";
import { createUrl } from "src/core/utils/helpers";
import { isServerSide } from "src/core/utils/server-side";

import type { PercentageDiff } from "../../_components/percentage-diff";
import { getSelectedRepository } from "../../_helpers/get-selected-repository";

export const analyticsFetch = async <Data>(
    url: `/${string}`,
    options: Parameters<typeof typedFetch>["1"] = {},
) => {
    const [organizationId, selectedRepository] = await Promise.all([
        getOrganizationId(),
        getSelectedRepository(),
    ]);

    if (!process.env.WEB_ANALYTICS_SECRET) {
        console.warn(
            "WEB_ANALYTICS_SECRET is not configured. Analytics requests will be skipped.",
        );
        return null as Data;
    }

    let hostName = process.env.WEB_ANALYTICS_HOSTNAME;
    const port = process.env.WEB_PORT_ANALYTICS;

    // if 'true' we are in the server and hostname is not a domain
    if (isServerSide && hostName === "localhost") {
        hostName =
            process.env.GLOBAL_ANALYTICS_CONTAINER_NAME ||
            "kodus-analytics-service";
    }

    const params = {
        ...options.params,
        organizationId,
        ...(selectedRepository && { repository: selectedRepository }),
    };

    const finalUrl = createUrl(`${hostName}`, port, `/api${url}`, {
        containerName: hostName,
    });

    try {
        return await typedFetch<Data>(finalUrl, {
            ...options,
            params,
            headers: {
                ...options?.headers,
                "x-api-key": process.env.WEB_ANALYTICS_SECRET,
            },
        });
    } catch (error) {
        if (error instanceof Error) {
            console.error(
                `Analytics request failed: ${error.message} in ${finalUrl}`,
            );
            return null as Data;
        }
        throw error;
    }
};

/**
 * startDate/endDate: Represents a date string in ISO format (YYYY-MM-DD).
 */
export type AnalyticsParams = {
    startDate: string;
    endDate: string;
};

export const getPercentageDiff = ({
    trend,
}: {
    trend: string;
}): React.ComponentProps<typeof PercentageDiff>["status"] => {
    switch (trend) {
        case "unchanged":
            return "neutral";

        case "improved":
            return "good";

        case "worsened":
            return "bad";

        default:
            return "neutral";
    }
};
