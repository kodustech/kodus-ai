import type { Metadata } from "next";
import {
    getLibraryKodyRulesBuckets,
    getLibraryKodyRulesWithFeedback,
} from "@services/kodyRules/fetch";
import { getOrganizationLanguage } from "@services/organizations/fetch";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import { KodyRulesLibrary } from "../_components/_page";

export const metadata: Metadata = {
    title: "Featured - Kody Rules library",
    openGraph: { title: "Featured - Kody Rules library" },
};

const BUCKETS_PREVIEW_COUNT = 3;
const BUCKET_RULES_PREVIEW_LIMIT = 6;
const FEATURED_TYPE_RULES_LIMIT = 6;

export default async function Route() {
    const teamId = await getGlobalSelectedTeamId();

    const [buckets, orgLanguage, plugAndPlayRules, mcpRules] =
        await Promise.all([
            getLibraryKodyRulesBuckets(),
            getOrganizationLanguage(teamId),
            getLibraryKodyRulesWithFeedback({
                page: 1,
                limit: FEATURED_TYPE_RULES_LIMIT,
                plug_and_play: true,
                debugLabel: "server:featured:plug_and_play",
            }).then((r) => r?.data || []),
            getLibraryKodyRulesWithFeedback({
                page: 1,
                limit: FEATURED_TYPE_RULES_LIMIT,
                needMCPS: true,
                debugLabel: "server:featured:needMCPS",
            }).then((r) => r?.data || []),
        ]);
    const previewBuckets = [...buckets]
        .sort((a, b) => b.rulesCount - a.rulesCount)
        .slice(0, BUCKETS_PREVIEW_COUNT);

    const bucketPreviews = await Promise.all(
        previewBuckets.map(async (bucket) => {
            const response = await getLibraryKodyRulesWithFeedback({
                page: 1,
                limit: BUCKET_RULES_PREVIEW_LIMIT,
                buckets: [bucket.slug],
            });

            return { bucket, rules: response?.data || [] };
        }),
    );

    return (
        <KodyRulesLibrary
            buckets={buckets}
            bucketPreviews={bucketPreviews}
            initialView="featured"
            teamLanguage={orgLanguage?.language}
            featuredCollections={[
                {
                    key: "plug-and-play",
                    title: "Plug and play",
                    description:
                        "Ready-to-use rules you can adopt immediately.",
                    viewAllHref:
                        "/library/kody-rules?view=browse&type=plug-and-play",
                    rules: plugAndPlayRules,
                },
                {
                    key: "mcp",
                    title: "MCP rules",
                    description:
                        "Rules curated for teams using MCP integrations.",
                    viewAllHref: "/library/kody-rules?view=browse&type=mcp",
                    rules: mcpRules,
                },
            ]}
            initialRules={[]}
            pagination={{ page: 1, limit: 48, total: 0, totalPages: 1 }}
        />
    );
}
