import { pathToApiUrl } from "src/core/utils/helpers";

export const INTEGRATION = {
    CLONE_INTEGRATION: pathToApiUrl("/integration/clone-integration"),
    CHECK_CONNECTION_PLATFORM: pathToApiUrl(
        "/integration/check-connection-platform",
    ),
} as const;
