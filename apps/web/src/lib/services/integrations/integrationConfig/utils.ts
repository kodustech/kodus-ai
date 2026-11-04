import type { Repository } from "@services/codeManagement/types";

import type { IntegrationConfig } from "./types";

/**
 * The repositories a team selected, from its code management configs. The
 * category also holds other configs (`webhook_creation_failures`) in no
 * particular order, so the list is read by its key, never by position.
 */
export function selectedRepositoriesFrom(
    configs: Array<IntegrationConfig> | undefined,
): Array<Repository> {
    const value = configs?.find(
        (config) => config.configKey === "repositories",
    )?.configValue;
    return Array.isArray(value) ? (value as Array<Repository>) : [];
}
