"use client";

import { Suspense, useEffect } from "react";
import { Sheet, SheetTrigger } from "@components/ui/sheet";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { FlaskConical } from "lucide-react";
import { cn } from "src/core/utils/components";

import { DryRunSidebar } from "./dry-run-sidebar";

interface TestReviewSidebarButtonProps {
    className?: string;
}

export const TestReviewSidebarButton = ({
    className,
}: TestReviewSidebarButtonProps) => {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Cmd/Ctrl + Alt/Option + T (Test)
            if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyT") {
                e.preventDefault();
                document
                    .querySelector<HTMLButtonElement>(
                        "[data-test-review-button]",
                    )
                    ?.click();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

    return (
        <Sheet>
            <TooltipProvider>
                <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                        <SheetTrigger asChild>
                            <button
                                data-test-review-button
                                className={cn(
                                    "group relative flex flex-col items-center justify-center",
                                    "w-full px-2 py-4",
                                    "text-text-tertiary hover:text-text-primary",
                                    "hover:bg-background-tertiary transition-all duration-200",
                                    "cursor-pointer border-0 bg-transparent",
                                    className,
                                )}>
                                <FlaskConical className="mb-2 size-5" />
                                <span
                                    className="text-md leading-tight font-medium tracking-tight"
                                    style={{
                                        writingMode: "vertical-rl",
                                        textOrientation: "mixed",
                                    }}>
                                    Test
                                </span>
                            </button>
                        </SheetTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="left" sideOffset={10}>
                        <div className="flex flex-col gap-1">
                            <span className="font-semibold">
                                Test Review Settings
                            </span>
                            <span className="text-text-tertiary text-[11px]">
                                Run a real review on a closed PR to test your
                                current configuration
                            </span>
                            <span className="text-text-tertiary mt-1 text-[11px]">
                                ⌘⌥T
                            </span>
                        </div>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>

            <Suspense fallback={null}>
                <DryRunSidebar />
            </Suspense>
        </Sheet>
    );
};
