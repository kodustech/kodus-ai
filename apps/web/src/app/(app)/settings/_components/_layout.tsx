"use client";

import { useMemo } from "react";
import { redirect, usePathname } from "next/navigation";
import { magicModal } from "@components/ui/magic-modal";
import {
    useCodeReviewSettingsShell,
    useSuspenseGetDefaultCodeReviewParameter,
    useSuspenseGetParameterPlatformConfigs,
} from "@services/parameters/hooks";
import {
    KodyLearningStatus,
    ParametersConfigKey,
    type PlatformConfigValue,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { CustomMessageConfig } from "@services/pull-request-messages/types";
import {
    ScopeToolsPortal,
    useLendAddRepository,
    useLendOverrideCount,
    useScopeTools,
    type RenderOverrideCount,
} from "src/core/layout/sidebar/scope-tools";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { safeArray } from "src/core/utils/safe-array";

import { useCodeReviewRouteParams } from "../_hooks";
import { RouteSkeleton } from "../../_components/route-skeleton";
import {
    type CodeReviewGlobalConfig,
    type FormattedGlobalCodeReviewConfig,
} from "../code-review/_types";
import { resolveCodeReviewConfigForScope } from "./code-review-config-scope";
import {
    AutomationCodeReviewConfigProvider,
    CodeReviewConfigFetchStateProvider,
    CodeReviewModelDataProvider,
    DefaultCodeReviewConfigProvider,
    InitialParametersProvider,
    PlatformConfigProvider,
    ScopedCodeReviewConfigProvider,
    type CodeReviewModelData,
} from "./context";
import { AddRepoModal } from "./copy-settings-modal";
import { KodusConfigFileStatusBadge } from "./kodus-config-file-status";
import { OverrideCount } from "./override-count";
import { SidebarRepositoryOrDirectoryDropdown } from "./per-repository/options-dropdown";

type InitialPlatformConfig = {
    uuid: string;
    configKey: ParametersConfigKey.PLATFORM_CONFIGS;
    configValue: PlatformConfigValue;
};

type InitialDefaultConfig = CodeReviewGlobalConfig & {
    customMessages: CustomMessageConfig;
};

type SettingsLayoutProps = React.PropsWithChildren<{
    initialTeamId: string;
    // Undefined when the server-side fetch was skipped, timed out or failed —
    // the matching client hook then fetches it instead of the page blanking.
    initialConfigValue: FormattedGlobalCodeReviewConfig | undefined;
    initialDefaultConfig: InitialDefaultConfig | undefined;
    initialPlatformConfig: InitialPlatformConfig | undefined;
    initialParameters: Partial<
        Record<
            string,
            { uuid: string; configKey: string; configValue: string } | null
        >
    >;
    initialModelData: CodeReviewModelData;
}>;

export const SettingsLayout = ({
    children,
    initialTeamId,
    initialConfigValue,
    initialDefaultConfig,
    initialPlatformConfig,
    initialParameters,
    initialModelData,
}: SettingsLayoutProps) => {
    const { teamId } = useSelectedTeamId();
    const effectiveTeamId = teamId ?? initialTeamId;
    const defaultConfig = useSuspenseGetDefaultCodeReviewParameter({
        initialData: initialDefaultConfig,
    });
    const platformConfig = useSuspenseGetParameterPlatformConfigs(
        effectiveTeamId,
        {
            initialData:
                effectiveTeamId === initialTeamId
                    ? initialPlatformConfig
                    : undefined,
        },
    );

    const initialShellQueryData = useMemo<
        | {
              uuid: string;
              configKey: ParametersConfigKey.CODE_REVIEW_CONFIG;
              configValue: FormattedGlobalCodeReviewConfig;
          }
        | undefined
    >(
        () =>
            initialConfigValue
                ? {
                      uuid: "",
                      configKey: ParametersConfigKey.CODE_REVIEW_CONFIG,
                      configValue: initialConfigValue,
                  }
                : undefined,
        [initialConfigValue],
    );

    const {
        data: liveShellQuery,
        isFetching: isShellFetching,
        isError: isShellError,
    } = useCodeReviewSettingsShell(effectiveTeamId, {
        initialData:
            effectiveTeamId === initialTeamId
                ? initialShellQueryData
                : undefined,
    });

    return (
        <CodeReviewModelDataProvider value={initialModelData}>
            <CodeReviewConfigFetchStateProvider
                value={{
                    isFetching: isShellFetching,
                    isError: isShellError,
                }}>
                <InitialParametersProvider
                    value={{ initialTeamId, parameters: initialParameters }}>
                    <SettingsLayoutShell
                        teamId={effectiveTeamId}
                        configValue={
                            liveShellQuery?.configValue ?? initialConfigValue
                        }
                        defaultConfig={defaultConfig ?? initialDefaultConfig}
                        platformConfig={
                            platformConfig ?? initialPlatformConfig
                        }>
                        {children}
                    </SettingsLayoutShell>
                </InitialParametersProvider>
            </CodeReviewConfigFetchStateProvider>
        </CodeReviewModelDataProvider>
    );
};

function SettingsLayoutShell({
    children,
    configValue,
    defaultConfig,
    platformConfig,
}: React.PropsWithChildren<{
    teamId: string;
    configValue: FormattedGlobalCodeReviewConfig | undefined;
    defaultConfig: InitialDefaultConfig;
    platformConfig: InitialPlatformConfig;
}>) {
    const pathname = usePathname();
    const { repositoryId, pageName, directoryId } = useCodeReviewRouteParams();

    const isShellLoading = !configValue;

    const scopedConfig = useMemo(
        () =>
            configValue
                ? resolveCodeReviewConfigForScope(
                      configValue,
                      repositoryId,
                      directoryId,
                  )
                : undefined,
        [configValue, directoryId, repositoryId],
    );

    if (!isShellLoading && repositoryId && repositoryId !== "global") {
        const repository = safeArray(configValue?.repositories).find(
            (repositoryItem) => repositoryItem.id === repositoryId,
        );

        if (!repository) {
            redirect(`/settings/code-review/global/${pageName}`);
        }

        if (!repository?.isSelected) {
            const directory = safeArray(repository?.directories).find(
                (directoryItem) => directoryItem.id === directoryId,
            );

            if (!directory) {
                redirect(`/settings/code-review/global/${pageName}`);
            }
        }
    }

    const content = configValue ? (
        <DefaultCodeReviewConfigProvider config={defaultConfig}>
            <AutomationCodeReviewConfigProvider config={configValue}>
                <ScopedCodeReviewConfigProvider config={scopedConfig}>
                    <PlatformConfigProvider config={platformConfig.configValue}>
                        {pathname.startsWith("/settings/code-review") && (
                            <CodeReviewScopeTools
                                configValue={configValue}
                                platformConfigValue={platformConfig.configValue}
                            />
                        )}
                        {children}
                    </PlatformConfigProvider>
                </ScopedCodeReviewConfigProvider>
            </AutomationCodeReviewConfigProvider>
        </DefaultCodeReviewConfigProvider>
    ) : (
        <RouteSkeleton />
    );

    return (
        <div className="flex flex-1 flex-col overflow-hidden">{content}</div>
    );
}

/**
 * The scope tools that need the full configuration this layout loads, lent
 * to the sidebar's scope picker (see scope-tools.tsx): the scope's options
 * menu and kodus-config.yml badge render under the picker, "Add repository
 * configuration" joins the picker's footer, and each scope and page gets its
 * override count.
 */
function CodeReviewScopeTools({
    configValue,
    platformConfigValue,
}: {
    configValue: FormattedGlobalCodeReviewConfig;
    platformConfigValue: PlatformConfigValue;
}) {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const canCreate = usePermission(
        Action.Create,
        ResourceType.CodeReviewSettings,
    );

    const repository =
        repositoryId && repositoryId !== "global"
            ? safeArray(configValue.repositories).find(
                  (item) => item.id === repositoryId,
              )
            : undefined;
    const directory = directoryId
        ? repository?.directories?.find((item) => item.id === directoryId)
        : undefined;

    const canAddRepository =
        canCreate &&
        platformConfigValue.kodyLearningStatus !==
            KodyLearningStatus.GENERATING_CONFIG;
    const openAddRepository = useMemo(
        () =>
            canAddRepository
                ? () =>
                      magicModal.show(() => (
                          <AddRepoModal
                              repositories={configValue.repositories}
                          />
                      ))
                : undefined,
        [canAddRepository, configValue.repositories],
    );
    useLendAddRepository(openAddRepository);
    const renderOverrideCount = useMemo<RenderOverrideCount>(
        () =>
            function renderOverrideCount({ scope, pages }) {
                return (
                    <OverrideCount
                        config={configValue}
                        scope={scope}
                        pages={pages}
                    />
                );
            },
        [configValue],
    );
    useLendOverrideCount(renderOverrideCount);
    const compact = useScopeTools()?.compact ?? false;

    return (
        <>
            <ScopeToolsPortal slot="status">
                <KodusConfigFileStatusBadge compact={compact} />
            </ScopeToolsPortal>
            {repository && (
                <ScopeToolsPortal slot="actions">
                    <SidebarRepositoryOrDirectoryDropdown
                        repository={repository}
                        directory={
                            directory
                                ? {
                                      id: directory.id,
                                      name: directory.name,
                                      folders: directory.folders,
                                  }
                                : undefined
                        }
                    />
                </ScopeToolsPortal>
            )}
        </>
    );
}
