"use client";

import NextLink from "next/link";
import { SvgDiscord } from "@components/ui/icons/SvgDiscord";
import { SvgFounder } from "@components/ui/icons/SvgFounder";
import { Link } from "@components/ui/link";
import { useConfig } from "@providers/ConfigProvider";
import {
    ChevronsUpDownIcon,
    FileTextIcon,
    LogOutIcon,
    UserIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "src/core/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "src/core/components/ui/dropdown-menu";
import { useAuth } from "src/core/providers/auth.provider";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { VersionInfo } from "./version-info";

/**
 * The account row at the foot of the sidebar. The workspace switcher and
 * every settings page live in the sidebar itself, so the menu keeps only the
 * account, help and sign-out.
 */
export function UserNav({
    variant = "sidebar",
}: {
    /** "rail": the same menu behind a bare avatar, for the collapsed sidebar. */
    variant?: "sidebar" | "rail";
}) {
    const { email } = useAuth();
    const cfg = useConfig();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                {variant === "rail" ? (
                    <button
                        type="button"
                        data-testid="user-nav-trigger"
                        aria-label={`Account: ${email}`}
                        className="hover:bg-card-lv2 focus-visible:ring-ring flex size-9 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2">
                        <Avatar className="size-7">
                            <AvatarFallback>
                                <UserIcon className="size-4" />
                            </AvatarFallback>
                        </Avatar>
                    </button>
                ) : (
                    <button
                        type="button"
                        data-testid="user-nav-trigger"
                        className="hover:bg-card-lv2 focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2">
                        <Avatar className="size-7">
                            <AvatarFallback>
                                <UserIcon className="size-4" />
                            </AvatarFallback>
                        </Avatar>
                        <span className="text-text-secondary min-w-0 flex-1 truncate text-xs">
                            {email}
                        </span>
                        <ChevronsUpDownIcon className="text-text-tertiary size-3.5 shrink-0" />
                    </button>
                )}
            </DropdownMenuTrigger>

            <DropdownMenuContent
                className="w-60"
                align="start"
                side={variant === "rail" ? "right" : "top"}>
                <DropdownMenuLabel className="text-text-primary text-sm font-normal">
                    {email}
                </DropdownMenuLabel>

                <DropdownMenuSeparator />

                <DropdownMenuLabel>Help</DropdownMenuLabel>

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

                <DropdownMenuSeparator />

                <Link href="/sign-out" replace>
                    <DropdownMenuItem leftIcon={<LogOutIcon />}>
                        Sign out
                    </DropdownMenuItem>
                </Link>

                <DropdownMenuSeparator />
                <div className="px-2 py-1.5">
                    <VersionInfo showUpdate={isSelfHosted} />
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
