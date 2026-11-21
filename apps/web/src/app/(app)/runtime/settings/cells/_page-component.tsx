"use client";

import NextLink from "next/link";
import { RuntimeEmptyState } from "@components/runtime/empty-state";
import { RuntimeHeader } from "@components/runtime/runtime-header";
import { RuntimeSection } from "@components/runtime/section";
import { Page } from "@components/ui/page";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { defaultCellTopology } from "@services/runtime/model/cell-registration";
import { ArrowLeftIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { ConnectCell } from "./_components/connect-cell";
import { RegistrationTokens } from "./_components/registration-tokens";

/**
 * Kody Runtime → Settings → Cells: connect a cell of your own with a
 * single-use registration token, and see and revoke the tokens made in the
 * last 24 hours (docs/runtime/self-hosted.md). The cells themselves are
 * listed, and revoked, on the Environments page.
 */
export const RuntimeCellsSettingsPage = () => {
    // POST/GET /runtime/cells/registration-tokens is the org owner's (checkRole OWNER),
    // the same people as Manage on RuntimeEnvironment.
    const isOwner = usePermission(
        Action.Manage,
        ResourceType.RuntimeEnvironment,
    );
    const { userId } = useAuth();

    return (
        <Page.Root>
            <RuntimeHeader />
            <Page.Content>
                <NextLink
                    href="/runtime/settings"
                    className="text-text-secondary flex w-fit items-center gap-1 text-sm hover:underline">
                    <ArrowLeftIcon className="size-4" /> Settings
                </NextLink>
                {!isOwner ? (
                    <RuntimeEmptyState title="Hosts are for the organization's owner">
                        Ask the owner of your organization to connect a host.
                    </RuntimeEmptyState>
                ) : (
                    <>
                        <RuntimeSection
                            title="Connect a host"
                            description="A host is a Linux server of yours that runs Kody's machines, where Kody builds and runs the app of each pull request. It registers once with a token from here and then connects out to the hub over mutual TLS: nothing on it is opened to the internet.">
                            <ConnectCell
                                defaultTopology={defaultCellTopology(
                                    isSelfHosted,
                                )}
                            />
                        </RuntimeSection>
                        <RuntimeSection
                            title="Registration tokens"
                            description="Tokens made in the last 24 hours. Revoke one you no longer need, or one that was pasted somewhere it should not have been: no host can register with it afterwards.">
                            <RegistrationTokens currentUserId={userId} />
                            <p className="text-text-tertiary text-xs">
                                Your hosts, their status and Revoke are on the{" "}
                                <NextLink
                                    href="/runtime/environments"
                                    className="underline">
                                    Environments page
                                </NextLink>
                                .
                            </p>
                        </RuntimeSection>
                    </>
                )}
            </Page.Content>
        </Page.Root>
    );
};
