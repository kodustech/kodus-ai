"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { Skeleton } from "@components/ui/skeleton";
import {
    useMarkAllNotificationsRead,
    useMarkNotificationRead,
    useNotificationConfig,
    useNotifications,
} from "@services/notifications/hooks";
import type {
    CatalogIcon,
    EventCatalogEntry,
    UserNotification,
} from "@services/notifications/types";
import {
    BellIcon,
    CheckCheck,
    ExternalLinkIcon,
    SettingsIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";

import { resolveNotificationIcon } from "./notification-icons";

/**
 * Tailwind border classes per criticality. Pure presentation — the
 * label/text for each criticality comes from the backend config. Static
 * because the criticality enum itself is fixed and changes only with a
 * PR.
 */
const CRITICALITY_BAR: Record<string, string> = {
    system: "border-l-transparent",
    critical: "border-l-red-500",
    transactional: "border-l-amber-500",
    informational: "border-l-blue-500",
};

function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
}

interface NotificationDrawerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const NotificationDrawer = ({
    open,
    onOpenChange,
}: NotificationDrawerProps) => {
    const [page, setPage] = useState(1);
    const { data, isLoading } = useNotifications(page, 20);
    const { data: config } = useNotificationConfig();
    const markRead = useMarkNotificationRead();
    const markAllRead = useMarkAllNotificationsRead();

    // Lookup table: event name → CatalogIcon hint. Built from the
    // catalog so drawer icons follow whatever the backend declares.
    const iconByEvent = useMemo(() => {
        const map = new Map<string, CatalogIcon | undefined>();
        for (const entry of (config?.events ?? []) as EventCatalogEntry[]) {
            map.set(entry.event, entry.icon);
        }
        return map;
    }, [config]);

    const handleNotificationClick = useCallback(
        (notification: UserNotification) => {
            if (!notification.readAt) {
                markRead.mutate(notification.uuid);
            }
            if (notification.delivery.ctaUrl) {
                // Open in a new tab so the user keeps their place in the app
                // (CTAs are often external, e.g. a PR link).
                window.open(
                    notification.delivery.ctaUrl,
                    "_blank",
                    "noopener,noreferrer",
                );
                onOpenChange(false);
            }
        },
        [markRead, onOpenChange],
    );

    const notifications = data?.data ?? [];
    const total = data?.total ?? 0;
    const hasMore = page * 20 < total;

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side="right"
                className="bg-card-lv1 flex w-full max-w-md flex-col p-0">
                <SheetHeader className=" flex flex-row items-center justify-between gap-4 border-b px-6 py-4">
                    <SheetTitle className="text-text-primary text-base">
                        Notifications
                    </SheetTitle>
                    {notifications.length > 0 && (
                        <Button
                            size="xs"
                            variant="cancel"
                            leftIcon={<CheckCheck />}
                            onClick={() => markAllRead.mutate()}
                            disabled={markAllRead.isPending}>
                            Mark all as read
                        </Button>
                    )}
                </SheetHeader>

                <div className="flex-1 overflow-y-auto">
                    {isLoading && <NotificationListSkeleton />}

                    {!isLoading && notifications.length === 0 && (
                        <NotificationEmptyState
                            onAction={() => onOpenChange(false)}
                        />
                    )}

                    {!isLoading &&
                        notifications.map((n) => {
                            const Icon = resolveNotificationIcon(
                                iconByEvent.get(n.delivery.event),
                            );
                            const critBar =
                                CRITICALITY_BAR[n.delivery.criticality] ??
                                "border-l-transparent";

                            return (
                                <button
                                    key={n.uuid}
                                    type="button"
                                    onClick={() => handleNotificationClick(n)}
                                    className={cn(
                                        "ring-card-lv3 group flex w-full items-start gap-3 border-b border-l-2 px-6 py-4 text-left outline-hidden transition-colors duration-150 ease-out focus-visible:bg-card-lv2 focus-visible:ring-1 focus-visible:ring-inset",
                                        critBar,
                                        "hover:bg-card-lv2",
                                        !n.readAt && "bg-card-lv2/50",
                                    )}>
                                    <div
                                        className={cn(
                                            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
                                            !n.readAt
                                                ? "bg-primary-light/10 text-primary-light"
                                                : "bg-card-lv3 text-text-secondary",
                                        )}>
                                        <Icon className="size-4" />
                                    </div>

                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <p
                                                className={cn(
                                                    "truncate text-sm",
                                                    !n.readAt
                                                        ? "text-text-primary font-semibold"
                                                        : "text-text-secondary font-medium",
                                                )}>
                                                {n.delivery.title}
                                            </p>
                                            {!n.readAt && (
                                                <span
                                                    aria-label="Unread"
                                                    className="bg-primary-light size-2 shrink-0 rounded-full"
                                                />
                                            )}
                                        </div>
                                        <p className="text-text-tertiary mt-0.5 line-clamp-2 text-pretty text-xs">
                                            {n.delivery.body}
                                        </p>
                                        <p className="text-text-tertiary mt-1 text-xs tabular-nums">
                                            {formatRelativeTime(
                                                n.delivery.createdAt,
                                            )}
                                        </p>
                                    </div>

                                    {n.delivery.ctaUrl && (
                                        <ExternalLinkIcon className="text-text-tertiary mt-1 size-3.5 shrink-0 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100" />
                                    )}
                                </button>
                            );
                        })}

                    {hasMore && (
                        <div className="flex justify-center py-4">
                            <Button
                                size="sm"
                                variant="cancel"
                                onClick={() => setPage((p) => p + 1)}>
                                Load more
                            </Button>
                        </div>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
};

function NotificationListSkeleton() {
    return (
        <div className="flex flex-col">
            {[0, 1, 2, 3].map((i) => (
                <div
                    key={i}
                    className="flex items-start gap-3 border-b px-6 py-4">
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex flex-1 flex-col gap-2">
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-12" />
                    </div>
                </div>
            ))}
        </div>
    );
}

function NotificationEmptyState({ onAction }: { onAction: () => void }) {
    const router = useRouter();
    const canManageOrg = usePermission(Action.Manage, ResourceType.OrganizationSettings);

    return (
        <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
            <div className="bg-card-lv2 text-text-tertiary flex size-12 items-center justify-center rounded-full">
                <BellIcon className="size-5" />
            </div>
            <div className="flex flex-col gap-1">
                <p className="text-text-primary text-sm font-semibold text-balance">
                    You&apos;re all caught up
                </p>
                <p className="text-text-tertiary text-pretty text-xs">
                    New notifications will appear here.
                </p>
            </div>
            {canManageOrg && (
            <Button
                size="sm"
                variant="helper"
                leftIcon={<SettingsIcon />}
                onClick={() => {
                    onAction();
                    router.push("/organization/notifications");
                }}>
                Manage preferences
            </Button>
            )}
        </div>
    );
}
