import { pathToApiUrl } from "src/core/utils/helpers";

export const KODY_RULES_PATHS = {
    CREATE_OR_UPDATE: pathToApiUrl("/kody-rules/create-or-update"),
    FIND_BY_ORGANIZATION_ID: pathToApiUrl(
        "/kody-rules/find-by-organization-id",
    ),
    FIND_BY_ORGANIZATION_ID_AND_FILTER: pathToApiUrl(
        "/kody-rules/find-rules-in-organization-by-filter",
    ),
    DELETE_BY_ORGANIZATION_ID_AND_ROLE_UUID: pathToApiUrl(
        "/kody-rules/delete-rule-in-organization-by-id",
    ),
    FIND_LIBRARY_KODY_RULES: pathToApiUrl(
        "/kody-rules/find-library-kody-rules",
    ),
    FIND_LIBRARY_KODY_RULES_WITH_FEEDBACK: pathToApiUrl(
        "/kody-rules/find-library-kody-rules-with-feedback",
    ),
    FIND_LIBRARY_KODY_RULES_BUCKETS: pathToApiUrl(
        "/kody-rules/find-library-kody-rules-buckets",
    ),
    ADD_LIBRARY_KODY_RULES: pathToApiUrl("/kody-rules/add-library-kody-rules"),
    FAST_SYNC_IDE_RULES: pathToApiUrl("/kody-rules/fast-sync-ide-rules"),
    PENDING_IDE_RULES: pathToApiUrl("/kody-rules/pending-ide-rules"),
    REVIEW_FAST_IDE_RULES: pathToApiUrl("/kody-rules/review-fast-ide-rules"),
    CHANGE_STATUS_KODY_RULES: pathToApiUrl(
        "/kody-rules/change-status-kody-rules",
    ),
    APPLY_PENDING_KODY_RULES: pathToApiUrl("/kody-rules/pending/apply"),
    DISCARD_PENDING_KODY_RULES: pathToApiUrl("/kody-rules/pending/discard"),
    CONVERT_PENDING_UPDATES_TO_NEW: pathToApiUrl(
        "/kody-rules/pending/convert-updates-to-new",
    ),
    GENERATE_KODY_RULES: pathToApiUrl("/kody-rules/generate-kody-rules"),
    SYNC_IDE_RULES: pathToApiUrl("/kody-rules/sync-ide-rules"),
    CHECK_SYNC_STATUS: pathToApiUrl("/kody-rules/check-sync-status"),
    GET_INHERITED_RULES: pathToApiUrl("/kody-rules/inherited-rules"),
    GET_KODY_RULES_TOTAL_QUANTITY: pathToApiUrl("/kody-rules/limits"),
    GET_KODY_RULE_SUGGESTIONS: pathToApiUrl("/kody-rules/suggestions"),
    FIND_RECOMMENDED_KODY_RULES: pathToApiUrl(
        "/kody-rules/find-recommended-kody-rules",
    ),
    MANAGE_IMPORTED_KODY_RULES: pathToApiUrl("/kody-rules/imported/manage"),
    COUNT_IMPORTED_KODY_RULES: pathToApiUrl("/kody-rules/imported/count"),
    COUNTS_BY_REPOSITORY: pathToApiUrl("/kody-rules/counts-by-repository"),
} as const;
