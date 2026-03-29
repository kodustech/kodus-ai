import type { Metadata } from "next";
import { cookies } from "next/headers";
import {
    getDefaultCodeReviewParameterNoCache,
    getFormattedCodeReviewParameterNoCache,
    getPlatformConfigParameterNoCache,
} from "@services/parameters/fetch";
import { PageBoundary } from "src/core/components/page-boundary";
import { Skeleton } from "src/core/components/ui/skeleton";

import { getTeamsCached } from "../_helpers/get-layout-data";
import { SettingsLayout } from "./_components/_layout";
import { resolveInitialSettingsTeamId } from "./_components/settings-initial-state";

export const metadata: Metadata = {
    title: "Code Review Settings",
    openGraph: { title: "Code Review Settings" },
};

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

    const [initialShellConfig, initialDefaultConfig, initialPlatformConfig] =
        await Promise.all([
            getFormattedCodeReviewParameterNoCache(initialTeamId),
            getDefaultCodeReviewParameterNoCache(),
            getPlatformConfigParameterNoCache(initialTeamId),
        ]);

    if (!initialShellConfig || !initialDefaultConfig || !initialPlatformConfig) {
        return null;
    }

    return (
        <PageBoundary
            loading={<SettingsLoadingSkeleton />}
            errorVariant="card"
            errorMessage="Failed to load settings. Please try again.">
            <SettingsLayout
                initialTeamId={initialTeamId}
                initialConfigValue={initialShellConfig.configValue}
                initialDefaultConfig={initialDefaultConfig}
                initialPlatformConfig={initialPlatformConfig}>
                {children}
            </SettingsLayout>
        </PageBoundary>
    );
}
