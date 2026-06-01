"use client";

import NextLink from "next/link";
import { Button } from "@components/ui/button";
import { SvgDiscord } from "@components/ui/icons/SvgDiscord";
import { SvgFounder } from "@components/ui/icons/SvgFounder";
import { ChevronDown, FileTextIcon, Headset } from "lucide-react";
import { useConfig } from "@providers/ConfigProvider";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "src/core/components/ui/dropdown-menu";
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

export const SupportDropdown = () => {
    const cfg = useConfig();
    const showHelpdesk = useShowHelpdesk();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="helper" size="sm" rightIcon={<ChevronDown />}>
                    Support
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent className="w-52" align="end">
                {showHelpdesk && (
                    <NextLink href="/helpdesk">
                        <DropdownMenuItem leftIcon={<Headset />}>
                            Helpdesk
                        </DropdownMenuItem>
                    </NextLink>
                )}

                <NextLink target="_blank" href={cfg.supportDocsUrl || ""}>
                    <DropdownMenuItem leftIcon={<FileTextIcon />}>
                        View docs
                    </DropdownMenuItem>
                </NextLink>

                <NextLink
                    target="_blank"
                    href={cfg.supportDiscordInviteUrl || ""}>
                    <DropdownMenuItem leftIcon={<SvgDiscord />}>
                        Our Discord
                    </DropdownMenuItem>
                </NextLink>

                <NextLink
                    target="_blank"
                    href={cfg.supportTalkToFounderUrl || ""}>
                    <DropdownMenuItem leftIcon={<SvgFounder />}>
                        Talk to a Founder
                    </DropdownMenuItem>
                </NextLink>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
