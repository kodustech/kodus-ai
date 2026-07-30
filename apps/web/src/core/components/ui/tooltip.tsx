"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "src/core/utils/components";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipPortal = TooltipPrimitive.Portal;

const TooltipContent = React.forwardRef<
    React.ComponentRef<typeof TooltipPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
    // Portal to <body> so the tooltip escapes any `overflow` ancestor (e.g. the
    // virtualized/scroll containers on the Pull Requests table) instead of being
    // clipped. collisionPadding keeps it off the viewport edges.
    <TooltipPortal>
        <TooltipPrimitive.Content
            ref={ref}
            sideOffset={sideOffset}
            collisionPadding={collisionPadding}
            className={cn(
                "animate-in fade-in-0 zoom-in-95 bg-card-lv2 border-card-lv3 z-50 overflow-hidden rounded-xl border-1 px-3 py-1.5 text-xs shadow-md",
                "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
                "data-[side=bottom]:slide-in-from-top-2",
                "data-[side=left]:slide-in-from-right-2",
                "data-[side=right]:slide-in-from-left-2",
                "data-[side=top]:slide-in-from-bottom-2",
                className,
            )}
            {...props}
        />
    </TooltipPortal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    TooltipPortal,
};
