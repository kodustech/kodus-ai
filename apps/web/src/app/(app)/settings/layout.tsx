import type { Metadata } from "next";
import { PageBoundary } from "src/core/components/page-boundary";
import { Skeleton } from "src/core/components/ui/skeleton";

import { SettingsLayout } from "./_components/_layout";

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
    return (
        <PageBoundary
            loading={<SettingsLoadingSkeleton />}
            errorVariant="card"
            errorMessage="Failed to load settings. Please try again.">
            <SettingsLayout>{children}</SettingsLayout>
        </PageBoundary>
    );
}
