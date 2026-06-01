import { pathToApiUrl } from "src/core/utils/helpers";

const API_PREFIX = "/notifications";

export const NOTIFICATION_PATHS = {
    LIST: pathToApiUrl(API_PREFIX),
    UNREAD_COUNT: pathToApiUrl(`${API_PREFIX}/unread-count`),
    STREAM: pathToApiUrl(`${API_PREFIX}/stream`),
    MARK_READ: (id: string) => pathToApiUrl(`${API_PREFIX}/${id}/read`),
    MARK_ALL_READ: pathToApiUrl(`${API_PREFIX}/mark-all-read`),
    ROUTING_RULES: pathToApiUrl(`${API_PREFIX}/routing-rules`),
    ROUTING_RULES_RESET: pathToApiUrl(`${API_PREFIX}/routing-rules/reset`),
    CONFIG: pathToApiUrl(`${API_PREFIX}/config`),
} as const;
