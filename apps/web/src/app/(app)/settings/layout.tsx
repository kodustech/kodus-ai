import { Suspense } from "react";
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
import { isClientNavigationOnServerComponents } from "src/core/utils/headers";

import { getTeamsCached } from "../_helpers/get-layout-data";
import { SettingsLayout } from "./_components/_layout";
import { resolveInitialSettingsTeamId } from "./_components/settings-initial-state";
import { SettingsShellSkeleton } from "./_components/settings-shell-skeleton";

export const metadata: Metadata = {
    title: "Code Review Settings",
    openGraph: { title: "Code Review Settings" },
};

/**
 * Upper bound on every server-side fetch below. An upstream that hangs used
 * to surface as a 500 on the document itself, with no failing XHR in the
 * browser and no exception in the API (which was not erroring — it was still
 * waiting). Bounded + guarded, a slow upstream degrades to a client-side
 * fetch instead of taking the route down.
 */
const SERVER_FETCH_TIMEOUT_MS = 5_000;

export default function Layout({ children }: React.PropsWithChildren) {
    // The shell streams: the skeleton is in the first chunk, so a document
    // load paints the settings frame at once and a client navigation into
    // /settings commits immediately instead of freezing on the previous page
    // until every fetch below has answered.
    return (
        <Suspense fallback={<SettingsShellSkeleton />}>
            <SettingsShellServer>{children}</SettingsShellServer>
        </Suspense>
    );
}

async function SettingsShellServer({ children }: React.PropsWithChildren) {
    const [cookieStore, teams] = await Promise.all([
        cookies(),
        getTeamsCached(),
    ]);
    const initialTeamId = resolveInitialSettingsTeamId(
        teams,
        cookieStore.get("global-selected-team-id")?.value,
    );

    if (!initialTeamId) {
        return null;
    }

    // The formatted config is the heavy seed (~0.5 MB for an org with a dozen
    // repositories, every level carrying its full prompt overrides). It only
    // pays off on a document load, where it lets the first HTML paint the
    // real page. On a client navigation — an RSC request — it would travel in
    // the flight payload and be parsed before hydration, and the client
    // refetches the complete config right after mounting anyway (the seed
    // lacks the kodus-config.yml overlay; see useCodeReviewSettingsShell).
    // Skipping it there turns "enter Settings" into a small round-trip plus
    // the XHR that was already going to happen.
    const isClientNavigation = await isClientNavigationOnServerComponents();
    const timeout = () => AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS);

    // One wave. The BYOK model catalog depends on the LLM status (which
    // provider), so it chains off that promise instead of holding the wave.
    const llmConfigStatusPromise = getLLMConfigStatus().catch(() => null);

    const [
        initialLLMConfigStatus,
        initialShellConfig,
        initialDefaultConfig,
        initialPlatformConfig,
        initialLanguageConfig,
        initialByokModels,
    ] = await Promise.all([
        llmConfigStatusPromise,
        isClientNavigation
            ? Promise.resolve(null)
            : getFormattedCodeReviewParameterNoCache(initialTeamId, {
                  // The overlay is a live git-provider read that can queue
                  // behind the org's background workload; the client fetches
                  // it after hydration and shows its status.
                  includeFileOverlay: false,
                  signal: timeout(),
              }).catch(() => null),
        getDefaultCodeReviewParameterNoCache({ signal: timeout() }).catch(
            () => null,
        ),
        getPlatformConfigParameterNoCache(initialTeamId, {
            signal: timeout(),
        }).catch(() => null),
        getTeamParametersNoCache<{
            uuid: string;
            configKey: string;
            configValue: string;
        }>({
            key: ParametersConfigKey.LANGUAGE_CONFIG,
            teamId: initialTeamId,
        }).catch(() => null),
        llmConfigStatusPromise.then((status) =>
            status?.byok?.configured && status.byok.providerId
                ? getLLMProviderModels(status.byok.providerId).catch(() => [])
                : [],
        ),
    ]);

    // Anything missing here is seeded as undefined rather than blanking the
    // page: the client hooks fetch it themselves, suspending inside the
    // boundary instead of rendering an empty shell.
    return (
        <PageBoundary
            loading={<SettingsShellSkeleton />}
            errorVariant="card"
            errorMessage="Failed to load settings. Please try again.">
            <SettingsLayout
                initialTeamId={initialTeamId}
                initialConfigValue={initialShellConfig?.configValue}
                initialDefaultConfig={initialDefaultConfig ?? undefined}
                initialPlatformConfig={initialPlatformConfig ?? undefined}
                initialParameters={{
                    [ParametersConfigKey.LANGUAGE_CONFIG]:
                        initialLanguageConfig,
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
