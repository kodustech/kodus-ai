"use client";

import { useState } from "react";
import { Bell } from "lucide-react";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";

import { useUnreadCount } from "@services/notifications/hooks";

import { NotificationDrawer } from "./notification-drawer";

export const NotificationBell = () => {
    const [open, setOpen] = useState(false);
    const unreadCount = useUnreadCount();

    return (
        <>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        id="notification-bell"
                        type="button"
                        aria-label={
                            unreadCount > 0
                                ? `Notifications (${unreadCount} unread)`
                                : "Notifications"
                        }
                        onClick={() => setOpen(true)}
                        className="relative flex size-9 items-center justify-center rounded-full text-[#cdcddf] transition-colors hover:bg-[#202032] hover:text-white">
                        <Bell className="size-5" />
                        {unreadCount > 0 && (
                            <span className="ring-background absolute top-1 right-1 flex size-[18px] items-center justify-center rounded-full bg-red-500 text-xs font-bold tabular-nums text-white ring-2">
                                {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                        )}
                    </button>
                </TooltipTrigger>
                <TooltipContent>
                    <p>
                        {unreadCount > 0
                            ? `${unreadCount} unread notification${unreadCount > 1 ? "s" : ""}`
                            : "No new notifications"}
                    </p>
                </TooltipContent>
            </Tooltip>

            <NotificationDrawer open={open} onOpenChange={setOpen} />
        </>
    );
};
