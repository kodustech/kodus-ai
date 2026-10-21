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
import { ArrowUpRight, ChevronDown, FolderGit2, Search } from "lucide-react";
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
};

type AreaMapResponse = {
    map: {
        directDirectories: CodeArea[];
        windowStart: string;
        windowEnd: string;
        refreshedAt: string;
        coverage: {
            discoveredMergedPrs: number;
            scannedPrs: number;
            scanComplete: boolean;
            prsWithCompleteFiles: number;
            prsWithIssueSupport: number;
        };
    } | null;
    sync: { complete: boolean; discoveredMergedPrs: number } | null;
    rankedAreaPaths: string[];
    topAreas: CodeArea[];
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
            ? `Issue ${decodeURIComponent(segment)}`
            : `Issue ${index + 1}`;
    } catch {
        return `Issue ${index + 1}`;
    }
};

function EvidenceList({ evidence }: { evidence: AreaEvidence[] }) {
    if (!evidence.length) {
        return (
            <p className="text-text-tertiary text-sm">
                No recent PR examples were retained for this area.
            </p>
        );
    }

    return (
        <div className="divide-card-lv3/70 divide-y">
            {evidence.map((item) => (
                <div
                    key={item.prNumber}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                        <p className="text-text-primary text-sm font-medium">
                            PR #{item.prNumber}
                        </p>
                        <p className="text-text-tertiary mt-0.5 text-sm">
                            {item.bugFixEvidence === "linked-bug-issue"
                                ? "Linked bug issue"
                                : item.bugFixEvidence === "title-signal"
                                  ? "Bug-fix title signal"
                                  : "Changed this area"}
                        </p>
                        {!!item.bugIssueUrls?.length && (
                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                                {item.bugIssueUrls
                                    .filter((url) => /^https?:\/\//i.test(url))
                                    .map((url, index) => (
                                        <a
                                            key={url}
                                            href={url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-primary-light focus-visible:ring-primary-light inline-flex items-center gap-1 rounded text-sm hover:underline focus-visible:ring-2">
                                            {issueLabel(url, index)}
                                            <ArrowUpRight className="size-3" />
                                        </a>
                                    ))}
                            </div>
                        )}
                    </div>
                    {/^https?:\/\//i.test(item.prUrl) && (
                        <a
                            href={item.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open PR #${item.prNumber}`}
                            className="text-text-secondary hover:text-text-primary focus-visible:ring-primary-light shrink-0 rounded p-1 focus-visible:ring-2">
                            <ArrowUpRight className="size-4" />
                        </a>
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
    const [query, setQuery] = useState("");
    const [selectedPath, setSelectedPath] = useState("");
    const [sortBy, setSortBy] = useState<"fixes" | "changes">("fixes");

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
            `${pathname}?${params.toString()}`,
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
    const filteredAreas = useMemo(() => {
        const filtered = areas.filter((area) =>
            area.path.toLowerCase().includes(query.trim().toLowerCase()),
        );
        return filtered.sort((a, b) =>
            sortBy === "fixes"
                ? b.linkedBugFixPrs - a.linkedBugFixPrs ||
                  b.changedPrs - a.changedPrs ||
                  a.path.localeCompare(b.path)
                : b.changedPrs - a.changedPrs ||
                  b.linkedBugFixPrs - a.linkedBugFixPrs ||
                  a.path.localeCompare(b.path),
        );
    }, [areas, query, sortBy]);
    const maxChanges = areas.reduce(
        (max, area) => Math.max(max, area.changedPrs),
        1,
    );
    const maxLinkedFixes = areas.reduce(
        (max, area) => Math.max(max, area.linkedBugFixPrs),
        1,
    );
    const coverage = data?.map?.coverage;

    return (
        <div className="flex min-w-0 flex-col gap-5 pb-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="text-text-tertiary mb-1 text-xs font-medium tracking-wide uppercase">
                        Repository intelligence
                    </p>
                    <h2 className="text-text-primary text-2xl font-semibold tracking-tight">
                        Code areas
                    </h2>
                    <p className="text-text-secondary mt-1 max-w-2xl text-sm">
                        See which directories changed most and where fixes were
                        linked to bug issues.
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
                                    `${pathname}?${params.toString()}`,
                                );
                            }}>
                            <SelectTrigger
                                size="sm"
                                aria-label="Code area repository"
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
                <div className="border-card-lv3/70 bg-card-lv1 text-text-secondary rounded-lg border px-5 py-12 text-sm">
                    Loading repositories…
                </div>
            ) : !repositories.length ? (
                <div className="border-card-lv3/70 bg-card-lv1 flex flex-col items-start gap-3 rounded-lg border px-6 py-12">
                    <FolderGit2 className="text-text-tertiary size-6" />
                    <h2 className="text-text-primary text-base font-medium">
                        Connect a repository to map its code areas
                    </h2>
                    <p className="text-text-secondary max-w-lg text-sm">
                        Kodus builds this view from merged PRs and their linked
                        bug issues.
                    </p>
                    <Link
                        href="/settings/git"
                        className="text-primary-light text-sm font-medium hover:underline">
                        Connect repository ↗
                    </Link>
                </div>
            ) : isLoading ? (
                <div className="border-card-lv3/70 bg-card-lv1 text-text-secondary rounded-lg border px-5 py-12 text-sm">
                    Loading code-area history…
                </div>
            ) : isError ? (
                <div className="border-card-lv3/70 bg-card-lv1 text-text-secondary rounded-lg border px-5 py-12 text-sm">
                    Could not load code-area history for this repository.
                </div>
            ) : !data?.map ? (
                <div className="border-card-lv3/70 bg-card-lv1 text-text-secondary rounded-lg border px-5 py-12 text-sm">
                    History is being collected. Check back after the first scan.
                </div>
            ) : (
                <>
                    <div className="border-card-lv3/70 bg-card-lv1 overflow-hidden rounded-lg border">
                        <div className="border-card-lv3/70 flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-5 py-3 text-sm">
                            <span className="text-text-primary font-medium tabular-nums">
                                {coverage?.scannedPrs ?? 0} merged PRs scanned
                            </span>
                            <span className="text-text-secondary tabular-nums">
                                {areas.length} directories
                            </span>
                            <span className="text-text-secondary tabular-nums">
                                Issue data for{" "}
                                {coverage?.prsWithIssueSupport ?? 0} /{" "}
                                {coverage?.scannedPrs ?? 0} PRs
                            </span>
                            <span className="text-text-tertiary ml-auto">
                                {date(data.map.windowStart)} –{" "}
                                {date(data.map.windowEnd)}
                            </span>
                        </div>
                        <div className="flex flex-wrap items-end justify-between gap-4 px-5 pt-6 pb-5">
                            <div>
                                <h3 className="text-text-primary text-lg font-semibold">
                                    Where bug fixes were linked
                                </h3>
                                <p className="text-text-secondary mt-1 text-sm">
                                    Compare merged PR activity by directory.
                                    Open a row for the PRs and issues behind its
                                    counts.
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <label className="border-card-lv3/70 text-text-tertiary flex h-9 w-52 items-center gap-2 rounded-md border px-3">
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
                                <Select
                                    value={sortBy}
                                    onValueChange={(value) =>
                                        setSortBy(value as "fixes" | "changes")
                                    }>
                                    <SelectTrigger
                                        size="sm"
                                        aria-label="Sort directories"
                                        className="w-44">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="fixes">
                                            Most linked fixes
                                        </SelectItem>
                                        <SelectItem value="changes">
                                            Most changed PRs
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <div className="border-card-lv3/70 bg-card-lv2/30 text-text-tertiary hidden grid-cols-[minmax(260px,1fr)_minmax(180px,0.8fr)_minmax(180px,0.8fr)_24px] gap-6 border-y px-5 py-2 text-xs font-medium tracking-wide uppercase md:grid">
                            <span>Directory</span>
                            <span>Merged PRs that changed it</span>
                            <span>PRs linked to bug issues</span>
                            <span />
                        </div>
                        {filteredAreas.length ? (
                            <div className="divide-card-lv3/70 divide-y">
                                {filteredAreas.map((area) => {
                                    const selected = selectedPath === area.path;
                                    return (
                                        <div key={area.path}>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setSelectedPath(
                                                        selected
                                                            ? ""
                                                            : area.path,
                                                    )
                                                }
                                                aria-expanded={selected}
                                                aria-controls={`area-evidence-${area.path.replace(/[^a-zA-Z0-9-]/g, "-")}`}
                                                className={`focus-visible:ring-primary-light hover:bg-card-lv2/50 w-full px-5 py-3.5 text-left focus-visible:ring-2 focus-visible:outline-none ${selected ? "bg-card-lv2/50" : ""}`}>
                                                <div className="grid min-w-0 items-center gap-x-6 gap-y-3 md:grid-cols-[minmax(260px,1fr)_minmax(180px,0.8fr)_minmax(180px,0.8fr)_24px]">
                                                    <span className="text-text-primary min-w-0 font-mono text-sm font-medium break-all">
                                                        {area.path}
                                                    </span>
                                                    <span className="flex min-w-0 items-center gap-3">
                                                        <span className="text-text-primary w-7 shrink-0 text-right text-sm font-medium tabular-nums">
                                                            {area.changedPrs}
                                                        </span>
                                                        <span className="bg-card-lv3/70 h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                                                            <span
                                                                className="bg-text-tertiary block h-full rounded-full"
                                                                style={{
                                                                    width: `${(area.changedPrs / maxChanges) * 100}%`,
                                                                }}
                                                            />
                                                        </span>
                                                        <span className="text-text-tertiary text-xs md:hidden">
                                                            changed PRs
                                                        </span>
                                                    </span>
                                                    <span className="flex min-w-0 items-center gap-3">
                                                        <span className="text-text-primary w-7 shrink-0 text-right text-sm font-medium tabular-nums">
                                                            {
                                                                area.linkedBugFixPrs
                                                            }
                                                        </span>
                                                        <span className="bg-card-lv3/70 h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                                                            <span
                                                                className="bg-primary-light block h-full rounded-full"
                                                                style={{
                                                                    width: `${(area.linkedBugFixPrs / maxLinkedFixes) * 100}%`,
                                                                }}
                                                            />
                                                        </span>
                                                        <span className="text-text-tertiary text-xs md:hidden">
                                                            linked fixes
                                                        </span>
                                                    </span>
                                                    <ChevronDown
                                                        className={`text-text-tertiary hidden size-4 transition-transform md:block ${selected ? "rotate-180" : ""}`}
                                                    />
                                                </div>
                                            </button>
                                            {selected && (
                                                <div
                                                    id={`area-evidence-${area.path.replace(/[^a-zA-Z0-9-]/g, "-")}`}
                                                    className="border-card-lv3/70 bg-card-lv2/30 border-t px-5 py-5 md:pl-8">
                                                    <h4 className="text-text-primary mb-4 text-sm font-semibold">
                                                        Recent PR evidence
                                                    </h4>
                                                    <div className="max-w-3xl">
                                                        <EvidenceList
                                                            evidence={
                                                                area.recentEvidence
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <p className="text-text-secondary px-5 py-12 text-sm">
                                {areas.length
                                    ? "No directories match that search."
                                    : "No changed directories were found in this history window."}
                            </p>
                        )}
                        <div className="border-card-lv3/70 text-text-tertiary flex flex-wrap justify-between gap-x-5 gap-y-1 border-t px-5 py-3 text-xs">
                            <span>
                                Bars are scaled to the highest count in each
                                column. Counts are merged PRs, not unique bugs.
                            </span>
                            <span>Updated {date(data.map.refreshedAt)}</span>
                        </div>
                    </div>

                    <p className="text-text-tertiary max-w-3xl text-sm leading-5">
                        A linked fix is a PR linked to a bug issue. This history
                        does not measure the probability of future bugs.
                    </p>
                </>
            )}
        </div>
    );
}
