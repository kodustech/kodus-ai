"use client";

import NextLink from "next/link";
import { Button } from "@components/ui/button";
import { SvgDiscord } from "@components/ui/icons/SvgDiscord";
import { SvgFounder } from "@components/ui/icons/SvgFounder";
import { useConfig } from "@providers/ConfigProvider";
import { ChevronDown, FileTextIcon } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "src/core/components/ui/dropdown-menu";

export const SupportDropdown = () => {
    const cfg = useConfig();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="helper" size="sm" rightIcon={<ChevronDown />}>
                    Support
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent className="w-52" align="end">
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
