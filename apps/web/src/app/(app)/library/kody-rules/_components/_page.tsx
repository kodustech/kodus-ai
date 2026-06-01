"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbList,
    BreadcrumbPage,
} from "@components/ui/breadcrumb";
import { Button } from "@components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { KodyRuleLibraryItem } from "@components/ui/kody-rules/library-item-card";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Separator } from "@components/ui/separator";
import { useDebounce } from "@hooks/use-debounce";
import {
    getLibraryKodyRulesWithFeedback,
    getRecommendedKodyRules,
} from "@services/kodyRules/fetch";
import type {
    FindLibraryKodyRulesFilters,
    KodyRuleBucket,
    LibraryRule,
} from "@services/kodyRules/types";
import { Check, ChevronsUpDown, SearchIcon, SparklesIcon } from "lucide-react";
import { ProgrammingLanguage } from "src/core/enums/programming-language";
import { cn } from "src/core/utils/components";

type BucketPreview = { bucket: KodyRuleBucket; rules: LibraryRule[] };
type ViewMode = "featured" | "browse";
type FeaturedCollection = {
    key: string;
    title: string;
    description: string;
    viewAllHref: string;
    rules: LibraryRule[];
};

const RESULTS_PAGE_LIMIT = 48;
const BUCKET_RULES_PREVIEW_LIMIT = 6;
const RECOMMENDED_RULES_LIMIT = 12;

const SEVERITY_LEVEL_OPTIONS = ["low", "medium", "high", "critical"] as const;
const SEVERITY_LEVEL_LABELS: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    critical: "Critical",
};

const mapTeamLanguageToFilterLanguage = (
    teamLanguage?: string,
): FindLibraryKodyRulesFilters["language"] | undefined => {
    if (!teamLanguage) return undefined;

    const normalized = teamLanguage.trim().toLowerCase();

    if (
        normalized === "typescript" ||
        normalized === "javascript" ||
        normalized === "js" ||
        normalized === "ts"
    ) {
        return "jsts";
    }

    if (normalized === "python") return "python";
    if (normalized === "java") return "java";
    if (
        normalized === "c#" ||
        normalized === "csharp" ||
        normalized === "c-sharp"
    )
        return "csharp";
    if (normalized === "dart") return "dart";
    if (normalized === "ruby") return "ruby";
    if (normalized === "php") return "php";
    if (normalized === "go" || normalized === "golang") return "go";
    if (normalized === "kotlin") return "kotlin";
    if (normalized === "rust") return "rust";

    return undefined;
};

const tagsToTypeValue = (args: {
    tags?: string[];
    plug_and_play?: boolean;
    needMCPS?: boolean;
}) => {
    if (args.plug_and_play) return "plug-and-play";
    if (args.needMCPS) return "mcp";

    if (!args.tags || args.tags.length === 0) return undefined;
    const normalized = new Set(args.tags.map((t) => t.trim().toLowerCase()));
    if (normalized.has("mcp")) return "mcp";
    return undefined;
};

const SelectFilter = ({
    label,
    placeholder,
    searchPlaceholder,
    value,
    options,
    onChange,
}: {
    label: string;
    placeholder: string;
    searchPlaceholder: string;
    value?: string;
    options: Array<{ value: string; title: string }>;
    onChange: (nextValue?: string) => void;
}) => {
    const [isOpen, setIsOpen] = useState(false);

    const selectedTitle =
        value && options.find((o) => o.value === value)?.title;

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button
                    size="md"
                    variant="helper"
                    className="w-full justify-between font-normal"
                    rightIcon={
                        <ChevronsUpDown className="size-4 opacity-60" />
                    }>
                    {selectedTitle ?? placeholder}
                </Button>
            </PopoverTrigger>

            <PopoverContent align="start" className="w-72 p-0">
                <Command>
                    <CommandInput placeholder={searchPlaceholder} />
                    <CommandList>
                        <CommandEmpty>
                            No {label.toLowerCase()} found
                        </CommandEmpty>
                        <CommandGroup>
                            <CommandItem
                                value="__all__"
                                onSelect={() => {
                                    onChange(undefined);
                                    setIsOpen(false);
                                }}>
                                All
                                <Check
                                    className={cn(
                                        "text-primary-light -mr-2 size-5",
                                        !value ? "opacity-100" : "opacity-0",
                                    )}
                                />
                            </CommandItem>
                            {options.map((o) => (
                                <CommandItem
                                    key={o.value}
                                    value={o.value}
                                    onSelect={() => {
                                        onChange(o.value);
                                        setIsOpen(false);
                                    }}>
                                    {o.title}
                                    <Check
                                        className={cn(
                                            "text-primary-light -mr-2 size-5",
                                            value === o.value
                                                ? "opacity-100"
                                                : "opacity-0",
                                        )}
                                    />
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};

export const KodyRulesLibrary = ({
    buckets,
    bucketPreviews,
    initialSelectedBucket,
    initialView,
    initialTags,
    initialPlugAndPlay,
    initialNeedMCPS,
    teamLanguage,
    featuredCollections,
    initialRules,
    pagination: initialPagination,
    showSuggestionsButton = false,
}: {
    buckets: KodyRuleBucket[];
    bucketPreviews: BucketPreview[];
    initialSelectedBucket?: string;
    initialView?: ViewMode;
    initialTags?: string[];
    initialPlugAndPlay?: boolean;
    initialNeedMCPS?: boolean;
    teamLanguage?: string;
    featuredCollections?: FeaturedCollection[];
    initialRules: LibraryRule[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
    showSuggestionsButton?: boolean;
}) => {
    const router = useRouter();

    const [viewMode, setViewMode] = useState<ViewMode>(() => {
        if (initialView) return initialView;
        return initialSelectedBucket ? "browse" : "featured";
    });

    const autoLanguage = mapTeamLanguageToFilterLanguage(teamLanguage);
    const browseHref = useCallback(
        (next: { bucket?: string | null; type?: string }) => {
            const query = new URLSearchParams();
            query.set("view", "browse");
            if (next.bucket) query.set("bucket", next.bucket);
            if (next.type) query.set("type", next.type);
            return `/library/kody-rules?${query.toString()}`;
        },
        [],
    );

    const [filters, setFilters] = useState<FindLibraryKodyRulesFilters>(() => {
        const base: FindLibraryKodyRulesFilters = { name: "" };
        const isBrowseInit = Boolean(
            initialView === "browse" || initialSelectedBucket,
        );
        const next: FindLibraryKodyRulesFilters = { ...base };
        if (isBrowseInit && autoLanguage) next.language = autoLanguage;
        if (isBrowseInit && initialTags && initialTags.length > 0)
            next.tags = [...initialTags];
        if (isBrowseInit && initialPlugAndPlay) next.plug_and_play = true;
        if (isBrowseInit && initialNeedMCPS) next.needMCPS = true;
        return next;
    });
    const debouncedNameFilter = useDebounce(filters.name ?? "", 500);

    const [selectedBucket, setSelectedBucket] = useState<string | null>(
        initialSelectedBucket || null,
    );
    const [results, setResults] = useState<LibraryRule[]>(initialRules);
    const [pagination, setPagination] = useState(initialPagination);
    const [isResultsLoading, setIsResultsLoading] = useState(false);

    const [recommendedRules, setRecommendedRules] = useState<LibraryRule[]>([]);
    const [isRecommendedLoading, setIsRecommendedLoading] = useState(false);

    const filteredResults = useMemo(() => {
        if (!filters.requiredMcp) return results;

        const normalizedFilter = filters.requiredMcp.trim().toLowerCase();
        return results.filter((rule) => {
            if (!rule.required_mcps || rule.required_mcps.length === 0)
                return false;
            return rule.required_mcps.some(
                (mcp) => mcp.trim().toLowerCase() === normalizedFilter,
            );
        });
    }, [results, filters.requiredMcp]);

    const hasUserFilters = useMemo(() => {
        if (debouncedNameFilter.trim()) return true;
        if (filters.severity) return true;
        if (selectedBucket) return true;
        if (filters.tags && filters.tags.length > 0) return true;
        if (filters.plug_and_play) return true;
        if (filters.needMCPS) return true;
        if (filters.requiredMcp) return true;
        if (filters.language && filters.language !== autoLanguage) return true;
        return false;
    }, [
        autoLanguage,
        debouncedNameFilter,
        filters.language,
        filters.needMCPS,
        filters.plug_and_play,
        filters.requiredMcp,
        filters.tags,
        filters.severity,
        selectedBucket,
    ]);

    const selectedBucketMeta = useMemo(() => {
        if (!selectedBucket) return null;
        return buckets.find((b) => b.slug === selectedBucket) ?? null;
    }, [buckets, selectedBucket]);

    const selectedTypeValue = useMemo(
        () =>
            tagsToTypeValue({
                tags: filters.tags,
                plug_and_play: filters.plug_and_play,
                needMCPS: filters.needMCPS,
            }),
        [filters.needMCPS, filters.plug_and_play, filters.tags],
    );

    const initialBrowseResultsAlreadyLoadedRef = useRef(
        Boolean(initialSelectedBucket) &&
            initialSelectedBucket === selectedBucket &&
            !debouncedNameFilter.trim() &&
            !filters.severity &&
            !filters.language,
    );

    const fetchResultsPage = useCallback(
        async (page: number) => {
            setIsResultsLoading(true);
            try {
                const response = await getLibraryKodyRulesWithFeedback({
                    page,
                    limit: RESULTS_PAGE_LIMIT,
                    name: debouncedNameFilter.trim() || undefined,
                    severity: filters.severity,
                    language: filters.language,
                    tags: filters.tags,
                    plug_and_play: filters.plug_and_play,
                    needMCPS: filters.needMCPS,
                    buckets: selectedBucket ? [selectedBucket] : undefined,
                    debugLabel: filters.needMCPS
                        ? "client:browse:needMCPS"
                        : filters.plug_and_play
                          ? "client:browse:plug_and_play"
                          : undefined,
                });

                const nextResults = response?.data || [];
                setResults((prev) =>
                    page === 1 ? nextResults : [...prev, ...nextResults],
                );
                setPagination({
                    page: response?.pagination?.currentPage || page,
                    limit:
                        response?.pagination?.itemsPerPage ||
                        RESULTS_PAGE_LIMIT,
                    total: response?.pagination?.totalItems || 0,
                    totalPages: response?.pagination?.totalPages || 1,
                });
            } catch (error) {
                console.error("Error fetching rules:", error);
            } finally {
                setIsResultsLoading(false);
            }
        },
        [
            debouncedNameFilter,
            filters.language,
            filters.needMCPS,
            filters.plug_and_play,
            filters.tags,
            filters.severity,
            selectedBucket,
        ],
    );

    useEffect(() => {
        if (viewMode !== "featured") return;
        if (!hasUserFilters) return;

        setViewMode("browse");
        router.push(
            browseHref({ bucket: selectedBucket, type: selectedTypeValue }),
        );
    }, [
        browseHref,
        hasUserFilters,
        router,
        selectedBucket,
        selectedTypeValue,
        viewMode,
    ]);

    useEffect(() => {
        if (viewMode !== "browse") return;

        if (initialBrowseResultsAlreadyLoadedRef.current) {
            initialBrowseResultsAlreadyLoadedRef.current = false;
            return;
        }

        fetchResultsPage(1);
    }, [fetchResultsPage, viewMode]);

    const fetchRecommended = useCallback(async () => {
        setIsRecommendedLoading(true);
        try {
            const rules = await getRecommendedKodyRules();
            setRecommendedRules(rules.slice(0, RECOMMENDED_RULES_LIMIT));
        } catch (error) {
            console.error("Error fetching recommended rules:", error);
            setRecommendedRules([]);
        } finally {
            setIsRecommendedLoading(false);
        }
    }, []);

    useEffect(() => {
        if (viewMode !== "featured") return;
        fetchRecommended();
    }, [fetchRecommended, viewMode]);

    const resetFilters = useCallback(
        (targetViewMode?: ViewMode) => {
            const nextMode = targetViewMode ?? viewMode;
            setFilters(
                nextMode === "browse" && autoLanguage
                    ? {
                          name: "",
                          language: autoLanguage,
                      }
                    : { name: "" },
            );
            setSelectedBucket(null);
            setResults([]);
            setPagination({
                page: 1,
                limit: RESULTS_PAGE_LIMIT,
                total: 0,
                totalPages: 1,
            });
            setViewMode(nextMode);
            router.push(
                nextMode === "featured"
                    ? "/library/kody-rules/featured"
                    : browseHref({}),
            );
        },
        [autoLanguage, browseHref, router, viewMode],
    );

    const setBrowseMode = useCallback(() => {
        setViewMode("browse");
        setFilters((prev) => {
            if (prev.language || !autoLanguage) return prev;
            return { ...prev, language: autoLanguage };
        });
        router.push(
            browseHref({ bucket: selectedBucket, type: selectedTypeValue }),
        );
    }, [autoLanguage, browseHref, router, selectedBucket, selectedTypeValue]);

    const setBrowseType = useCallback(
        (typeValue?: string) => {
            setViewMode("browse");
            setFilters((prev) => {
                const nextLanguage =
                    prev.language || !autoLanguage
                        ? prev.language
                        : autoLanguage;

                if (typeValue === "plug-and-play") {
                    return {
                        ...prev,
                        language: nextLanguage,
                        needMCPS: undefined,
                        plug_and_play: true,
                        requiredMcp: undefined,
                        tags: undefined,
                    };
                }

                if (typeValue === "mcp") {
                    return {
                        ...prev,
                        language: nextLanguage,
                        plug_and_play: undefined,
                        needMCPS: true,
                        tags: undefined,
                    };
                }

                return {
                    ...prev,
                    language: nextLanguage,
                    needMCPS: undefined,
                    plug_and_play: undefined,
                    requiredMcp: undefined,
                    tags: undefined,
                };
            });
            router.push(
                browseHref({ bucket: selectedBucket, type: typeValue }),
            );
        },
        [autoLanguage, browseHref, router, selectedBucket],
    );

    const loadMoreResults = useCallback(() => {
        if (isResultsLoading) return;
        if (pagination.page >= pagination.totalPages) return;
        fetchResultsPage(pagination.page + 1);
    }, [
        fetchResultsPage,
        isResultsLoading,
        pagination.page,
        pagination.totalPages,
    ]);

    const severityOptions = useMemo(
        () =>
            SEVERITY_LEVEL_OPTIONS.map((s) => ({
                value: s,
                title: SEVERITY_LEVEL_LABELS[s],
            })),
        [],
    );

    const languageOptions = useMemo(
        () =>
            Object.entries(ProgrammingLanguage).map(([value, title]) => ({
                value,
                title,
            })),
        [],
    );

    const curatedBuckets = bucketPreviews.slice(0, 3).map((p) => ({
        ...p,
        rules: p.rules.slice(0, BUCKET_RULES_PREVIEW_LIMIT),
    }));

    return (
        <Page.Root className="w-full pb-0">
            <Page.Header className="w-full max-w-[90vw]">
                <div className="flex w-full flex-col gap-1">
                    <Breadcrumb className="mb-1">
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbPage>Rules Library</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>

                    <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                        <div className="flex flex-col gap-1">
                            <Page.Title className="text-2xl font-semibold">
                                Rules Marketplace
                            </Page.Title>
                            <p className="text-text-secondary text-sm">
                                Browse curated Kody Rules packs and discover
                                ready-to-use rules for your code reviews.
                            </p>
                        </div>

                        <div className="flex w-full max-w-xl items-center gap-2">
                            <Input
                                size="md"
                                leftIcon={<SearchIcon />}
                                value={filters.name ?? ""}
                                onChange={(e) => {
                                    const nextName = e.target.value;
                                    setFilters((prev) => ({
                                        ...prev,
                                        name: nextName,
                                    }));

                                    if (
                                        viewMode === "featured" &&
                                        nextName.trim()
                                    ) {
                                        setBrowseMode();
                                    }
                                }}
                                placeholder="Search rules..."
                            />
                            {hasUserFilters && (
                                <Button
                                    size="md"
                                    variant="cancel"
                                    onClick={() => resetFilters("browse")}>
                                    Clear
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </Page.Header>

            <Page.Content className="w-full max-w-[90vw] pt-8">
                <div className="grid grid-cols-1 gap-8 lg:grid-cols-[280px_1fr]">
                    <aside className="space-y-4">
                        <div className="border-card-lv3 bg-card-lv2 rounded-xl border p-4">
                            <Heading variant="h3">Navigation</Heading>
                            <Separator className="my-4 opacity-60" />

                            <div className="space-y-1">
                                <Link
                                    href="/library/kody-rules/featured"
                                    noHoverUnderline
                                    className={cn(
                                        "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition",
                                        viewMode === "featured"
                                            ? "bg-card-lv3 text-text-primary"
                                            : "text-text-secondary hover:bg-card-lv3/60 hover:text-text-primary",
                                    )}>
                                    Featured
                                </Link>

                                <Link
                                    href={browseHref({
                                        bucket: selectedBucket,
                                        type: selectedTypeValue,
                                    })}
                                    noHoverUnderline
                                    className={cn(
                                        "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition",
                                        viewMode === "browse"
                                            ? "bg-card-lv3 text-text-primary"
                                            : "text-text-secondary hover:bg-card-lv3/60 hover:text-text-primary",
                                    )}>
                                    Browse
                                </Link>
                            </div>
                        </div>

                        <div className="border-card-lv3 bg-card-lv2 rounded-xl border p-4">
                            <Heading variant="h3">Collections</Heading>
                            <Separator className="my-4 opacity-60" />

                            <div className="space-y-1">
                                <button
                                    type="button"
                                    onClick={() => setBrowseType(undefined)}
                                    className={cn(
                                        "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition",
                                        !selectedTypeValue
                                            ? "bg-card-lv3 text-text-primary"
                                            : "text-text-secondary hover:bg-card-lv3/60 hover:text-text-primary",
                                    )}>
                                    <span className="font-semibold">
                                        All rules
                                    </span>
                                </button>

                                <button
                                    type="button"
                                    onClick={() =>
                                        setBrowseType("plug-and-play")
                                    }
                                    className={cn(
                                        "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition",
                                        selectedTypeValue === "plug-and-play"
                                            ? "bg-card-lv3 text-text-primary"
                                            : "text-text-secondary hover:bg-card-lv3/60 hover:text-text-primary",
                                    )}>
                                    <span className="font-semibold">
                                        Plug and play
                                    </span>
                                    <span className="text-text-tertiary text-xs">
                                        →
                                    </span>
                                </button>
                            </div>
                        </div>

                        {viewMode === "browse" ? (
                            <div className="border-card-lv3 bg-card-lv2 rounded-xl border p-4">
                                <div className="flex items-center justify-between">
                                    <Heading variant="h3">Filters</Heading>
                                    {hasUserFilters && (
                                        <Button
                                            size="xs"
                                            variant="cancel"
                                            onClick={() =>
                                                resetFilters("browse")
                                            }>
                                            Reset
                                        </Button>
                                    )}
                                </div>

                                <Separator className="my-4 opacity-60" />

                                <div className="space-y-3">
                                    <div className="space-y-2">
                                        <p className="text-text-secondary text-xs font-semibold tracking-wide uppercase">
                                            Severity
                                        </p>
                                        <SelectFilter
                                            label="Severity"
                                            placeholder="All severities"
                                            searchPlaceholder="Search severity..."
                                            value={filters.severity}
                                            options={severityOptions}
                                            onChange={(next) =>
                                                setFilters((prev) => ({
                                                    ...prev,
                                                    severity:
                                                        next as FindLibraryKodyRulesFilters["severity"],
                                                }))
                                            }
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <p className="text-text-secondary text-xs font-semibold tracking-wide uppercase">
                                            Language
                                        </p>
                                        <SelectFilter
                                            label="Language"
                                            placeholder="All languages"
                                            searchPlaceholder="Search language..."
                                            value={filters.language}
                                            options={languageOptions}
                                            onChange={(next) =>
                                                setFilters((prev) => ({
                                                    ...prev,
                                                    language:
                                                        next as FindLibraryKodyRulesFilters["language"],
                                                }))
                                            }
                                        />
                                    </div>
                                </div>

                                <Separator className="my-4 opacity-60" />

                                <div className="space-y-2">
                                    <p className="text-text-secondary text-xs font-semibold tracking-wide uppercase">
                                        Packs
                                    </p>
                                    <div className="space-y-1">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSelectedBucket(null);
                                                router.push(
                                                    browseHref({
                                                        type: selectedTypeValue,
                                                    }),
                                                );
                                            }}
                                            className={cn(
                                                "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition",
                                                !selectedBucket
                                                    ? "bg-card-lv3 text-text-primary"
                                                    : "text-text-secondary hover:bg-card-lv3/60 hover:text-text-primary",
                                            )}>
                                            <span className="truncate">
                                                All
                                            </span>
                                            <span className="text-text-tertiary text-xs">
                                                {buckets.length}
                                            </span>
                                        </button>

                                        {buckets.map((bucket) => (
                                            <button
                                                key={bucket.slug}
                                                type="button"
                                                onClick={() => {
                                                    setSelectedBucket(
                                                        bucket.slug,
                                                    );
                                                    router.push(
                                                        browseHref({
                                                            bucket: bucket.slug,
                                                            type: selectedTypeValue,
                                                        }),
                                                    );
                                                }}
                                                className={cn(
                                                    "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition",
                                                    selectedBucket ===
                                                        bucket.slug
                                                        ? "bg-card-lv3 text-text-primary"
                                                        : "text-text-secondary hover:bg-card-lv3/60 hover:text-text-primary",
                                                )}>
                                                <span className="truncate">
                                                    {bucket.title}
                                                </span>
                                                <span className="text-text-tertiary text-xs">
                                                    {bucket.rulesCount}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="border-card-lv3 bg-card-lv1 text-text-secondary rounded-xl border border-dashed p-4 text-sm">
                                Switch to Browse to filter and search across all
                                rules.
                            </div>
                        )}

                        <Link
                            href="/library/kody-rules/packs"
                            noHoverUnderline
                            className="border-card-lv3 bg-card-lv1 text-text-secondary hover:border-primary-light hover:text-text-primary block rounded-xl border border-dashed p-4 text-sm transition">
                            Browse all packs →
                        </Link>
                    </aside>

                    <main className="min-w-0 space-y-10">
                        {viewMode === "browse" ? (
                            <section className="space-y-4">
                                <div className="flex flex-col gap-1">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <Heading variant="h2">
                                            {selectedBucketMeta?.title
                                                ? selectedBucketMeta.title
                                                : hasUserFilters
                                                  ? "Results"
                                                  : autoLanguage
                                                    ? `${ProgrammingLanguage[autoLanguage]} rules`
                                                    : "All rules"}
                                        </Heading>
                                        <div className="text-text-secondary text-sm">
                                            {filters.requiredMcp
                                                ? filteredResults.length > 0
                                                    ? `${filteredResults.length} rules`
                                                    : null
                                                : pagination.total > 0
                                                  ? `${pagination.total} rules`
                                                  : null}
                                        </div>
                                    </div>
                                    {selectedBucketMeta?.description && (
                                        <p className="text-text-secondary text-sm">
                                            {selectedBucketMeta.description}
                                        </p>
                                    )}
                                </div>

                                <Separator className="opacity-60" />

                                {filteredResults.length === 0 &&
                                !isResultsLoading ? (
                                    <div className="text-text-secondary py-12 text-sm">
                                        {hasUserFilters
                                            ? "No rules found with your current filters."
                                            : "No rules found."}
                                    </div>
                                ) : (
                                    <>
                                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                                            {filteredResults.map((rule) => (
                                                <KodyRuleLibraryItem
                                                    key={rule.uuid}
                                                    rule={rule}
                                                    showLikeButton
                                                    showSuggestionsButton={
                                                        showSuggestionsButton
                                                    }
                                                />
                                            ))}
                                        </div>

                                        {pagination.page <
                                            pagination.totalPages && (
                                            <div className="flex justify-center pt-2">
                                                <Button
                                                    size="md"
                                                    variant="secondary"
                                                    loading={isResultsLoading}
                                                    onClick={loadMoreResults}>
                                                    Load more
                                                </Button>
                                            </div>
                                        )}
                                    </>
                                )}
                            </section>
                        ) : (
                            <>
                                {(recommendedRules.length > 0 ||
                                    isRecommendedLoading) && (
                                    <section className="border-card-lv3 bg-card-lv1 rounded-xl border p-6">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="flex items-start gap-3">
                                                <div className="bg-card-lv3 rounded-lg p-3">
                                                    <SparklesIcon className="text-primary-light size-5" />
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <Heading variant="h2">
                                                        Recommended for you
                                                    </Heading>
                                                    <p className="text-text-secondary text-sm">
                                                        Personalized rules based
                                                        on your preferences.
                                                    </p>
                                                </div>
                                            </div>

                                            <Button
                                                size="sm"
                                                variant="cancel"
                                                loading={isRecommendedLoading}
                                                onClick={fetchRecommended}>
                                                Refresh
                                            </Button>
                                        </div>

                                        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                                            {recommendedRules.map((rule) => (
                                                <KodyRuleLibraryItem
                                                    key={rule.uuid}
                                                    rule={rule}
                                                    showLikeButton
                                                    showSuggestionsButton={
                                                        showSuggestionsButton
                                                    }
                                                />
                                            ))}
                                        </div>
                                    </section>
                                )}

                                {featuredCollections?.map((collection) => (
                                    <section
                                        key={collection.key}
                                        className="border-card-lv3 bg-card-lv1 rounded-xl border p-6">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="flex flex-col gap-1">
                                                <Heading variant="h2">
                                                    {collection.title}
                                                </Heading>
                                                <p className="text-text-secondary text-sm">
                                                    {collection.description}
                                                </p>
                                            </div>

                                            <Link
                                                href={collection.viewAllHref}
                                                noHoverUnderline>
                                                <Button
                                                    size="sm"
                                                    variant="secondary"
                                                    decorative>
                                                    View all
                                                </Button>
                                            </Link>
                                        </div>

                                        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                                            {collection.rules.map((rule) => (
                                                <KodyRuleLibraryItem
                                                    key={rule.uuid}
                                                    rule={rule}
                                                    showLikeButton
                                                    showSuggestionsButton={
                                                        showSuggestionsButton
                                                    }
                                                />
                                            ))}

                                            {collection.rules.length === 0 && (
                                                <div className="text-text-secondary text-sm">
                                                    No rules found.
                                                </div>
                                            )}
                                        </div>
                                    </section>
                                ))}

                                {curatedBuckets.map(({ bucket, rules }) => (
                                    <section
                                        key={bucket.slug}
                                        className="border-card-lv3 bg-card-lv1 rounded-xl border p-6">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2">
                                                    <Heading variant="h2">
                                                        {bucket.title}
                                                    </Heading>
                                                    <span className="text-text-tertiary text-sm">
                                                        {bucket.rulesCount}
                                                    </span>
                                                </div>
                                                <p className="text-text-secondary text-sm">
                                                    {bucket.description}
                                                </p>
                                            </div>

                                            <Link
                                                href={`/library/kody-rules?view=browse&bucket=${bucket.slug}`}
                                                noHoverUnderline>
                                                <Button
                                                    size="sm"
                                                    variant="secondary"
                                                    decorative>
                                                    View all
                                                </Button>
                                            </Link>
                                        </div>

                                        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                                            {rules.map((rule) => (
                                                <KodyRuleLibraryItem
                                                    key={rule.uuid}
                                                    rule={rule}
                                                    showLikeButton
                                                    showSuggestionsButton={
                                                        showSuggestionsButton
                                                    }
                                                />
                                            ))}

                                            {rules.length === 0 && (
                                                <div className="text-text-secondary text-sm">
                                                    No rules found for this
                                                    pack.
                                                </div>
                                            )}
                                        </div>
                                    </section>
                                ))}
                            </>
                        )}
                    </main>
                </div>
            </Page.Content>
        </Page.Root>
    );
};
