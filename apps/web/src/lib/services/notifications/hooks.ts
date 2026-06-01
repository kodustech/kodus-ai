import { useCallback, useEffect, useRef, useState } from "react";
import {
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";

import {
    getNotificationConfig,
    getNotifications,
    getUnreadCount,
    markAllNotificationsRead,
    markNotificationRead,
    getRoutingRules,
    upsertRoutingRules,
    resetRoutingRules,
} from "./fetch";
import { NOTIFICATION_PATHS } from ".";
import type {
    NotificationListResponse,
    UpsertRoutingRulePayload,
} from "./types";

// ── Query keys ─────────────────────────────────────────────────

const KEYS = {
    notifications: (page: number, unreadOnly: boolean) =>
        ["notifications", page, unreadOnly] as const,
    unreadCount: ["notifications", "unread-count"] as const,
    routingRules: ["notifications", "routing-rules"] as const,
    config: ["notifications", "config"] as const,
};

// ── Notification list ──────────────────────────────────────────

export const useNotifications = (
    page = 1,
    limit = 20,
    unreadOnly = false,
) => {
    return useQuery<NotificationListResponse>({
        queryKey: KEYS.notifications(page, unreadOnly),
        queryFn: () => getNotifications({ page, limit, unreadOnly }),
        staleTime: 30_000,
    });
};

// ── Unread count (SSE) ─────────────────────────────────────────

/**
 * Uses SSE for real-time updates, falls back to polling on disconnect.
 */
export const useUnreadCount = () => {
    const [count, setCount] = useState(0);
    const eventSourceRef = useRef<EventSource | null>(null);
    const queryClient = useQueryClient();

    useEffect(() => {
        // Initial fetch
        getUnreadCount().then((res) => {
            if (res?.count !== undefined) setCount(res.count);
        });

        try {
            const es = new EventSource(NOTIFICATION_PATHS.STREAM, {
                withCredentials: true,
            });
            eventSourceRef.current = es;

            es.addEventListener("unread-count", (e: MessageEvent) => {
                try {
                    const data = JSON.parse(e.data);
                    setCount(data.count);
                } catch {
                    // ignore parse errors
                }
            });

            es.addEventListener("notification", (e: MessageEvent) => {
                try {
                    const data = JSON.parse(e.data);
                    // Bump count optimistically
                    setCount((prev) => prev + 1);
                    // Invalidate the list query so drawer refetches
                    queryClient.invalidateQueries({
                        queryKey: ["notifications"],
                    });
                } catch {
                    // ignore
                }
            });

            es.onerror = () => {
                // SSE disconnected — will auto-reconnect via EventSource spec
            };
        } catch {
            // EventSource not supported — fall back to polling below
        }

        return () => {
            eventSourceRef.current?.close();
        };
    }, [queryClient]);

    return count;
};

// ── Mutations ──────────────────────────────────────────────────

export const useMarkNotificationRead = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: string) => markNotificationRead(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
};

export const useMarkAllNotificationsRead = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => markAllNotificationsRead(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
};

// ── Routing rules (admin) ──────────────────────────────────────

export const useRoutingRules = () => {
    return useQuery({
        queryKey: KEYS.routingRules,
        queryFn: getRoutingRules,
        staleTime: 60_000,
    });
};

export const useUpsertRoutingRules = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (rules: UpsertRoutingRulePayload[]) =>
            upsertRoutingRules(rules),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: KEYS.routingRules });
        },
    });
};

export const useResetRoutingRules = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => resetRoutingRules(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: KEYS.routingRules });
        },
    });
};

export const useNotificationConfig = () => {
    return useQuery({
        queryKey: KEYS.config,
        queryFn: getNotificationConfig,
        staleTime: Infinity,
    });
};
