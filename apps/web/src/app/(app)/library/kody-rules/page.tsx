import type { Metadata } from "next";
import {
    getLibraryKodyRulesBuckets,
    getLibraryKodyRulesWithFeedback,
} from "@services/kodyRules/fetch";
import { getOrganizationLanguage } from "@services/organizations/fetch";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import { KodyRulesLibrary } from "./_components/_page";

export const metadata: Metadata = {
    title: "Kody Rules library",
    openGraph: { title: "Kody Rules library" },
};

const BUCKETS_PREVIEW_COUNT = 3;
const BUCKET_RULES_PREVIEW_LIMIT = 6;

export default async function Route({
    searchParams,
}: {
    searchParams: Promise<{ bucket?: string; view?: string; type?: string }>;
}) {
    const params = await searchParams;

    const initialPlugAndPlay = params.type === "plug-and-play";

    const [teamId, buckets] = await Promise.all([
        getGlobalSelectedTeamId().catch(() => null),
        getLibraryKodyRulesBuckets().catch(() => []),
    ]);

    const previewBuckets = [...buckets]
        .sort((a, b) => b.rulesCount - a.rulesCount)
        .slice(0, BUCKETS_PREVIEW_COUNT);

    // orgLanguage only needs teamId; the bucket queries only need `buckets`.
    // All independent — fetch them in one parallel wave instead of blocking
    // the (heavier) bucket previews behind the language round-trip.
    const [orgLanguage, bucketRulesResponse, bucketPreviews] =
        await Promise.all([
            getOrganizationLanguage(teamId).catch(() => undefined),
            params.bucket
                ? getLibraryKodyRulesWithFeedback({
                      page: 1,
                      limit: 48,
                      buckets: [params.bucket],
                      plug_and_play: initialPlugAndPlay || undefined,
                  })
                : Promise.resolve(null),
            Promise.all(
                previewBuckets.map(async (bucket) => {
                    const response = await getLibraryKodyRulesWithFeedback({
                        page: 1,
                        limit: BUCKET_RULES_PREVIEW_LIMIT,
                        buckets: [bucket.slug],
                    });

                    return { bucket, rules: response?.data || [] };
                }),
            ),
        ]);

    return (
        <KodyRulesLibrary
            buckets={buckets}
            bucketPreviews={bucketPreviews}
            initialSelectedBucket={params.bucket}
            initialView={
                params.view === "browse" || params.type ? "browse" : undefined
            }
            initialPlugAndPlay={initialPlugAndPlay || undefined}
            teamLanguage={orgLanguage?.language}
            initialRules={bucketRulesResponse?.data || []}
            pagination={{
                page: bucketRulesResponse?.pagination?.currentPage || 1,
                limit: bucketRulesResponse?.pagination?.itemsPerPage || 48,
                total: bucketRulesResponse?.pagination?.totalItems || 0,
                totalPages: bucketRulesResponse?.pagination?.totalPages || 1,
            }}
        />
    );
}
