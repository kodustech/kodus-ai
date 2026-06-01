"use client";

import { PropsWithChildren } from "react";
import { MagicModalPortal } from "@components/ui/magic-modal";
import { PermissionsMap } from "@services/permissions/types";
import type { Team } from "@services/teams/types";
import type { Session } from "next-auth";
import { FEATURE_FLAGS } from "src/core/config/feature-flags";
import { AllTeamsProvider } from "src/core/providers/all-teams-context";
import { AuthProvider } from "src/core/providers/auth.provider";
import { SubsciptionStatusProvider } from "src/core/providers/byok.provider";
import { PermissionsProvider } from "src/core/providers/permissions.provider";
import { SelectedTeamProvider } from "src/core/providers/selected-team-context";
import { OrganizationProvider } from "src/features/organization/_providers/organization-context";

import { FeatureFlagsProvider } from "./settings/_components/context";

type ProvidersProps = PropsWithChildren<{
    teams: Team[];
    session: Session | null;
    organization: {
        id: string;
        name: string;
    };
    permissions: PermissionsMap;
    isBYOK: boolean;
    isTrial: boolean;
    isEnterprise: boolean;
    featureFlags: Partial<{
        [K in keyof typeof FEATURE_FLAGS]: boolean;
    }>;
}>;

export function Providers({
    children,
    teams,
    session,
    organization,
    permissions,
    isBYOK,
    isTrial,
    isEnterprise,
    featureFlags,
}: ProvidersProps) {
    return (
        <AuthProvider session={session}>
            <PermissionsProvider permissions={permissions}>
                <OrganizationProvider organization={organization}>
                    <AllTeamsProvider teams={teams}>
                        <SubsciptionStatusProvider
                            isBYOK={isBYOK}
                            isTrial={isTrial}
                            isEnterprise={isEnterprise}>
                            <SelectedTeamProvider>
                                <FeatureFlagsProvider
                                    featureFlags={featureFlags}>
                                    {children}
                                    <MagicModalPortal />
                                </FeatureFlagsProvider>
                            </SelectedTeamProvider>
                        </SubsciptionStatusProvider>
                    </AllTeamsProvider>
                </OrganizationProvider>
            </PermissionsProvider>
        </AuthProvider>
    );
}
