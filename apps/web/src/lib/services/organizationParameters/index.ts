import { pathToApiUrl } from "src/core/utils/helpers";

export const ORGANIZATION_PARAMETERS_PATHS = {
    CREATE_OR_UPDATE: pathToApiUrl("/organization-parameters/create-or-update"),
    GET_BY_KEY: pathToApiUrl("/organization-parameters/find-by-key"),
    GET_PROVIDERS_LIST: pathToApiUrl("/organization-parameters/list-providers"),
    GET_PROVIDER_MODELS_LIST: pathToApiUrl(
        "/organization-parameters/list-models",
    ),
    DELETE_BYOK: pathToApiUrl("/organization-parameters/delete-byok-config"),
    TEST_BYOK: pathToApiUrl("/organization-parameters/test-byok"),
    GET_LLM_CONFIG_STATUS: pathToApiUrl(
        "/organization-parameters/llm-config/status",
    ),
    GET_COCKPIT_METRICS_VISIBILITY: pathToApiUrl(
        "/organization-parameters/cockpit-metrics-visibility",
    ),
    UPDATE_COCKPIT_METRICS_VISIBILITY: pathToApiUrl(
        "/organization-parameters/cockpit-metrics-visibility",
    ),
    UPDATE_AUTO_LICENSE_ALLOWED_USERS: pathToApiUrl(
        "/organization-parameters/auto-license/allowed-users",
    ),
};
