"use client";

import { useMemo } from "react";
import { useMCPAvailability } from "@services/mcp-manager/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    BlocksIcon,
    FolderGit2Icon,
    GaugeIcon,
    GitPullRequestIcon,
    LockIcon,
    SparklesIcon,
    type LucideIcon,
} from "lucide-react";
import { useKodusCreditBalance } from "src/features/ee/byok/_hooks/use-kodus-credit-balance";
import { isCockpitTierAllowed } from "src/features/ee/cockpit/_helpers/tier-policy";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

export type MainNavItem = {
    id: "reviews" | "cockpit" | "repositories" | "ai-providers" | "plugins";
    label: string;
    icon: LucideIcon;
    href: string;
    visible: boolean;
    badge?: React.JSX.Element;
    /** The badge asks for action; an icon-only rail keeps it as a dot. */
    attention?: boolean;
    matcher?: (pathname: string) => boolean;
};

/**
 * The product's main destinations, with their permission and plan gates —
 * the first group of the sidebar. Settings pages are listed by the sidebar's
 * own groups (code review, organization).
 */
export const useMainNavItems = () => {
    const subscription = useSubscriptionContext();

    const canReadPullRequests = usePermission(
        Action.Read,
        ResourceType.PullRequests,
    );
    const canReadCliReviews = usePermission(
        Action.Read,
        ResourceType.CliReview,
    );
    const canReadPlugins = usePermission(
        Action.Read,
        ResourceType.PluginSettings,
    );
    const canReadRepositories = usePermission(
        Action.Read,
        ResourceType.GitSettings,
    );
    const canEditOrg = usePermission(
        Action.Update,
        ResourceType.OrganizationSettings,
    );
    const credits = useKodusCreditBalance();
    const { data: isMCPAvailable = true } = useMCPAvailability(canReadPlugins);

    // Five destinations. Reviews folds Pull Requests + CLI Reviews (tabs on
    // the page); Issues lives inside the Cockpit; Library is reached from
    // Kody Rules.
    const items = useMemo(() => {
        const items: Array<MainNavItem> = [
            {
                id: "reviews",
                label: "Reviews",
                href: "/pull-requests",
                visible: canReadPullRequests || canReadCliReviews,
                icon: GitPullRequestIcon,
                matcher: (path) =>
                    path.startsWith("/pull-requests") ||
                    path.startsWith("/cli-reviews"),
            },
            {
                id: "cockpit",
                label: "Cockpit",
                href: "/cockpit",
                // Always visible: below the allowed tier the route renders a
                // blurred preview with an upgrade CTA (apps/web/.../cockpit/
                // layout.tsx), so the nav item shows a lock instead of hiding.
                visible: true,
                icon: GaugeIcon,
                badge: isCockpitTierAllowed(
                    subscription.license,
                ) ? undefined : (
                    <LockIcon className="size-3.5" />
                ),
            },
            {
                // Which repositories Kody reviews: where every workspace
                // starts, so it sits with the product, not among settings.
                id: "repositories",
                label: "Repositories",
                icon: FolderGit2Icon,
                href: "/settings/git",
                visible: canReadRepositories,
                matcher: (path) => path.startsWith("/settings/git"),
            },
            {
                // Which model reviews the code and whose key pays for it —
                // a first-order product decision, so it sits with the main
                // destinations, not among the settings. The label matches the
                // page's own title.
                id: "ai-providers",
                label: "AI providers",
                icon: SparklesIcon,
                href: credits.usesKodusProvider ? "/byok#kodus" : "/byok",
                visible: canEditOrg,
                matcher: (path) => path.startsWith("/byok"),
                // No balance here. A badge beside a nav item means "this many
                // things need you" everywhere else in the app, so putting
                // currency in that slot made the healthy state read as a
                // counter — and the number answered a question nobody asks
                // while navigating. The balance lives on the page below, where
                // it sits next to what it pays for, the fee and the top-up.
                //
                // What's left is only the state that needs acting on, and the
                // exhausted case is already a band at the top of the app, so
                // announcing it twice at once helped no one: this reduces to
                // the nudge that had no home at all — running low.
                attention:
                    credits.usesKodusProvider &&
                    credits.low &&
                    credits.routedThroughKodus,
                badge:
                    credits.usesKodusProvider &&
                    credits.low &&
                    credits.routedThroughKodus ? (
                        <span
                            data-testid="nav-credits"
                            className="text-warning text-xs">
                            Low
                        </span>
                    ) : undefined,
            },
            {
                id: "plugins",
                label: "Plugins",
                icon: BlocksIcon,
                href: "/settings/plugins",
                visible: canReadPlugins && isMCPAvailable,
                badge: (
                    <span className="bg-secondary-light/15 text-secondary-light rounded-full px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase">
                        Beta
                    </span>
                ),
            },
        ];

        return items;
    }, [
        subscription.license.valid,
        subscription.license.subscriptionStatus,
        "planType" in subscription.license
            ? subscription.license.planType
            : undefined,
        canReadPlugins,
        canReadRepositories,
        canEditOrg,
        isMCPAvailable,
        canReadPullRequests,
        canReadCliReviews,
        // The credit chip is built inside this memo, so its inputs belong
        // here. Without them the badge froze at its first render — the
        // balance had not arrived yet — and stayed blank afterwards, while
        // the topbar next to it announced that reviews were paused. Listed
        // field by field: `credits` is a fresh object every render.
        // Only what the nav actually reads now that the balance moved to the
        // page: the badge is a low-credit nudge, not a number.
        credits.usesKodusProvider,
        credits.routedThroughKodus,
        credits.low,
    ]);

    return items;
};
