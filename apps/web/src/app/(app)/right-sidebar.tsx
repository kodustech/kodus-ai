"use client";

import {
    RightSidebar,
    RightSidebarItem,
} from "@components/system/right-sidebar";
import { SupportSidebarButton } from "@components/system/support-sidebar-button";

export const AppRightSidebar = () => {
    return (
        <RightSidebar>
            <RightSidebarItem>
                <SupportSidebarButton />
            </RightSidebarItem>
        </RightSidebar>
    );
};
