"use client";

import { usePathname, useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import type { INTEGRATIONS_KEY } from "@enums";
import { useAsyncAction } from "@hooks/use-async-action";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { getConnectionsOnClient } from "@services/setup/fetch";
import { deleteCookie, setCookie } from "cookies-next";
import { useFeatureFlags } from "src/app/(app)/settings/_components/context";
import integrationFactory from "src/core/integrations/integrationFactory";
import { useAllTeams } from "src/core/providers/all-teams-context";
import { useConfig } from "@providers/ConfigProvider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import type { AwaitedReturnType } from "src/core/types";
import { safeArray } from "src/core/utils/safe-array";

import { CODE_MANAGEMENT_PLATFORMS } from "../../_constants";
import { openProviderModal } from "./helpers";

export const ProviderOptionButton = (props: {
    provider: keyof typeof CODE_MANAGEMENT_PLATFORMS;
}) => {
    const platformData = CODE_MANAGEMENT_PLATFORMS[props.provider];
    const canCreate = usePermission(Action.Create, ResourceType.GitSettings);

    const router = useRouter();
    const pathname = usePathname();
    const cfg = useConfig();
    const { teamId } = useSelectedTeamId();
    const { teams } = useAllTeams();
    const { githubEnterpriseServerPat } = useFeatureFlags();

    const goToProviderOauthPage = (
        provider: INTEGRATIONS_KEY,
        connections: AwaitedReturnType<typeof getConnectionsOnClient>,
    ) => {
        const integrationConnector = integrationFactory.getConnector(
            provider.toLowerCase(),
            cfg,
        );

        if (!integrationConnector) return;

        const findConnection = safeArray(connections).find(
            (c) => c.platformName.toLowerCase() === provider.toLowerCase(),
        );

        integrationConnector.connect(
            findConnection?.hasConnection ?? false,
            { push: router.push, pathname: pathname },
            "",
            findConnection?.config?.url,
        );
    };

    const [handleIntegrationClick, { loading }] = useAsyncAction(async () => {
        deleteCookie("selectedTeam");

        const connections = await getConnectionsOnClient(teamId);
        const team = teams.find((t) => t.uuid === teamId);

        await openProviderModal({
            provider: props.provider,
            teamId,
            githubEnterpriseServerPatEnabled: !!githubEnterpriseServerPat,
            onGoToOauth: () => {
                setCookie("selectedTeam", JSON.stringify(team));
                goToProviderOauthPage(props.provider, connections);
            },
            onSaveToken: () => {
                router.push("/settings/git/repositories");
            },
        });
    });

    return (
        <Button
            size="lg"
            variant="helper"
            loading={loading}
            disabled={!canCreate}
            onClick={() => handleIntegrationClick()}
            className="peer peer-button-loading:pointer-events-none h-40 flex-1 flex-col">
            <span className="*:size-10!">
                <platformData.svg />
            </span>

            {platformData.platformName}
        </Button>
    );
};
