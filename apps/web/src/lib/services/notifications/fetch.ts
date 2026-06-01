import { authorizedFetch } from "@services/fetch";
import { axiosAuthorized } from "src/core/utils/axios";

import { NOTIFICATION_PATHS } from ".";
import type {
    NotificationConfig,
    NotificationListResponse,
    RoutingRule,
    UnreadCountResponse,
    UpsertRoutingRulePayload,
} from "./types";

export const getNotifications = async (params?: {
    page?: number;
    limit?: number;
    unreadOnly?: boolean;
}) => {
    const queryParams = new URLSearchParams();
    if (params?.page) queryParams.append("page", String(params.page));
    if (params?.limit) queryParams.append("limit", String(params.limit));
    if (params?.unreadOnly) queryParams.append("unreadOnly", "true");

    const qs = queryParams.toString();
    const url = qs
        ? `${NOTIFICATION_PATHS.LIST}?${qs}`
        : NOTIFICATION_PATHS.LIST;

    return authorizedFetch<NotificationListResponse>(url);
};

export const getUnreadCount = async () => {
    return authorizedFetch<UnreadCountResponse>(
        NOTIFICATION_PATHS.UNREAD_COUNT,
    );
};

export const markNotificationRead = async (id: string) => {
    return axiosAuthorized.patch(NOTIFICATION_PATHS.MARK_READ(id), {});
};

export const markAllNotificationsRead = async () => {
    return axiosAuthorized.post(NOTIFICATION_PATHS.MARK_ALL_READ, {});
};

export const getRoutingRules = async () => {
    return authorizedFetch<RoutingRule[]>(NOTIFICATION_PATHS.ROUTING_RULES);
};

export const upsertRoutingRules = async (rules: UpsertRoutingRulePayload[]) => {
    return axiosAuthorized.put<RoutingRule[]>(
        NOTIFICATION_PATHS.ROUTING_RULES,
        { rules },
    );
};

export const resetRoutingRules = async () => {
    return axiosAuthorized.post<RoutingRule[]>(
        NOTIFICATION_PATHS.ROUTING_RULES_RESET,
        {},
    );
};

export const getNotificationConfig = async () => {
    return authorizedFetch<NotificationConfig>(NOTIFICATION_PATHS.CONFIG);
};
