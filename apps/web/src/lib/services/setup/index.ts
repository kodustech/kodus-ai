import { pathToApiUrl } from "src/core/utils/helpers";

export const SETUP_PATHS = {
    GITHUB_ORGANIZATION_NAME: pathToApiUrl("/github/organization-name"),
    GITHUB_INTEGRATION: pathToApiUrl("/github/integration"),
    GITHUB_INSTALLATION_AUTHORIZATION: pathToApiUrl(
        "/github/installation-authorization",
    ),
    TEAM_MEMBERS: pathToApiUrl("/team-members/"),
    CONNECTIONS: pathToApiUrl("/integration/connections"),
} as const;
