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
    APPLY_CODE_REVIEW_PRESET: pathToApiUrl(
        "/parameters/apply-code-review-preset",
    ),
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
