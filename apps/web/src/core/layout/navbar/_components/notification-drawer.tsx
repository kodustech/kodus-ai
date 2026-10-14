"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
    rulePageHref,
    useCodeReviewScopes,
    type CodeReviewScope,
} from "@services/parameters/use-code-review-scopes";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    ArrowRightIcon,
    BellIcon,
    CheckCheck,
    ChevronDownIcon,
    ExternalLinkIcon,
    ScrollTextIcon,
    SettingsIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

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

/** A CTA that stays inside the app, as opposed to a provider URL. */
const isInAppLink = (url: string) => url.startsWith("/");

/**
 * Rules a notification names, each linking to its own detail panel.
 * `rule.file_references_invalid` carries them in `metadata.issues`; other
 * events carry none and render nothing.
 */
type NotificationRuleRef = {
    ruleId?: string;
    ruleName?: string;
    filePath?: string;
    reason?: string;
};

const ruleRefsOf = (notification: UserNotification): NotificationRuleRef[] => {
    const issues = notification.delivery.metadata?.issues;
    return Array.isArray(issues) ? (issues as NotificationRuleRef[]) : [];
};

const ruleRefHref = (
    ref: NotificationRuleRef,
    notification: UserNotification,
    scopes: Array<CodeReviewScope>,
) => {
    const repositoryId = notification.delivery.metadata?.repositoryId;
    return rulePageHref(
        {
            ruleId: ref.ruleId,
            repositoryId:
                typeof repositoryId === "string" ? repositoryId : undefined,
        },
        scopes,
    );
};

interface NotificationDrawerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const NotificationDrawer = ({
    open,
    onOpenChange,
}: NotificationDrawerProps) => {
    const router = useRouter();
    const [page, setPage] = useState(1);
    // Resolves each affected rule to a scope the settings screen can open.
    const scopes = useCodeReviewScopes(open);
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

    // The catalog names each event's action ("Review rules", "Open PR"…);
    // shown on the row so the destination is legible before clicking.
    const actionLabelByEvent = useMemo(() => {
        const map = new Map<string, string | undefined>();
        for (const entry of (config?.events ?? []) as EventCatalogEntry[]) {
            map.set(entry.event, entry.actionLabel);
        }
        return map;
    }, [config]);

    const openLink = useCallback(
        (url: string) => {
            onOpenChange(false);
            if (isInAppLink(url)) {
                // An app route navigates in place: spawning a tab for it
                // loses the session's context and the back button.
                router.push(url);
                return;
            }
            // A provider URL (a pull request, a payment page) opens beside
            // the app so the reader keeps their place.
            window.open(url, "_blank", "noopener,noreferrer");
        },
        [onOpenChange, router],
    );

    const handleNotificationClick = useCallback(
        (notification: UserNotification) => {
            if (!notification.readAt) {
                markRead.mutate(notification.uuid);
            }
            if (notification.delivery.ctaUrl) {
                openLink(notification.delivery.ctaUrl);
            }
        },
        [markRead, openLink],
    );

    const notifications = data?.data ?? [];
    const total = data?.total ?? 0;
    const hasMore = page * 20 < total;

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side="right"
                className="bg-card-lv1 flex w-full max-w-md flex-col p-0">
                <SheetHeader className="flex flex-row items-center justify-between gap-4 border-b px-6 py-4">
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
                        notifications.map((n) => (
                            <NotificationRow
                                key={n.uuid}
                                notification={n}
                                icon={resolveNotificationIcon(
                                    iconByEvent.get(n.delivery.event),
                                )}
                                actionLabel={actionLabelByEvent.get(
                                    n.delivery.event,
                                )}
                                onOpen={() => handleNotificationClick(n)}
                                onOpenLink={openLink}
                                scopes={scopes}
                            />
                        ))}

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
    const canManageOrg = usePermission(
        Action.Manage,
        ResourceType.OrganizationSettings,
    );

    return (
        <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
            <div className="bg-card-lv2 text-text-tertiary flex size-12 items-center justify-center rounded-full">
                <BellIcon className="size-5" />
            </div>
            <div className="flex flex-col gap-1">
                <p className="text-text-primary text-sm font-semibold text-balance">
                    You&apos;re all caught up
                </p>
                <p className="text-text-tertiary text-xs text-pretty">
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

/**
 * One notification. The whole row is the primary action when the event has a
 * CTA, with the destination named next to it, and any rules the event names
 * are listed below as their own links — the point of the drawer is to get to
 * the thing that happened, not just to read that it did.
 */
function NotificationRow({
    notification,
    icon: Icon,
    actionLabel,
    onOpen,
    onOpenLink,
    scopes,
}: {
    notification: UserNotification;
    icon: React.ElementType;
    actionLabel?: string;
    onOpen: () => void;
    onOpenLink: (url: string) => void;
    scopes: Array<CodeReviewScope>;
}) {
    const [showRules, setShowRules] = useState(false);
    const ruleRefs = ruleRefsOf(notification);
    const ctaUrl = notification.delivery.ctaUrl;
    const unread = !notification.readAt;
    const critBar =
        CRITICALITY_BAR[notification.delivery.criticality] ??
        "border-l-transparent";

    return (
        <div
            className={cn(
                "border-b border-l-2",
                critBar,
                unread && "bg-card-lv2/50",
            )}>
            <button
                type="button"
                onClick={onOpen}
                className={cn(
                    "ring-card-lv3 group focus-visible:bg-card-lv2 hover:bg-card-lv2 flex w-full items-start gap-3 px-6 py-4 text-left outline-hidden transition-colors duration-150 ease-out focus-visible:ring-1 focus-visible:ring-inset",
                    !ctaUrl && "cursor-default",
                )}>
                <div
                    className={cn(
                        "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
                        unread
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
                                unread
                                    ? "text-text-primary font-semibold"
                                    : "text-text-secondary font-medium",
                            )}>
                            {notification.delivery.title}
                        </p>
                        {unread && (
                            <span
                                aria-label="Unread"
                                className="bg-primary-light size-2 shrink-0 rounded-full"
                            />
                        )}
                    </div>
                    <p className="text-text-tertiary mt-0.5 line-clamp-3 text-xs text-pretty">
                        {notification.delivery.body}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                        <p className="text-text-tertiary text-xs tabular-nums">
                            {formatRelativeTime(
                                notification.delivery.createdAt,
                            )}
                        </p>
                        {ctaUrl && (
                            <span className="text-primary-light inline-flex items-center gap-1 text-xs font-medium">
                                {actionLabel ??
                                    (isInAppLink(ctaUrl) ? "Open" : "View")}
                                {isInAppLink(ctaUrl) ? (
                                    <ArrowRightIcon className="size-3" />
                                ) : (
                                    <ExternalLinkIcon className="size-3" />
                                )}
                            </span>
                        )}
                    </div>
                </div>
            </button>

            {ruleRefs.length > 0 && (
                <div className="px-6 pb-3">
                    <Button
                        size="xs"
                        variant="cancel"
                        className="h-6 min-h-0 px-2"
                        rightIcon={
                            <ChevronDownIcon
                                className={cn(
                                    "transition-transform",
                                    showRules && "rotate-180",
                                )}
                            />
                        }
                        onClick={() => setShowRules((value) => !value)}>
                        {showRules ? "Hide" : "Show"} affected{" "}
                        {ruleRefs.length === 1
                            ? "rule"
                            : `rules (${ruleRefs.length})`}
                    </Button>

                    {showRules && (
                        <ul className="border-card-lv3/60 mt-2 flex flex-col gap-1 border-l pl-3">
                            {ruleRefs.map((ref, index) => (
                                <li key={ref.ruleId ?? index}>
                                    <button
                                        type="button"
                                        disabled={!ref.ruleId}
                                        onClick={() =>
                                            onOpenLink(
                                                ruleRefHref(
                                                    ref,
                                                    notification,
                                                    scopes,
                                                ),
                                            )
                                        }
                                        className="group hover:bg-card-lv2 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:pointer-events-none">
                                        <ScrollTextIcon className="text-text-tertiary mt-0.5 size-3.5 shrink-0" />
                                        <span className="min-w-0 flex-1">
                                            <span className="text-text-secondary group-hover:text-text-primary block truncate text-xs font-medium">
                                                {ref.ruleName ?? "Rule"}
                                            </span>
                                            {(ref.filePath || ref.reason) && (
                                                <span className="text-text-tertiary block truncate font-mono text-[11px]">
                                                    {ref.filePath}
                                                    {ref.filePath && ref.reason
                                                        ? " · "
                                                        : ""}
                                                    {ref.reason}
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
