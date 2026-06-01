"use client";

import { useMemo, useState } from "react";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@components/ui/breadcrumb";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { Separator } from "@components/ui/separator";
import {
    resolveKodyRuleDisplaySeverity,
    type KodyRuleBucket,
    type LibraryRule,
} from "@services/kodyRules/types";
import { SearchIcon } from "lucide-react";

export const KodyRulesPacksExplorer = ({
    buckets,
}: {
    buckets: (KodyRuleBucket & {
        rulesCount: number;
        sampleRules: LibraryRule[];
    })[];
}) => {
    const [searchQuery, setSearchQuery] = useState("");

    // Filter buckets based on search query
    const filteredBuckets = useMemo(() => {
        if (!searchQuery.trim()) return buckets;

        return buckets.filter(
            (bucket) =>
                bucket.title
                    .toLowerCase()
                    .includes(searchQuery.toLowerCase()) ||
                bucket.description
                    .toLowerCase()
                    .includes(searchQuery.toLowerCase()),
        );
    }, [buckets, searchQuery]);
    // Get severity badge color
    const getSeverityColor = (severity?: string) => {
        switch (severity?.toLowerCase()) {
            case "low":
                return "bg-[rgba(17,157,228,0.1)] border-[rgba(17,157,228,0.64)] text-[#119de4]";
            case "medium":
                return "bg-[rgba(242,198,49,0.1)] border-[rgba(242,198,49,0.64)] text-[#f2c631]";
            case "high":
                return "bg-[rgba(255,139,64,0.1)] border-[rgba(255,139,64,0.64)] text-[#ff8b40]";
            case "critical":
                return "bg-[rgba(239,68,68,0.1)] border-[rgba(239,68,68,0.64)] text-[#ef4444]";
            default:
                return "bg-[rgba(255,139,64,0.1)] border-[rgba(255,139,64,0.64)] text-[#ff8b40]";
        }
    };

    // Bucket Card Component for packs page
    const PackCard = ({
        bucket,
        sampleRules,
    }: {
        bucket: KodyRuleBucket;
        sampleRules: LibraryRule[];
    }) => (
        <div className="rounded-lg border border-[#30304b] bg-[#181825] p-6 transition-colors hover:border-[#f8b76d]">
            <Link
                href={`/library/kody-rules?view=browse&bucket=${bucket.slug}`}
                noHoverUnderline
                className="block">
                <div className="mb-3 flex items-center gap-3">
                    <div className="rounded-lg bg-[#202032] p-3">
                        <div className="h-6 w-6 text-[#f8b76d]">⚖️</div>
                    </div>
                    <div>
                        <h3 className="text-base font-bold text-white">
                            {bucket.title}
                        </h3>
                        <p className="text-sm text-[#cdcddf]">
                            {bucket.rulesCount} rules available
                        </p>
                    </div>
                </div>
                <p className="mb-6 min-h-[3rem] text-sm leading-relaxed text-[#cdcddf]">
                    {bucket.description}
                </p>

                {/* Highlighted rules section */}
                {sampleRules.length > 0 && (
                    <div className="mb-6">
                        <h4 className="mb-3 text-sm font-bold text-white">
                            Highlighted rules
                        </h4>
                        <div className="space-y-2">
                            {sampleRules.map((rule, index) => {
                                const displaySeverity =
                                    resolveKodyRuleDisplaySeverity(rule);

                                return (
                                    <div
                                        key={index}
                                        className="flex items-start justify-between rounded bg-[#202032] p-4">
                                        <div className="flex-1 pr-3">
                                            <h5 className="mb-1 line-clamp-1 text-xs font-bold text-white">
                                                {rule.title}
                                            </h5>
                                            <p className="line-clamp-2 text-xs leading-relaxed text-[#cdcddf]">
                                                {rule.rule.length > 100
                                                    ? `${rule.rule.substring(0, 100)}...`
                                                    : rule.rule}
                                            </p>
                                        </div>
                                        <div
                                            className={`${getSeverityColor(displaySeverity)} flex-shrink-0 rounded border px-2 py-1`}>
                                            <span className="text-xs font-semibold uppercase">
                                                {displaySeverity}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                <div className="text-sm font-bold text-[#f8b76d]">
                    Explore pack →
                </div>
            </Link>
        </div>
    );

    return (
        <Page.Root>
            <Page.Header>
                <div className="flex w-full flex-col gap-1">
                    <Breadcrumb className="mb-1">
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbLink href="/library/kody-rules/featured">
                                    Rules Library
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>Rules Packs</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                    <div className="flex items-center gap-5">
                        <Page.Title className="text-2xl font-bold">
                            Rules Packs
                        </Page.Title>
                        <span className="text-sm text-[#cdcddf]">
                            {filteredBuckets.length} of {buckets.length} packs
                        </span>
                    </div>
                    <p className="text-sm text-[#cdcddf]">
                        Rule packs, organized for your use case.
                    </p>
                    <div className="max-w-mdm mt-5 w-full">
                        <div className="relative">
                            <SearchIcon className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform text-[#79799f]" />
                            <Input
                                placeholder="Search packs..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="border-[#30304b] bg-[#181825] pl-10 text-white placeholder-[#79799f] focus:border-[#f8b76d]"
                            />
                        </div>
                    </div>
                </div>
            </Page.Header>

            <Page.Content>
                <Separator />

                {filteredBuckets.length === 0 ? (
                    <div className="text-text-secondary flex flex-col items-center gap-2 py-12 text-sm">
                        <SearchIcon className="h-8 w-8 text-[#79799f]" />
                        <p>No packs found matching "{searchQuery}"</p>
                        <p className="text-xs text-[#79799f]">
                            Try adjusting your search terms
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-6">
                        {filteredBuckets.map((bucket) => (
                            <PackCard
                                key={bucket.slug}
                                bucket={bucket}
                                sampleRules={bucket.sampleRules}
                            />
                        ))}
                    </div>
                )}
            </Page.Content>
        </Page.Root>
    );
};
