"use client";

import { useEffect } from "react";
import NextLink from "next/link";
import { SvgDiscord } from "@components/ui/icons/SvgDiscord";
import { SvgFounder } from "@components/ui/icons/SvgFounder";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { FileTextIcon, Headset, LifeBuoy } from "lucide-react";
import { useConfig } from "@providers/ConfigProvider";
import { cn } from "src/core/utils/components";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";
import { isSelfHosted } from "src/core/utils/self-hosted";

function useShowHelpdesk() {
    const subscription = useSubscriptionStatus();

    if (isSelfHosted) return false;

    const planType =
        "planType" in subscription ? subscription.planType : undefined;
    if (!planType) return false;

    return planType.startsWith("enterprise");
}

export const SupportSidebarButton = () => {
    const cfg = useConfig();
    const showHelpdesk = useShowHelpdesk();

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Cmd/Ctrl + Alt/Option + H (Help)
            if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyH") {
                e.preventDefault();
                document
                    .querySelector<HTMLButtonElement>("[data-support-button]")
                    ?.click();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

    return (
        <Popover>
            <TooltipProvider>
                <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                            <button
                                data-support-button
                                className={cn(
                                    "group relative flex flex-col items-center justify-center",
                                    "w-full px-2 py-4",
                                    "text-text-tertiary hover:text-text-primary",
                                    "hover:bg-background-tertiary transition-all duration-200",
                                    "cursor-pointer border-0 bg-transparent",
                                )}>
                                <LifeBuoy className="mb-2 size-5" />
                                <span
                                    className="text-sm leading-tight font-medium tracking-tight"
                                    style={{
                                        writingMode: "vertical-rl",
                                        textOrientation: "mixed",
                                    }}>
                                    Support
                                </span>
                            </button>
                        </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="left" sideOffset={10}>
                        <div className="flex flex-col gap-1">
                            <span className="font-semibold">Support</span>
                            <span className="text-text-tertiary text-[11px]">
                                ⌘⌥H
                            </span>
                        </div>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>

            <PopoverContent
                align="end"
                side="left"
                sideOffset={10}
                className="w-52 p-0">
                <div className="flex flex-col">
                    {showHelpdesk && (
                        <NextLink
                            href="/helpdesk"
                            className={cn(
                                "flex items-center gap-3 px-4 py-3",
                                "text-text-secondary hover:text-text-primary hover:bg-background-tertiary",
                                "border-border-primary cursor-pointer border-b transition-colors",
                            )}>
                            <Headset className="size-4" />
                            <span className="text-sm">Helpdesk</span>
                        </NextLink>
                    )}

                    <NextLink
                        target="_blank"
                        href={cfg.supportDocsUrl || ""}
                        className={cn(
                            "flex items-center gap-3 px-4 py-3",
                            "text-text-secondary hover:text-text-primary hover:bg-background-tertiary",
                            "border-border-primary cursor-pointer border-b transition-colors",
                        )}>
                        <FileTextIcon className="size-4" />
                        <span className="text-sm">View docs</span>
                    </NextLink>

                    <NextLink
                        target="_blank"
                        href={cfg.supportDiscordInviteUrl || ""}
                        className={cn(
                            "flex items-center gap-3 px-4 py-3",
                            "text-text-secondary hover:text-text-primary hover:bg-background-tertiary",
                            "border-border-primary cursor-pointer border-b transition-colors",
                        )}>
                        <SvgDiscord className="size-4" />
                        <span className="text-md">Our Discord</span>
                    </NextLink>

                    <NextLink
                        target="_blank"
                        href={cfg.supportTalkToFounderUrl || ""}
                        className={cn(
                            "flex items-center gap-3 px-4 py-3",
                            "text-text-secondary hover:text-text-primary hover:bg-background-tertiary",
                            "cursor-pointer transition-colors",
                        )}>
                        <SvgFounder className="size-4" />
                        <span className="text-sm">Talk to a Founder</span>
                    </NextLink>
                </div>
            </PopoverContent>
        </Popover>
    );
};
