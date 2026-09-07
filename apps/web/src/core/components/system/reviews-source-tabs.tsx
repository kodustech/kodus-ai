"use client";

import { usePathname } from "next/navigation";
import { LinkTab, LinkTabs } from "@components/ui/link-tabs";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";

/**
 * "Reviews" is one navbar entry with two sources: pull requests and the CLI.
 * Both pages render this strip in place of their title so the split reads
 * as tabs of one area, not two products.
 */
export const ReviewsSourceTabs = () => {
    const pathname = usePathname();
    const canReadPullRequests = usePermission(
        Action.Read,
        ResourceType.PullRequests,
    );
    const canReadCliReviews = usePermission(
        Action.Read,
        ResourceType.CliReview,
    );

    return (
        <LinkTabs aria-label="Review sources" className="-ml-4 border-b-0">
            {canReadPullRequests && (
                <LinkTab
                    href="/pull-requests"
                    active={pathname.startsWith("/pull-requests")}
                    className="text-base">
                    Pull requests
                </LinkTab>
            )}
            {canReadCliReviews && (
                <LinkTab
                    href="/cli-reviews"
                    active={pathname.startsWith("/cli-reviews")}
                    className="text-base">
                    CLI
                </LinkTab>
            )}
        </LinkTabs>
    );
};
