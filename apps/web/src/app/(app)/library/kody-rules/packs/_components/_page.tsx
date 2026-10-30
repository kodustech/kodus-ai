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
import { IssueSeverityLevelBadge } from "src/core/components/system/issue-severity-level-badge";

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
    // Bucket Card Component for packs page
    const PackCard = ({
        bucket,
        sampleRules,
    }: {
        bucket: KodyRuleBucket;
        sampleRules: LibraryRule[];
    }) => (
        <div className="border-card-lv3 bg-card-lv1 hover:border-primary-light rounded-lg border p-6 transition-colors">
            <Link
                href={`/library/kody-rules?view=browse&bucket=${bucket.slug}`}
                noHoverUnderline
                className="block">
                <div className="mb-3 flex items-center gap-3">
                    <div className="bg-card-lv2 rounded-lg p-3">
                        <div className="text-primary-light h-6 w-6">⚖️</div>
                    </div>
                    <div>
                        <h3 className="text-text-primary text-base font-bold">
                            {bucket.title}
                        </h3>
                        <p className="text-text-secondary text-sm">
                            {bucket.rulesCount} rules available
                        </p>
                    </div>
                </div>
                <p className="text-text-secondary mb-6 min-h-[3rem] text-sm leading-relaxed">
                    {bucket.description}
                </p>

                {/* Highlighted rules section */}
                {sampleRules.length > 0 && (
                    <div className="mb-6">
                        <h4 className="text-text-primary mb-3 text-sm font-bold">
                            Highlighted rules
                        </h4>
                        <div className="space-y-2">
                            {sampleRules.map((rule, index) => {
                                const displaySeverity =
                                    resolveKodyRuleDisplaySeverity(rule);

                                return (
                                    <div
                                        key={index}
                                        className="bg-card-lv2 flex items-start justify-between rounded p-4">
                                        <div className="flex-1 pr-3">
                                            <h5 className="text-text-primary mb-1 line-clamp-1 text-xs font-bold">
                                                {rule.title}
                                            </h5>
                                            <p className="text-text-secondary line-clamp-2 text-xs leading-relaxed">
                                                {rule.rule.length > 100
                                                    ? `${rule.rule.substring(0, 100)}...`
                                                    : rule.rule}
                                            </p>
                                        </div>
                                        <IssueSeverityLevelBadge
                                            className="flex-shrink-0"
                                            severity={displaySeverity}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                <div className="text-primary-light text-sm font-bold">
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
                        <span className="text-text-secondary text-sm">
                            {filteredBuckets.length} of {buckets.length} packs
                        </span>
                    </div>
                    <p className="text-text-secondary text-sm">
                        Rule packs, organized for your use case.
                    </p>
                    <div className="max-w-mdm mt-5 w-full">
                        <div className="relative">
                            <SearchIcon className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform text-[#79799f]" />
                            <Input
                                placeholder="Search packs..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="border-card-lv3 bg-card-lv1 text-text-primary focus:border-primary-light pl-10 placeholder-[#79799f]"
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
