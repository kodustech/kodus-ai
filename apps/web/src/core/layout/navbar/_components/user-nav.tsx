"use client";

import NextLink from "next/link";
import { SvgDiscord } from "@components/ui/icons/SvgDiscord";
import { SvgFounder } from "@components/ui/icons/SvgFounder";
import { Link } from "@components/ui/link";
import { toast } from "@components/ui/toaster/use-toast";
import { useConfig } from "@providers/ConfigProvider";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    ActivityIcon,
    Building2Icon,
    ChartColumn,
    CreditCardIcon,
    FileTextIcon,
    GitBranchIcon,
    Headset,
    KeyRoundIcon,
    LogOutIcon,
    UserIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "src/core/components/ui/avatar";
import { Button } from "src/core/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "src/core/components/ui/dropdown-menu";
import { useAllTeams } from "src/core/providers/all-teams-context";
import { useAuth } from "src/core/providers/auth.provider";
import { useSubscriptionStatus } from "src/core/providers/byok.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { TEAM_STATUS } from "src/core/types";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { VersionInfo } from "./version-info";

export function UserNav() {
    const { email } = useAuth();
    const { teams } = useAllTeams();
    const { teamId, setTeamId } = useSelectedTeamId();
    const canEditOrg = usePermission(
        Action.Update,
        ResourceType.OrganizationSettings,
    );
    const canReadLogs = usePermission(Action.Read, ResourceType.Logs);
    const canReadGitSettings = usePermission(
        Action.Read,
        ResourceType.GitSettings,
    );
    const canReadBilling = usePermission(Action.Read, ResourceType.Billing);
    const canReadTokenUsage = usePermission(
        Action.Read,
        ResourceType.TokenUsage,
    );
    const { isBYOK, isTrial, isEnterprise } = useSubscriptionStatus();
    const cfg = useConfig();
    // Helpdesk is an enterprise-cloud channel; the other links are public.
    const showHelpdesk = !isSelfHosted && isEnterprise;

    const handleChangeWorkspace = (teamId: string) => {
        setTeamId(teamId);

        const team = teams.find((team) => team.uuid === teamId);

        toast({
            variant: "info",
            description: (
                <span>
                    Workspace changed to{" "}
                    <span className="text-primary-light font-bold">
                        {team?.name}
                    </span>
                </span>
            ),
        });
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    data-testid="user-nav-trigger"
                    size="icon-md"
                    variant="cancel"
                    className="rounded-full">
                    <Avatar className="size-full">
                        {/* TODO: call user's avatar */}
                        {/* <AvatarImage src="" alt="username" /> */}
                        {/* TODO: call user's name and get initials */}
                        <AvatarFallback>
                            <UserIcon />
                        </AvatarFallback>
                    </Avatar>
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent className="w-60" align="end">
                <DropdownMenuLabel className="text-text-primary text-sm font-normal">
                    {email}
                </DropdownMenuLabel>

                <DropdownMenuSeparator />

                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>

                <DropdownMenuRadioGroup
                    value={teamId}
                    onValueChange={handleChangeWorkspace}>
                    {teams.map((team) => (
                        <DropdownMenuRadioItem
                            key={team.uuid}
                            value={team.uuid}
                            disabled={team.status !== TEAM_STATUS.ACTIVE}>
                            {team.name}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>

                <DropdownMenuSeparator />

                {canEditOrg && (
                    <Link href="/organization/general">
                        <DropdownMenuItem leftIcon={<Building2Icon />}>
                            Organization
                        </DropdownMenuItem>
                    </Link>
                )}

                {canReadGitSettings && (
                    <Link href="/settings/git">
                        <DropdownMenuItem leftIcon={<GitBranchIcon />}>
                            Git Settings
                        </DropdownMenuItem>
                    </Link>
                )}

                {canReadBilling && (
                    <Link href="/settings/subscription">
                        <DropdownMenuItem leftIcon={<CreditCardIcon />}>
                            Subscription
                        </DropdownMenuItem>
                    </Link>
                )}

                {canEditOrg && (
                    <Link href="/byok">
                        <DropdownMenuItem leftIcon={<KeyRoundIcon />}>
                            BYOK
                        </DropdownMenuItem>
                    </Link>
                )}

                {(isEnterprise || isTrial) && canReadLogs && (
                    <Link href="/user-logs">
                        <DropdownMenuItem leftIcon={<ActivityIcon />}>
                            Activity Logs
                        </DropdownMenuItem>
                    </Link>
                )}

                {canReadTokenUsage && (
                    <Link href="/token-usage">
                        <DropdownMenuItem
                            data-testid="nav-token-usage"
                            leftIcon={<ChartColumn />}>
                            Token Usage
                        </DropdownMenuItem>
                    </Link>
                )}

                <DropdownMenuSeparator />

                <DropdownMenuLabel>Help</DropdownMenuLabel>

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
