import { authorizedFetch, TypedFetchError } from "@services/fetch";
import { ORGANIZATION_PARAMETERS_PATHS } from "@services/organizationParameters";
import { getOrganizationParameterByKey } from "@services/organizationParameters/fetch";
import {
    getFixedEgressIp,
    type FixedEgressIp,
} from "@services/organizationParameters/fixedEgressIp";
import { getOrganizationId } from "@services/organizations/fetch";
import {
    OrganizationParametersAutoJoinConfig,
    OrganizationParametersConfigKey,
    OrganizationParametersReviewCommandModesConfig,
    Timezone,
} from "@services/parameters/types";
import { auth } from "src/core/config/auth";

import { GeneralOrganizationSettingsPage } from "./_page-component";

export default async function OrganizationSettingsPage() {
    // Independent — fetch in parallel instead of chaining two round-trips.
    const [, jwtPayload] = await Promise.all([getOrganizationId(), auth()]);
    const email = jwtPayload?.user.email ?? "";
    const userDomain = email.split("@")[1];

    let timezoneConfigValue: Timezone = Timezone.NEW_YORK;
    let autoJoinConfigValue: OrganizationParametersAutoJoinConfig = {
        enabled: false,
        domains: [userDomain],
    };

    const loadTimezone = async () => {
        try {
            const result = await getOrganizationParameterByKey<{
                configValue: Timezone;
            }>({
                key: OrganizationParametersConfigKey.TIMEZONE_CONFIG,
            });

            if (result?.configValue) {
                timezoneConfigValue = result.configValue;
            }
        } catch (error: unknown) {
            if (error instanceof TypedFetchError && error.statusCode === 404) {
                await authorizedFetch(
                    ORGANIZATION_PARAMETERS_PATHS.CREATE_OR_UPDATE,
                    {
                        method: "POST",
                        body: JSON.stringify({
                            key: OrganizationParametersConfigKey.TIMEZONE_CONFIG,
                            configValue: timezoneConfigValue,
                        }),
                    },
                );
            }
        }
    };

    const loadAutoJoin = async () => {
        try {
            const result = await getOrganizationParameterByKey<{
                configValue: OrganizationParametersAutoJoinConfig;
            }>({
                key: OrganizationParametersConfigKey.AUTO_JOIN_CONFIG,
            });

            if (result?.configValue) {
                autoJoinConfigValue = result.configValue;
            }
        } catch (error: unknown) {
            if (error instanceof TypedFetchError && error.statusCode === 404) {
                await authorizedFetch(
                    ORGANIZATION_PARAMETERS_PATHS.CREATE_OR_UPDATE,
                    {
                        method: "POST",
                        body: JSON.stringify({
                            key: OrganizationParametersConfigKey.AUTO_JOIN_CONFIG,
                            configValue: autoJoinConfigValue,
                        }),
                    },
                );
            }
        }
    };

    // Nothing stored leaves both commands on; no row is created for it.
    // Undefined when the read failed: the page shows the switches unknown.
    const loadReviewCommandModes = async (): Promise<
        OrganizationParametersReviewCommandModesConfig | undefined
    > => {
        try {
            const result = await getOrganizationParameterByKey<{
                configValue: OrganizationParametersReviewCommandModesConfig;
            }>({
                key: OrganizationParametersConfigKey.REVIEW_COMMAND_MODES_CONFIG,
            });
            return result?.configValue ?? {};
        } catch (error: unknown) {
            // Only "not stored" means both commands are on; a failed read
            // must not show them on, nor take the rest of the page down.
            if (error instanceof TypedFetchError && error.statusCode === 404) {
                return {};
            }
            return undefined;
        }
    };

    // Its own read: a failure says "could not load" on its card instead of
    // answering "not available", and never takes the rest of the page down.
    const NO_FIXED_EGRESS_IP: FixedEgressIp = {
        available: false,
        allowedByPlan: false,
        enabled: false,
    };
    const loadFixedEgressIp = (): Promise<{
        setting: FixedEgressIp;
        failed: boolean;
    }> =>
        getFixedEgressIp().then(
            (setting) => ({ setting, failed: false }),
            () => ({ setting: NO_FIXED_EGRESS_IP, failed: true }),
        );

    // The parameter loads are independent of each other.
    const [, , reviewCommandModes, fixedEgressIp] = await Promise.all([
        loadTimezone(),
        loadAutoJoin(),
        loadReviewCommandModes(),
        loadFixedEgressIp(),
    ]);

    return (
        <GeneralOrganizationSettingsPage
            email={email}
            timezone={timezoneConfigValue}
            autoJoinConfig={autoJoinConfigValue}
            reviewCommandModes={
                reviewCommandModes && {
                    heavyBlocked: reviewCommandModes.heavyBlocked === true,
                    ultraBlocked: reviewCommandModes.ultraBlocked === true,
                }
            }
            fixedEgressIp={fixedEgressIp.setting}
            fixedEgressIpLoadFailed={fixedEgressIp.failed}
        />
    );
}
