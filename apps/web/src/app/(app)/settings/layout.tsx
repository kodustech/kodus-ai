import type { Metadata } from "next";
import { cookies } from "next/headers";
import {
    getLLMConfigStatus,
    getLLMProviderModels,
} from "@services/organizationParameters/fetch";
import {
    getDefaultCodeReviewParameterNoCache,
    getFormattedCodeReviewParameterNoCache,
    getPlatformConfigParameterNoCache,
    getTeamParametersNoCache,
} from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { PageBoundary } from "src/core/components/page-boundary";
import { Skeleton } from "src/core/components/ui/skeleton";

import { getTeamsCached } from "../_helpers/get-layout-data";
import { SettingsLayout } from "./_components/_layout";
import { resolveInitialSettingsTeamId } from "./_components/settings-initial-state";

export const metadata: Metadata = {
    title: "Code Review Settings",
    openGraph: { title: "Code Review Settings" },
};

/**
 * Upper bound on every server-side fetch below. This layout blocks the whole
 * /settings route: an upstream that hangs used to surface as a 500 on the
 * document itself, with no failing XHR in the browser and no exception in the
 * API (which was not erroring — it was still waiting). Bounded + guarded, a
 * slow upstream degrades to a client-side fetch instead of taking the route
 * down.
 */
const SERVER_FETCH_TIMEOUT_MS = 5_000;

function SettingsLoadingSkeleton() {
    return (
        <div className="flex flex-1 flex-row overflow-hidden">
            <div className="bg-card-lv1 w-64 px-6 py-6">
                <Skeleton className="mb-4 h-8 w-full" />
                <Skeleton className="mb-4 h-8 w-full" />
                <Skeleton className="mb-4 h-8 w-full" />
            </div>
            <div className="flex-1 p-6">
                <Skeleton className="h-48 w-full" />
            </div>
        </div>
    );
}

export default async function Layout({ children }: React.PropsWithChildren) {
    const cookieStore = await cookies();
    const teams = await getTeamsCached();
    const initialTeamId = resolveInitialSettingsTeamId(
        teams,
        cookieStore.get("global-selected-team-id")?.value,
    );

    if (!initialTeamId) {
        return null;
    }

    // Resolved first (fast DB read) so the provider's model catalog can be
    // fetched in parallel with the config fetches below, hiding its latency.
    const initialLLMConfigStatus = await getLLMConfigStatus().catch(() => null);
    const byokProvider =
        initialLLMConfigStatus?.byok?.configured &&
        initialLLMConfigStatus.byok.providerId
            ? initialLLMConfigStatus.byok.providerId
            : undefined;

    const [
        initialShellConfig,
        initialDefaultConfig,
        initialPlatformConfig,
        initialLanguageConfig,
        initialByokModels,
    ] = await Promise.all([
        getFormattedCodeReviewParameterNoCache(initialTeamId, {
            // The kodus-config.yml overlay is a live git-provider read and can
            // queue behind the org's background workload. The client refetches
            // the full config right after hydration and shows the overlay's
            // status, so the first render never waits on the provider.
            includeFileOverlay: false,
            signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
        }).catch(() => null),
        getDefaultCodeReviewParameterNoCache({
            signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
        }).catch(() => null),
        getPlatformConfigParameterNoCache(initialTeamId, {
            signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
        }).catch(() => null),
        getTeamParametersNoCache<{
            uuid: string;
            configKey: string;
            configValue: string;
        }>({
            key: ParametersConfigKey.LANGUAGE_CONFIG,
            teamId: initialTeamId,
        }).catch(() => null),
        // Drives the BYOK model selector's catalog. Empty on error / no BYOK.
        byokProvider
            ? getLLMProviderModels(byokProvider).catch(() => [])
            : Promise.resolve([]),
    ]);

    // Anything missing here is seeded as undefined rather than blanking the
    // page: the client hooks below fetch it themselves, suspending inside the
    // boundary instead of rendering an empty shell.
    return (
        <PageBoundary
            loading={<SettingsLoadingSkeleton />}
            errorVariant="card"
            errorMessage="Failed to load settings. Please try again.">
            <SettingsLayout
                initialTeamId={initialTeamId}
                initialConfigValue={initialShellConfig?.configValue}
                initialDefaultConfig={initialDefaultConfig ?? undefined}
                initialPlatformConfig={initialPlatformConfig ?? undefined}
                initialParameters={{
                    [ParametersConfigKey.LANGUAGE_CONFIG]: initialLanguageConfig,
                }}
                initialModelData={{
                    llmConfigStatus: initialLLMConfigStatus,
                    byokModels: initialByokModels,
                }}>
                {children}
            </SettingsLayout>
        </PageBoundary>
    );
}
