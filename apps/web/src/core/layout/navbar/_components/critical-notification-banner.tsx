"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { Button } from "@components/ui/button";
import {
    useMarkNotificationRead,
    useNotificationConfig,
    useNotifications,
} from "@services/notifications/hooks";
import type { UserNotification } from "@services/notifications/types";
import { AlertTriangleIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

/**
 * Sticky, non-dismissible banner rendered at the top of the app shell
 * for any unread notification whose event is declared as
 * `pageSeverity` in the catalog (a subset of CRITICAL events — billing
 * failures, security alerts, etc.).
 *
 * There is no dismiss affordance by design. The user resolves it by
 * acting on the CTA, which marks the notification as read and
 * navigates them to the relevant page.
 */
export const CriticalNotificationBanner = () => {
    const router = useRouter();
    const { data: notifications } = useNotifications(1, 20, true);
    const { data: config } = useNotificationConfig();
    const markRead = useMarkNotificationRead();

    const pageSeverityEvents = useMemo(() => {
        const set = new Set<string>();
        for (const entry of config?.events ?? []) {
            if (entry.pageSeverity) set.add(entry.event);
        }
        return set;
    }, [config]);

    const actionLabelByEvent = useMemo(() => {
        const map = new Map<string, string>();
        for (const entry of config?.events ?? []) {
            if (entry.actionLabel) map.set(entry.event, entry.actionLabel);
        }
        return map;
    }, [config]);

    const banner: UserNotification | null = useMemo(() => {
        const list = notifications?.data ?? [];
        // Most-recent unread page-severity notification. The query
        // already filters unreadOnly; we cross-check the catalog.
        return list.find((n) => pageSeverityEvents.has(n.delivery.event))
            ?? null;
    }, [notifications, pageSeverityEvents]);

    if (!banner) return null;

    const handleAction = () => {
        markRead.mutate(banner.uuid);
        if (banner.delivery.ctaUrl) {
            router.push(banner.delivery.ctaUrl);
        }
    };

    const actionLabel =
        actionLabelByEvent.get(banner.delivery.event) ?? "View";

    return (
        <div
            role="alert"
            aria-live="assertive"
            className={cn(
                "border-b-red-500/40 bg-red-500/10 sticky top-0 z-30",
                "flex items-start gap-3 border-b px-4 py-3 sm:px-6",
            )}>
            <AlertTriangleIcon
                aria-hidden
                className="mt-0.5 size-5 shrink-0 text-red-400"
            />
            <div className="min-w-0 flex-1">
                <p className="text-text-primary text-sm font-semibold text-balance">
                    {banner.delivery.title}
                </p>
                <p className="text-text-secondary text-pretty text-xs">
                    {banner.delivery.body}
                </p>
            </div>
            {banner.delivery.ctaUrl && (
                <Button
                    size="xs"
                    variant="primary"
                    onClick={handleAction}
                    disabled={markRead.isPending}>
                    {actionLabel}
                </Button>
            )}
        </div>
    );
};
