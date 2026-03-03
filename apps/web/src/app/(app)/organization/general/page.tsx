import { authorizedFetch, TypedFetchError } from "@services/fetch";
import { ORGANIZATION_PARAMETERS_PATHS } from "@services/organizationParameters";
import {
    getBYOK,
    getOrganizationParameterByKey,
} from "@services/organizationParameters/fetch";
import { getOrganizationId } from "@services/organizations/fetch";
import {
    OrganizationParametersAutoJoinConfig,
    OrganizationParametersConfigKey,
    Timezone,
} from "@services/parameters/types";
import { auth } from "src/core/config/auth";
import type { BYOKConfig } from "src/features/ee/byok/_types";

import { GeneralOrganizationSettingsPage } from "./_page-component";

const DEFAULT_MAX_FILES = 500;

export default async function OrganizationSettingsPage() {
    const organizationId = await getOrganizationId();
    const jwtPayload = await auth();
    const email = jwtPayload?.user?.email ?? "";
    const userDomain = email.split("@")[1];

    let timezoneConfigValue: Timezone = Timezone.NEW_YORK;
    let autoJoinConfigValue: OrganizationParametersAutoJoinConfig = {
        enabled: false,
        domains: [userDomain],
    };
    let maxFilesValue: number = DEFAULT_MAX_FILES;
    let byokConfig: { main: BYOKConfig; fallback: BYOKConfig } | undefined;

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

    try {
        const result = await getOrganizationParameterByKey<{
            configValue: number;
        }>({
            key: OrganizationParametersConfigKey.CODE_REVIEW_MAX_FILES,
        });

        if (result?.configValue != null) {
            maxFilesValue = result.configValue;
        }
    } catch (error: unknown) {
        if (error instanceof TypedFetchError && error.statusCode === 404) {
            await authorizedFetch(
                ORGANIZATION_PARAMETERS_PATHS.CREATE_OR_UPDATE,
                {
                    method: "POST",
                    body: JSON.stringify({
                        key: OrganizationParametersConfigKey.CODE_REVIEW_MAX_FILES,
                        configValue: DEFAULT_MAX_FILES,
                    }),
                },
            );
        }
    }

    try {
        byokConfig = await getBYOK();
    } catch {
        byokConfig = undefined;
    }

    const isByokEnabled = !!(byokConfig?.main?.apiKey);

    return (
        <GeneralOrganizationSettingsPage
            email={email}
            timezone={timezoneConfigValue}
            autoJoinConfig={autoJoinConfigValue}
            maxFiles={maxFilesValue}
            isByokEnabled={isByokEnabled}
        />
    );
}
