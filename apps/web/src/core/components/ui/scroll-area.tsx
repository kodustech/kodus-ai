"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "src/core/utils/components";

const ScrollArea = React.forwardRef<
    React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
        orientation?: "vertical" | "horizontal";
        viewportClassName?: string;
    }
>(({ className, viewportClassName, children, ...props }, ref) => (
    <ScrollAreaPrimitive.Root
        ref={ref}
        className={cn("relative overflow-hidden", className)}
        {...props}>
        <ScrollAreaPrimitive.Viewport
            className={cn(
                "h-full w-full rounded-[inherit]",
                viewportClassName,
            )}>
            {children}
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar orientation={props.orientation} />
        <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
    React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
    React.ComponentPropsWithoutRef<
        typeof ScrollAreaPrimitive.ScrollAreaScrollbar
    >
>(({ className, orientation = "vertical", ...props }, ref) => (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
        ref={ref}
        orientation={orientation}
        className={cn(
            "z-50 flex touch-none transition select-none",
            orientation === "vertical" &&
                "h-full w-2.5 border-l border-l-transparent p-[1px]",
            orientation === "horizontal" &&
                "h-2.5 flex-col border-t border-t-transparent p-[1px]",
            className,
        )}
        {...props}>
        <ScrollAreaPrimitive.ScrollAreaThumb className="bg-card-lv3 relative flex-1 rounded-full" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
