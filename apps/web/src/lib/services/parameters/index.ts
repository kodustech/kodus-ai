import { pathToApiUrl } from "src/core/utils/helpers";

export const PARAMETERS_PATHS = {
    GET_CODE_REVIEW_LABELS: pathToApiUrl(
        "/parameters/list-code-review-automation-labels",
    ),
    GET_BY_KEY: pathToApiUrl("/parameters/find-by-key"),
    CREATE_OR_UPDATE: pathToApiUrl("/parameters/create-or-update"),
    CREATE_OR_UPDATE_CODE_REVIEW_PARAMETER: pathToApiUrl(
        "/parameters/create-or-update-code-review",
    ),
    SET_ENVIRONMENT_SECRETS: pathToApiUrl("/parameters/environment-secrets"),
    GET_ENVIRONMENT_SECRETS_STATUS: pathToApiUrl(
        "/parameters/environment-secrets/status",
    ),
    SET_ENVIRONMENT_INFRA: pathToApiUrl("/parameters/environment-infra"),
    GET_ENVIRONMENT_INFRA_STATUS: pathToApiUrl(
        "/parameters/environment-infra/status",
    ),
    GET_RUNTIME_RUN: pathToApiUrl("/parameters/runtime-run"),
    LIST_RUNTIME_RUNS: pathToApiUrl("/parameters/runtime-runs"),
    GENERATE_RUNTIME_PLAYBOOK: pathToApiUrl("/parameters/runtime/generate"),
    UPDATE_CODE_REVIEW_PARAMETER_REPOSITORIES: pathToApiUrl(
        "/parameters/update-code-review-parameter-repositories",
    ),
    GENERATE_KODUS_CONFIG_FILE: pathToApiUrl(
        "/parameters/generate-kodus-config-file",
    ),
    DELETE_REPOSITORY_CODE_REVIEW_PARAMETER: pathToApiUrl(
        "/parameters/delete-repository-code-review-parameter",
    ),
    PREVIEW_PR_SUMMARY: pathToApiUrl("/parameters/preview-pr-summary"),
    DEFAULT_CODE_REVIEW_PARAMETER: pathToApiUrl(
        "/parameters/default-code-review-parameter",
    ),
    GET_CODE_REVIEW_PARAMETER: pathToApiUrl(
        "/parameters/code-review-parameter",
    ),
    // Repositories and directories as ids and names only, for scope
    // pickers: no configuration, no kodus-config.yml read.
    CODE_REVIEW_SCOPES: pathToApiUrl("/parameters/code-review-scopes"),
    CENTRALIZED_CONFIG_SYNC: pathToApiUrl(
        "/parameters/centralized-config-sync",
    ),
    CENTRALIZED_CONFIG_INIT: pathToApiUrl(
        "/parameters/centralized-config-init",
    ),
    CENTRALIZED_CONFIG_DOWNLOAD: pathToApiUrl(
        "/parameters/centralized-config-download",
    ),
} as const;
