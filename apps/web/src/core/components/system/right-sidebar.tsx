"use client";

import { cn } from "src/core/utils/components";

interface RightSidebarProps {
    children?: React.ReactNode;
}

export const RightSidebar = ({ children }: RightSidebarProps) => {
    return (
        <aside
            className={cn(
                "fixed top-0 right-0 bottom-0 z-50",
                "flex h-screen flex-col items-center justify-start",
                "bg-background-secondary border-border-primary border-l",
                "gap-1 py-4",
                "w-[60px]",
                "pointer-events-none",
            )}>
            <div className="pointer-events-auto flex flex-col items-center gap-1">
                {children}
            </div>
        </aside>
    );
};

interface RightSidebarItemProps {
    children: React.ReactNode;
    className?: string;
}

export const RightSidebarItem = ({
    children,
    className,
}: RightSidebarItemProps) => {
    return (
        <div
            className={cn(
                "flex w-full items-center justify-center",
                className,
            )}>
            {children}
        </div>
    );
};
