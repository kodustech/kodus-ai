import { authorizedFetch } from "@services/fetch";
import { auth } from "src/core/config/auth";

import { ORGANIZATIONS_PATHS } from ".";

export const getOrganizationId = async () => {
    const session = await auth();
    return session?.user.organizationId!;
};

export const getOrganizationName = () =>
    authorizedFetch<string>(ORGANIZATIONS_PATHS.ORGANIZATION_NAME);

export const getOrganizationLanguage = (teamId: string) =>
    authorizedFetch<{ language: string }>(
        ORGANIZATIONS_PATHS.ORGANIZATION_LANGUAGE,
        {
            params: { teamId },
        },
    );
