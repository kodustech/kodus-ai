import type { Metadata } from "next";
import {
    getLibraryKodyRulesBuckets,
    getLibraryKodyRulesWithFeedback,
} from "@services/kodyRules/fetch";

import { KodyRulesPacksExplorer } from "./_components/_page";

export const metadata: Metadata = {
    title: "Rules Packs - Kody Rules library",
    openGraph: { title: "Rules Packs - Kody Rules library" },
};

export default async function Route() {
    const [rulesResponse, buckets] = await Promise.all([
        getLibraryKodyRulesWithFeedback({ page: 1, limit: 1000 }), // Get all rules to get sample rules
        getLibraryKodyRulesBuckets(),
    ]);

    // Get sample rules for each bucket (rulesCount already comes from API)
    const bucketsWithStats = buckets.map((bucket) => {
        const rulesInBucket =
            rulesResponse?.data?.filter((rule) =>
                rule.buckets?.includes(bucket.slug),
            ) || [];

        return {
            ...bucket,
            sampleRules: rulesInBucket.slice(0, 2), // Get first 2 rules as samples
        };
    });

    return <KodyRulesPacksExplorer buckets={bucketsWithStats} />;
}
