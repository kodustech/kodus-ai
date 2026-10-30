import { authorizedFetch, TypedFetchError } from "@services/fetch";
import { ORGANIZATION_PARAMETERS_PATHS } from "@services/organizationParameters";
import { getOrganizationParameterByKey } from "@services/organizationParameters/fetch";
import { getOrganizationId } from "@services/organizations/fetch";
import {
    OrganizationParametersAutoJoinConfig,
    OrganizationParametersConfigKey,
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

    // Both parameter loads are independent of each other.
    await Promise.all([loadTimezone(), loadAutoJoin()]);

    return (
        <GeneralOrganizationSettingsPage
            email={email}
            timezone={timezoneConfigValue}
            autoJoinConfig={autoJoinConfigValue}
        />
    );
}
