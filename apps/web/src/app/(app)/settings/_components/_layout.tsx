"use client";

import { useMemo } from "react";
import { redirect, usePathname } from "next/navigation";
import { Page } from "@components/ui/page";
import {
    useCodeReviewSettingsShell,
    useSuspenseGetDefaultCodeReviewParameter,
    useSuspenseGetParameterPlatformConfigs,
} from "@services/parameters/hooks";
import {
    ParametersConfigKey,
    type PlatformConfigValue,
} from "@services/parameters/types";
import type { CustomMessageConfig } from "@services/pull-request-messages/types";
import { SettingsPageSkeleton } from "src/core/components/system/page-skeletons";
import { useNavLayout } from "src/core/layout/nav-layout";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { safeArray } from "src/core/utils/safe-array";

import { useCodeReviewRouteParams } from "../_hooks";
import { countConfigOverridesForRoutes } from "../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type CodeReviewGlobalConfig,
    type FormattedGlobalCodeReviewConfig,
} from "../code-review/_types";
import { resolveCodeReviewConfigForScope } from "./code-review-config-scope";
import { CodeReviewShellHeader } from "./code-review-shell-header";
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
import { useCustomMessagesOverrideCount } from "./route-button-with-override-count";
import { SettingsShellHeaderSkeleton } from "./settings-shell-skeleton";

// One tab per question the user brings. Review categories, review filters
// and the per-category prompts live inside "What to review"; the PR summary,
// comment templates and Kody's voice live inside "What Kody writes".
const routes = [
    { label: "General", href: "general" },
    { label: "What to review", href: "review-scope" },
    { label: "Kody Rules", href: "kody-rules" },
    { label: "What Kody writes", href: "output" },
    // Cross-repo context (#1576): relationships are directional and
    // repo-scoped by design (a global default would link EVERY repo to the
    // same siblings), so the item only renders in repository submenus.
    {
        label: "Linked Repositories",
        shortLabel: "Linked repos",
        href: "linked-repositories",
        repoOnly: true,
    },
] satisfies Array<{
    label: string;
    shortLabel?: string;
    href: string;
    repoOnly?: boolean;
}>;

// Global scope never shows repo-only routes (see `repoOnly` on `routes`).
const globalSettingsRoutes = routes.filter(
    (r) => !("repoOnly" in r && r.repoOnly),
);

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
    const globalConfigOverrideCount = configValue
        ? countConfigOverridesForRoutes(
              configValue.configs,
              globalSettingsRoutes.map((r) => r.href),
              FormattedConfigLevel.GLOBAL,
          )
        : 0;
    const globalCustomMessagesOverrideCount = useCustomMessagesOverrideCount({
        scopeRepositoryId: "global",
        level: FormattedConfigLevel.GLOBAL,
        enabled: Boolean(configValue),
    });
    const globalOverrideCount =
        globalConfigOverrideCount + globalCustomMessagesOverrideCount;

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

    // Only the code review pages get the band of tabs, so only they sit
    // below one. The sidebar navigation carries the scope and the pages
    // itself, so it drops the band.
    const navLayout = useNavLayout();
    const hasTabsBand =
        navLayout === "top" && pathname.startsWith("/settings/code-review");
    const belowBand = (page: React.ReactNode) =>
        hasTabsBand ? <Page.BelowTabs>{page}</Page.BelowTabs> : page;

    const content = configValue ? (
        <DefaultCodeReviewConfigProvider config={defaultConfig}>
            <AutomationCodeReviewConfigProvider config={configValue}>
                <ScopedCodeReviewConfigProvider config={scopedConfig}>
                    <PlatformConfigProvider config={platformConfig.configValue}>
                        {hasTabsBand && (
                            <CodeReviewShellHeader
                                configValue={configValue}
                                platformConfigValue={platformConfig.configValue}
                                routes={routes}
                                globalOverrideCount={globalOverrideCount}
                            />
                        )}
                        {belowBand(children)}
                    </PlatformConfigProvider>
                </ScopedCodeReviewConfigProvider>
            </AutomationCodeReviewConfigProvider>
        </DefaultCodeReviewConfigProvider>
    ) : (
        <>
            {hasTabsBand && <SettingsShellHeaderSkeleton />}
            {belowBand(<SettingsPageSkeleton />)}
        </>
    );

    // The scope switcher and the page tabs live in a header band; the page
    // owns the full width below it.
    return (
        <div className="flex flex-1 flex-col overflow-hidden">{content}</div>
    );
}
