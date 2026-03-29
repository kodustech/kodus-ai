"use client";

import { usePathname } from "next/navigation";
import {
    RightSidebar,
    RightSidebarItem,
} from "@components/system/right-sidebar";
import { SupportSidebarButton } from "@components/system/support-sidebar-button";

import { TestReviewSidebarButton } from "./settings/code-review/_components/preview-sidebar-button";

interface AppRightSidebarProps {
    showTestReview?: boolean;
}

export const AppRightSidebar = ({ showTestReview }: AppRightSidebarProps) => {
    const pathname = usePathname();
    const isInCodeReviewSettings = pathname.includes("/settings/code-review/");

    return (
        <RightSidebar>
            {showTestReview && isInCodeReviewSettings && (
                <RightSidebarItem>
                    <TestReviewSidebarButton />
                </RightSidebarItem>
            )}

            <RightSidebarItem>
                <SupportSidebarButton />
            </RightSidebarItem>
        </RightSidebar>
    );
};
