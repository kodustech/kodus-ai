"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { CODE_MANAGEMENT_API_PATHS } from "@services/codeManagement/types";
import { ArrowUpRight, FolderGit2, Search } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useFetch } from "src/core/utils/reactQuery";

import { COCKPIT_PARAM } from "../_constants";

type AreaEvidence = {
    prNumber: number;
    prUrl: string;
    bugFixEvidence?: "linked-bug-issue" | "title-signal";
    bugIssueUrls?: string[];
};

type CodeArea = {
    path: string;
    changedPrs: number;
    linkedBugFixPrs: number;
    titleBugFixPrs: number;
    recentEvidence: AreaEvidence[];
    linkedBugEvidence?: AreaEvidence[];
    structure?: {
        eligibleFiles: number;
        analyzedFiles: number;
        functions: number;
        functionsNeedingAttention: number;
        files?: Array<{
            path: string;
            functions: number;
            functionsNeedingAttention: number;
        }>;
    };
};

type AreaMapResponse = {
    map: {
        directDirectories: CodeArea[];
        windowStart: string;
        windowEnd: string;
        refreshedAt: string;
        coverage: {
            scannedPrs: number;
            scanComplete: boolean;
            prsWithIssueSupport: number;
        };
        structureCoverage?: {
            eligibleFiles: number;
            analyzedFiles: number;
            sampled: boolean;
        };
    } | null;
    rankedAreaPaths: string[];
};

const date = (value: string) =>
    new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });

const issueLabel = (url: string, index: number) => {
    try {
        const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
        return segment
            ? "Issue " + decodeURIComponent(segment)
            : "Issue " + (index + 1);
    } catch {
        return "Issue " + (index + 1);
    }
};

const areaEvidence = (area: CodeArea): AreaEvidence[] => {
    const seen = new Set<number>();
    return [...(area.linkedBugEvidence ?? []), ...area.recentEvidence]
        .filter((item) => {
            if (seen.has(item.prNumber)) return false;
            seen.add(item.prNumber);
            return true;
        })
        .slice(0, 7);
};

function AreaChoice({
    area,
    selected,
    onSelect,
}: {
    area: CodeArea;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            className={
                "border-card-lv3 focus-visible:ring-primary-light hover:border-text-secondary/50 w-full min-w-0 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none " +
                (selected
                    ? "border-text-secondary/60 bg-card-lv3/70"
                    : "bg-card-lv2/60")
            }>
            <span
                className="text-text-primary block truncate font-mono text-xs font-semibold"
                title={area.path}>
                {area.path}
            </span>
            <span className="text-text-tertiary mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
                <span>{area.changedPrs} changed PRs</span>
                {area.linkedBugFixPrs > 0 && (
                    <span className="bg-card-lv3 text-text-secondary rounded px-1.5 py-0.5 font-medium">
                        {area.linkedBugFixPrs} linked fixes
                    </span>
                )}
            </span>
        </button>
    );
}

function EvidenceList({ evidence }: { evidence: AreaEvidence[] }) {
    if (!evidence.length) {
        return (
            <p className="text-text-tertiary text-sm">
                No recent PR examples were retained.
            </p>
        );
    }
    return (
        <div className="divide-card-lv3 divide-y">
            {evidence.map((item) => (
                <div key={item.prNumber} className="py-3 first:pt-0">
                    {/^https?:\/\//i.test(item.prUrl) ? (
                        <a
                            href={item.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-text-primary hover:text-primary-light focus-visible:ring-primary-light inline-flex items-center gap-1 rounded text-sm font-medium focus-visible:ring-2">
                            PR #{item.prNumber}{" "}
                            <ArrowUpRight className="size-3.5" />
                        </a>
                    ) : (
                        <span className="text-text-primary text-sm font-medium">
                            PR #{item.prNumber}
                        </span>
                    )}
                    <p className="text-text-tertiary mt-0.5 text-xs">
                        {item.bugFixEvidence === "linked-bug-issue"
                            ? "Linked to a bug issue"
                            : item.bugFixEvidence === "title-signal"
                              ? "Bug-fix wording in the title"
                              : "Changed this area"}
                    </p>
                    {!!item.bugIssueUrls?.length && (
                        <div className="mt-1.5 flex flex-wrap gap-3">
                            {item.bugIssueUrls
                                .filter((url) => /^https?:\/\//i.test(url))
                                .map((url, index) => (
                                    <a
                                        key={url}
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-primary-light inline-flex items-center gap-1 text-xs hover:underline">
                                        {issueLabel(url, index)}{" "}
                                        <ArrowUpRight className="size-3" />
                                    </a>
                                ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

export function CodeAreasTab({
    selectedRepository,
}: {
    selectedRepository: string | null;
}) {
    const { teamId } = useSelectedTeamId();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { data: repositories = [], isLoading: repositoriesLoading } =
        useGetSelectedRepositories(teamId);
    const [localRepositoryId, setLocalRepositoryId] = useState("");
    const [selectedPath, setSelectedPath] = useState("");
    const [query, setQuery] = useState("");
    const [expandedGroups, setExpandedGroups] = useState<string[]>([]);

    const globalRepository = selectedRepository
        ? repositories.find(
              (repo) =>
                  repo.full_name === selectedRepository ||
                  repo.name === selectedRepository,
          )
        : null;
    const repository =
        repositories.find(
            (repo) =>
                repo.id ===
                (searchParams.get(COCKPIT_PARAM.areaRepository) ||
                    localRepositoryId),
        ) ??
        globalRepository ??
        repositories[0];
    const areaRepositoryId = searchParams.get(COCKPIT_PARAM.areaRepository);
    useEffect(() => {
        if (!repository?.id || areaRepositoryId === repository.id) return;
        const params = new URLSearchParams(window.location.search);
        params.set(COCKPIT_PARAM.areaRepository, repository.id);
        window.history.replaceState(
            null,
            "",
            pathname + "?" + params.toString(),
        );
    }, [areaRepositoryId, pathname, repository?.id]);

    const { data, isLoading, isError } = useFetch<AreaMapResponse>(
        CODE_MANAGEMENT_API_PATHS.GET_AREA_RISK_MAP,
        { params: { repositoryId: repository?.id } },
        !!repository?.id,
    );
    const areas = useMemo(() => {
        const byPath = new Map(
            (data?.map?.directDirectories ?? []).map(
                (area) => [area.path, area] as const,
            ),
        );
        return (
            data?.rankedAreaPaths
                .map((path) => byPath.get(path))
                .filter((area): area is CodeArea => !!area) ?? []
        );
    }, [data]);
    const classified = useMemo(() => {
        const byChanges = [...areas].sort(
            (a, b) =>
                b.changedPrs - a.changedPrs || a.path.localeCompare(b.path),
        );
        const frequent = new Set(
            byChanges
                .slice(0, Math.max(1, Math.ceil(byChanges.length * 0.25)))
                .map((a) => a.path),
        );
        const groups = {
            "fragile-frequent": [] as CodeArea[],
            "fragile-occasional": [] as CodeArea[],
            "clear-frequent": [] as CodeArea[],
            "clear-occasional": [] as CodeArea[],
            "unknown": [] as CodeArea[],
        };
        for (const area of areas) {
            const structure = area.structure;
            if (!structure?.analyzedFiles) {
                groups.unknown.push(area);
            } else {
                const key =
                    (structure.functionsNeedingAttention > 0
                        ? "fragile"
                        : "clear") +
                    (frequent.has(area.path) ? "-frequent" : "-occasional");
                groups[key as keyof typeof groups].push(area);
            }
        }
        for (const group of Object.values(groups)) {
            group.sort(
                (a, b) =>
                    b.linkedBugFixPrs - a.linkedBugFixPrs ||
                    b.changedPrs - a.changedPrs ||
                    a.path.localeCompare(b.path),
            );
        }
        return groups;
    }, [areas]);
    const focus = classified["fragile-frequent"];
    const selectedArea =
        areas.find((area) => area.path === selectedPath) ??
        focus[0] ??
        areas[0];
    const unknown = classified.unknown.filter((area) =>
        area.path.toLowerCase().includes(query.trim().toLowerCase()),
    );
    const coverage = data?.map?.coverage;
    const structureCoverage = data?.map?.structureCoverage;
    const group = (
        id: keyof typeof classified,
        title: string,
        prominent = false,
    ) => {
        const items = classified[id];
        const visible = expandedGroups.includes(id) ? items : items.slice(0, 4);
        return (
            <div className="border-card-lv3 bg-card-lv2/50 min-h-36 rounded-lg border p-3">
                <div
                    className={
                        "mb-3 text-xs font-semibold tracking-wide uppercase " +
                        (prominent ? "text-text-primary" : "text-text-tertiary")
                    }>
                    {title}{" "}
                    <span className="ml-1 font-normal tabular-nums">
                        ({items.length})
                    </span>
                </div>
                <div className="space-y-2">
                    {visible.map((area) => (
                        <AreaChoice
                            key={area.path}
                            area={area}
                            selected={selectedArea?.path === area.path}
                            onSelect={() => setSelectedPath(area.path)}
                        />
                    ))}
                </div>
                {!items.length && (
                    <p className="text-text-tertiary text-xs">
                        No measured areas here.
                    </p>
                )}
                {items.length > 4 && (
                    <button
                        type="button"
                        onClick={() =>
                            setExpandedGroups((current) =>
                                current.includes(id)
                                    ? current.filter((value) => value !== id)
                                    : [...current, id],
                            )
                        }
                        className="text-primary-light mt-3 text-xs font-medium hover:underline">
                        {expandedGroups.includes(id)
                            ? "Show fewer"
                            : "Show " + (items.length - 4) + " more"}
                    </button>
                )}
            </div>
        );
    };

    return (
        <div className="flex min-w-0 flex-col gap-5 pb-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="text-text-tertiary mb-1 text-xs font-medium tracking-wide uppercase">
                        Repository intelligence
                    </p>
                    <h2 className="text-text-primary text-2xl font-semibold tracking-tight">
                        Code hotspots
                    </h2>
                    <p className="text-text-secondary mt-1 max-w-2xl text-sm">
                        See which directories change often and contain long or
                        complex functions. Linked bug fixes add context.
                    </p>
                </div>
                {!repositoriesLoading && repositories.length > 0 && (
                    <div className="max-w-full min-w-56">
                        <p className="text-text-tertiary mb-1.5 text-xs">
                            Repository
                        </p>
                        <Select
                            value={repository?.id}
                            onValueChange={(id) => {
                                setLocalRepositoryId(id);
                                setSelectedPath("");
                                setQuery("");
                                const params = new URLSearchParams(
                                    window.location.search,
                                );
                                params.set(COCKPIT_PARAM.areaRepository, id);
                                window.history.replaceState(
                                    null,
                                    "",
                                    pathname + "?" + params.toString(),
                                );
                            }}>
                            <SelectTrigger
                                size="sm"
                                aria-label="Hotspot repository"
                                className="w-full sm:w-72">
                                <SelectValue placeholder="Select repository" />
                            </SelectTrigger>
                            <SelectContent>
                                {repositories.map((repo) => (
                                    <SelectItem key={repo.id} value={repo.id}>
                                        {repo.full_name || repo.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}
            </div>

            {repositoriesLoading ? (
                <div className="border-card-lv3 bg-card-lv1 text-text-secondary rounded-lg border px-5 py-12 text-sm">
                    Loading repositories…
                </div>
            ) : !repositories.length ? (
                <div className="border-card-lv3 bg-card-lv1 flex flex-col items-start gap-3 rounded-lg border px-6 py-12">
                    <FolderGit2 className="text-text-tertiary size-6" />
                    <h3 className="text-text-primary text-base font-medium">
                        Connect a repository to find code hotspots
                    </h3>
                    <p className="text-text-secondary max-w-lg text-sm">
                        Kodus uses merged PRs, linked bug issues and a limited
                        JS/TS structural scan.
                    </p>
                    <Link
                        href="/settings/git"
                        className="text-primary-light text-sm font-medium hover:underline">
                        Connect repository ↗
                    </Link>
                </div>
            ) : isLoading ? (
                <div className="border-card-lv3 bg-card-lv1 text-text-secondary rounded-lg border px-5 py-12 text-sm">
                    Loading repository history…
                </div>
            ) : isError ? (
                <div className="border-card-lv3 bg-card-lv1 text-text-secondary rounded-lg border px-5 py-12 text-sm">
                    Could not load repository history.
                </div>
            ) : !data?.map ? (
                <div className="border-card-lv3 bg-card-lv1 text-text-secondary rounded-lg border px-5 py-12 text-sm">
                    History is being collected. Check back after the first scan.
                </div>
            ) : (
                <>
                    <div className="text-text-tertiary flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span>
                            Based on {coverage?.scannedPrs ?? 0} merged PRs
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                            {date(data.map.windowStart)} –{" "}
                            {date(data.map.windowEnd)}
                        </span>
                        {!coverage?.scanComplete && (
                            <span className="text-primary-light">
                                · History scan in progress
                            </span>
                        )}
                    </div>

                    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
                        <section className="border-card-lv3 bg-card-lv1 min-w-0 overflow-hidden rounded-lg border">
                            <div className="border-card-lv3 border-b px-5 py-4">
                                <h3 className="text-text-primary text-base font-semibold">
                                    Change activity and structure
                                </h3>
                                <p className="text-text-secondary mt-1 text-xs leading-5">
                                    Each card is a directory. Start with
                                    “Investigate first”: these directories
                                    change often and contain long or complex
                                    functions in sampled files.
                                </p>
                            </div>
                            {(structureCoverage?.analyzedFiles ?? 0) > 0 ? (
                                <div className="p-4 sm:p-5">
                                    <div className="space-y-3 sm:hidden">
                                        {group(
                                            "fragile-frequent",
                                            "Investigate first",
                                            true,
                                        )}
                                        {group("fragile-occasional", "Monitor")}
                                        {group(
                                            "clear-frequent",
                                            "Watch changes",
                                        )}
                                        {group(
                                            "clear-occasional",
                                            "Less active",
                                        )}
                                    </div>
                                    <div className="hidden sm:block">
                                        <div className="text-text-tertiary mb-2 grid grid-cols-2 gap-3 pl-20 text-center text-xs font-medium">
                                            <span>Occasional changes</span>
                                            <span>Frequent changes</span>
                                        </div>
                                        <div className="grid grid-cols-[68px_minmax(0,1fr)_minmax(0,1fr)] gap-3">
                                            <div className="text-text-secondary flex items-center justify-end text-right text-xs leading-4">
                                                Complex
                                                <br />
                                                functions
                                            </div>
                                            {group(
                                                "fragile-occasional",
                                                "Monitor",
                                            )}
                                            {group(
                                                "fragile-frequent",
                                                "Investigate first",
                                                true,
                                            )}
                                            <div className="text-text-secondary flex items-center justify-end text-right text-xs leading-4">
                                                No findings
                                                <br />
                                                in sample
                                            </div>
                                            {group(
                                                "clear-occasional",
                                                "Less active",
                                            )}
                                            {group(
                                                "clear-frequent",
                                                "Watch changes",
                                            )}
                                        </div>
                                    </div>
                                    <p className="text-text-tertiary mt-4 text-xs">
                                        Frequent means the top quarter of
                                        directories by changed PRs. Functions
                                        are flagged when long, branch-heavy or
                                        deeply nested in sampled JS/TS files.
                                    </p>
                                </div>
                            ) : (
                                <div className="px-5 py-12">
                                    <p className="text-text-primary text-sm font-medium">
                                        Function analysis is not available yet
                                    </p>
                                    <p className="text-text-secondary mt-2 max-w-lg text-sm leading-5">
                                        The map needs a sample of JS/TS files
                                        from the default branch. You can still
                                        inspect changed areas and linked bug
                                        fixes below.
                                    </p>
                                </div>
                            )}
                        </section>

                        <aside className="border-card-lv3 bg-card-lv1 min-w-0 rounded-lg border">
                            {selectedArea ? (
                                <div className="p-5">
                                    <p className="text-text-tertiary text-xs font-semibold tracking-wide uppercase">
                                        Area detail
                                    </p>
                                    <h3 className="text-text-primary mt-2 font-mono text-base font-semibold break-all">
                                        {selectedArea.path}
                                    </h3>
                                    <div className="border-card-lv3 mt-5 grid grid-cols-3 gap-3 border-y py-4">
                                        <div>
                                            <strong className="text-text-primary block text-xl tabular-nums">
                                                {selectedArea.changedPrs}
                                            </strong>
                                            <span className="text-text-tertiary mt-1 block text-xs">
                                                Changed PRs
                                            </span>
                                        </div>
                                        <div>
                                            <strong className="text-text-primary block text-xl tabular-nums">
                                                {selectedArea.structure
                                                    ?.analyzedFiles ?? 0}
                                                /
                                                {selectedArea.structure
                                                    ?.eligibleFiles ?? 0}
                                            </strong>
                                            <span className="text-text-tertiary mt-1 block text-xs">
                                                JS/TS files checked
                                            </span>
                                        </div>
                                        <div>
                                            <strong className="text-text-primary block text-xl tabular-nums">
                                                {selectedArea.linkedBugFixPrs}
                                            </strong>
                                            <span className="text-text-tertiary mt-1 block text-xs">
                                                Linked fix PRs
                                            </span>
                                        </div>
                                    </div>
                                    <div className="mt-5">
                                        <h4 className="text-text-primary text-sm font-semibold">
                                            Why it appears here
                                        </h4>
                                        <p className="text-text-secondary mt-2 text-sm leading-5">
                                            {selectedArea.structure
                                                ?.analyzedFiles
                                                ? selectedArea.structure
                                                      .functionsNeedingAttention >
                                                  0
                                                    ? selectedArea.structure
                                                          .functionsNeedingAttention +
                                                      " of " +
                                                      selectedArea.structure
                                                          .functions +
                                                      " sampled functions were flagged for length or complexity."
                                                    : "No sampled functions were flagged for length or complexity."
                                                : "Functions have not been measured for this area."}{" "}
                                            {selectedArea.linkedBugFixPrs} of
                                            its {selectedArea.changedPrs}{" "}
                                            changed PRs were linked to bug
                                            issues.
                                        </p>
                                    </div>
                                    {!!selectedArea.structure?.files
                                        ?.length && (
                                        <div className="mt-6">
                                            <h4 className="text-text-primary mb-2 text-sm font-semibold">
                                                Files sampled
                                            </h4>
                                            <div className="divide-card-lv3 divide-y">
                                                {selectedArea.structure.files.map(
                                                    (file) => (
                                                        <div
                                                            key={file.path}
                                                            className="flex min-w-0 items-start justify-between gap-3 py-2 text-xs">
                                                            <span className="text-text-secondary min-w-0 font-mono break-all">
                                                                {file.path}
                                                            </span>
                                                            <span className="text-text-tertiary shrink-0 tabular-nums">
                                                                {
                                                                    file.functionsNeedingAttention
                                                                }
                                                                /
                                                                {file.functions}{" "}
                                                                flagged
                                                            </span>
                                                        </div>
                                                    ),
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    <div className="mt-6">
                                        <h4 className="text-text-primary mb-3 text-sm font-semibold">
                                            PR and issue evidence
                                        </h4>
                                        <EvidenceList
                                            evidence={areaEvidence(
                                                selectedArea,
                                            )}
                                        />
                                    </div>
                                </div>
                            ) : (
                                <p className="text-text-secondary p-5 text-sm">
                                    No directories found in this history window.
                                </p>
                            )}
                        </aside>
                    </div>

                    {classified.unknown.length > 0 && (
                        <section className="border-card-lv3 bg-card-lv1 rounded-lg border p-5">
                            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                                <div>
                                    <h3 className="text-text-primary text-sm font-semibold">
                                        Structure not measured
                                    </h3>
                                    <p className="text-text-secondary mt-1 text-xs">
                                        {classified.unknown.length} areas have
                                        history but no JS/TS function sample.
                                        They stay outside the quadrants.
                                    </p>
                                </div>
                                <label className="border-card-lv3 text-text-tertiary flex h-9 w-52 items-center gap-2 rounded-md border px-3">
                                    <Search className="size-4 shrink-0" />
                                    <input
                                        value={query}
                                        onChange={(event) =>
                                            setQuery(event.target.value)
                                        }
                                        placeholder="Find a directory"
                                        aria-label="Find a directory"
                                        className="text-text-primary placeholder:text-text-tertiary w-full min-w-0 bg-transparent text-sm outline-none"
                                    />
                                </label>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                {unknown.map((area) => (
                                    <AreaChoice
                                        key={area.path}
                                        area={area}
                                        selected={
                                            selectedArea?.path === area.path
                                        }
                                        onSelect={() =>
                                            setSelectedPath(area.path)
                                        }
                                    />
                                ))}
                            </div>
                            {!unknown.length && (
                                <p className="text-text-tertiary text-xs">
                                    No matching directories.
                                </p>
                            )}
                        </section>
                    )}
                    <details className="border-card-lv3 bg-card-lv1 rounded-lg border px-5 py-4 text-xs">
                        <summary className="text-text-secondary cursor-pointer font-medium">
                            How this view is calculated
                        </summary>
                        <div className="text-text-tertiary mt-3 max-w-4xl space-y-2 leading-5">
                            <p>
                                {areas.length} directories were mapped from{" "}
                                {coverage?.scannedPrs ?? 0} merged PRs. Issue
                                data was available for{" "}
                                {coverage?.prsWithIssueSupport ?? 0} of those
                                PRs.
                            </p>
                            <p>
                                Structural checks analyzed{" "}
                                {structureCoverage?.analyzedFiles ?? 0} of{" "}
                                {structureCoverage?.eligibleFiles ?? 0} JS/TS
                                files from the default branch, up to 60 files
                                total. A function is flagged at 80+ lines, 12+
                                branches or nesting of 4+.
                            </p>
                            <p>
                                Linked fixes are PRs that changed a directory
                                and linked to a bug issue. They add historical
                                context, but do not establish where a defect
                                originated or predict future bugs. Updated{" "}
                                {date(data.map.refreshedAt)}.
                            </p>
                        </div>
                    </details>
                </>
            )}
        </div>
    );
}
