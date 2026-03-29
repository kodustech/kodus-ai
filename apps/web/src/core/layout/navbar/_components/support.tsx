"use client";

import NextLink from "next/link";
import { Button } from "@components/ui/button";
import { SvgDiscord } from "@components/ui/icons/SvgDiscord";
import { SvgFounder } from "@components/ui/icons/SvgFounder";
import { ChevronDown, FileTextIcon } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "src/core/components/ui/dropdown-menu";

export const SupportDropdown = () => {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="helper" size="sm" rightIcon={<ChevronDown />}>
                    Support
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent className="w-52" align="end">
                <NextLink
                    target="_blank"
                    href={process.env.WEB_SUPPORT_DOCS_URL ?? ""}>
                    <DropdownMenuItem leftIcon={<FileTextIcon />}>
                        View docs
                    </DropdownMenuItem>
                </NextLink>

                <NextLink
                    target="_blank"
                    href={process.env.WEB_SUPPORT_DISCORD_INVITE_URL ?? ""}>
                    <DropdownMenuItem leftIcon={<SvgDiscord />}>
                        Our Discord
                    </DropdownMenuItem>
                </NextLink>

                <NextLink
                    target="_blank"
                    href={process.env.WEB_SUPPORT_TALK_TO_FOUNDER_URL ?? ""}>
                    <DropdownMenuItem leftIcon={<SvgFounder />}>
                        Talk to a Founder
                    </DropdownMenuItem>
                </NextLink>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
