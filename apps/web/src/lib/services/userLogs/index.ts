import { pathToApiUrl } from "src/core/utils/helpers";

export const USER_LOGS_PATHS = {
    GET_LOGS: pathToApiUrl("/user-log/code-review-settings"),
} as const;
