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
    ChevronsUpDownIcon,
    CreditCardIcon,
    FileTextIcon,
    FolderGit2Icon,
    LockIcon,
    LogOutIcon,
    PanelLeftIcon,
    PanelTopIcon,
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
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { TEAM_STATUS } from "src/core/types";
import { isSelfHosted } from "src/core/utils/self-hosted";
import { useFeatureGates } from "src/features/ee/subscription/_hooks/use-feature-gates";

import { useSetNavLayout } from "../../nav-layout";
import { VersionInfo } from "./version-info";

export function UserNav({
    variant = "navbar",
}: {
    /**
     * "sidebar": the account row at the foot of the sidebar navigation. The
     * workspace switcher and the settings links live in the sidebar itself
     * there, so the menu keeps only the account, help and sign-out.
     */
    variant?: "navbar" | "sidebar" | "rail";
}) {
    // "rail": the same menu behind a bare avatar, for the collapsed sidebar.
    const inSidebar = variant === "sidebar" || variant === "rail";
    const setNavLayout = useSetNavLayout();
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
    const cfg = useConfig();
    // Gated entries stay listed with a padlock; each page shows its locked
    // preview.
    const gates = useFeatureGates();

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
                ) : inSidebar ? (
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
                ) : (
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
                )}
            </DropdownMenuTrigger>

            <DropdownMenuContent
                className="w-60"
                align={inSidebar ? "start" : "end"}
                side={
                    variant === "rail" ? "right" : inSidebar ? "top" : "bottom"
                }>
                <DropdownMenuLabel className="text-text-primary text-sm font-normal">
                    {email}
                </DropdownMenuLabel>

                {!inSidebar && (
                    <>
                        <DropdownMenuSeparator />

                        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>

                        <DropdownMenuRadioGroup
                            value={teamId}
                            onValueChange={handleChangeWorkspace}>
                            {teams.map((team) => (
                                <DropdownMenuRadioItem
                                    key={team.uuid}
                                    value={team.uuid}
                                    disabled={
                                        team.status !== TEAM_STATUS.ACTIVE
                                    }>
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
                                <DropdownMenuItem leftIcon={<FolderGit2Icon />}>
                                    Repositories
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

                        {canReadLogs && (
                            <Link href="/user-logs">
                                <DropdownMenuItem leftIcon={<ActivityIcon />}>
                                    Activity Logs
                                    {!gates.activityLogs && <LockedTag />}
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
                    </>
                )}

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

                <DropdownMenuItem
                    leftIcon={inSidebar ? <PanelTopIcon /> : <PanelLeftIcon />}
                    onSelect={() =>
                        setNavLayout(inSidebar ? "top" : "sidebar")
                    }>
                    {inSidebar
                        ? "Back to top navigation"
                        : "Try sidebar navigation"}
                </DropdownMenuItem>

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

/** Padlock at the end of a menu row whose page needs a higher plan. */
const LockedTag = () => (
    <LockIcon
        aria-label="Enterprise plan"
        className="text-text-tertiary ml-auto size-3.5"
    />
);
