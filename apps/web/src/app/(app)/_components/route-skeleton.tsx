"use client";

import { usePathname } from "next/navigation";
import {
    AiProvidersPageSkeleton,
    AppPageSkeleton,
    CockpitPageSkeleton,
    IssuesPageSkeleton,
    LibraryPageSkeleton,
    OrganizationPageSkeleton,
    ReviewsPageSkeleton,
    SettingsPageSkeleton,
} from "@components/system/page-skeletons";
import { TokenUsagePageSkeleton } from "src/features/ee/token-usage/_components/page-skeleton";

import { KodyRulesPageSkeleton } from "../settings/code-review/[repositoryId]/kody-rules/_components/page-skeleton";

const KODY_RULES_PATH = /^\/settings\/code-review\/[^/]+\/kody-rules/;

/**
 * The skeleton of the page a navigation is heading to. Section layouts
 * (cockpit, settings, organization…) fetch before they render, and until
 * they do Next shows the nearest loading boundary ABOVE them — a generic
 * one — so moving from Reviews to the Cockpit, or from Plugins to General,
 * flashed another page's shape first. The pathname here is already the
 * target's, so the boundary can draw the page that is actually coming.
 */
export const RouteSkeleton = () => {
    const pathname = usePathname() ?? "";

    if (KODY_RULES_PATH.test(pathname)) return <KodyRulesPageSkeleton />;
    if (
        pathname === "/settings" ||
        pathname.startsWith("/settings/code-review")
    )
        return <SettingsPageSkeleton />;
    if (pathname.startsWith("/organization"))
        return <OrganizationPageSkeleton />;
    if (pathname.startsWith("/cockpit")) return <CockpitPageSkeleton />;
    if (pathname.startsWith("/issues")) return <IssuesPageSkeleton />;
    if (pathname.startsWith("/byok")) return <AiProvidersPageSkeleton />;
    if (pathname.startsWith("/library")) return <LibraryPageSkeleton />;
    if (pathname.startsWith("/token-usage")) return <TokenUsagePageSkeleton />;
    if (
        /^\/pull-requests\/?$/.test(pathname) ||
        pathname.startsWith("/cli-reviews")
    )
        return <ReviewsPageSkeleton />;

    // Tables and lists: Repositories, Plugins, a PR's review, logs.
    return <AppPageSkeleton />;
};
