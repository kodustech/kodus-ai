"use client";

import { useMemo, useState } from "react";
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

function SummaryStat({
    label,
    value,
    detail,
}: {
    label: string;
    value: string | number;
    detail: string;
}) {
    return (
        <div className="border-card-lv3/70 min-w-0 border-b px-5 py-4 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
            <p className="text-text-tertiary text-xs">{label}</p>
            <p className="text-text-primary mt-2 text-2xl font-semibold tabular-nums">
                {value}
            </p>
            <p className="text-text-tertiary mt-1 text-xs">{detail}</p>
        </div>
    );
}

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
                        <p className="text-text-tertiary mt-0.5 text-xs">
                            {item.bugFixEvidence === "linked-bug-issue"
                                ? "Linked bug issue"
                                : item.bugFixEvidence === "title-signal"
                                  ? "Bug-fix title signal"
                                  : "Changed this area"}
                        </p>
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
    const filteredAreas = useMemo(
        () =>
            areas.filter((area) =>
                area.path.toLowerCase().includes(query.trim().toLowerCase()),
            ),
        [areas, query],
    );
    const activeArea =
        filteredAreas.find((area) => area.path === selectedPath) ??
        filteredAreas[0];
    const leadingPaths = new Set(data?.topAreas.map((area) => area.path) ?? []);
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
                        Find directories with concentrated change and bug-fix
                        history. Use the evidence to guide review attention.
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
                        <div className="grid grid-cols-1 sm:grid-cols-3">
                            <SummaryStat
                                label="Merged PRs scanned"
                                value={coverage?.scannedPrs ?? 0}
                                detail={
                                    coverage?.scanComplete
                                        ? "Scan complete"
                                        : "Scan in progress"
                                }
                            />
                            <SummaryStat
                                label="Directories mapped"
                                value={areas.length}
                                detail="With merged PR changes"
                            />
                            <SummaryStat
                                label="Linked issue coverage"
                                value={`${coverage?.prsWithIssueSupport ?? 0} / ${coverage?.scannedPrs ?? 0}`}
                                detail="PRs with issue data"
                            />
                        </div>
                        <div className="border-card-lv3/70 text-text-tertiary flex flex-wrap gap-x-4 gap-y-1 border-t px-5 py-3 text-xs">
                            <span>
                                History: {date(data.map.windowStart)} –{" "}
                                {date(data.map.windowEnd)}
                            </span>
                            <span>Updated {date(data.map.refreshedAt)}</span>
                        </div>
                    </div>

                    <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
                        <section className="border-card-lv3/70 bg-card-lv1 min-w-0 overflow-hidden rounded-lg border">
                            <div className="border-card-lv3/70 flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
                                <div>
                                    <h2 className="text-text-primary text-sm font-semibold">
                                        Directories by evidence
                                    </h2>
                                    <p className="text-text-tertiary mt-0.5 text-xs">
                                        Ranked by change volume and bug-fix
                                        signals
                                    </p>
                                </div>
                                <label className="border-card-lv3/70 text-text-tertiary flex h-9 w-full items-center gap-2 rounded-md border px-3 sm:w-52">
                                    <Search className="size-3.5 shrink-0" />
                                    <input
                                        value={query}
                                        onChange={(event) =>
                                            setQuery(event.target.value)
                                        }
                                        placeholder="Find a directory"
                                        aria-label="Find a directory"
                                        className="text-text-primary placeholder:text-text-tertiary w-full min-w-0 bg-transparent text-xs outline-none"
                                    />
                                </label>
                            </div>
                            {filteredAreas.length ? (
                                <div className="divide-card-lv3/60 divide-y">
                                    {filteredAreas.map((area, index) => {
                                        const selected =
                                            area.path === activeArea?.path;
                                        const proportion = area.changedPrs
                                            ? (area.linkedBugFixPrs /
                                                  area.changedPrs) *
                                              100
                                            : 0;
                                        return (
                                            <button
                                                key={area.path}
                                                type="button"
                                                onClick={() =>
                                                    setSelectedPath(area.path)
                                                }
                                                aria-pressed={selected}
                                                className={`hover:bg-card-lv2/60 focus-visible:ring-primary-light grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3 text-left focus-visible:ring-2 focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_70px_110px] ${selected ? "bg-card-lv2/60" : ""}`}>
                                                <div className="flex min-w-0 items-center gap-3">
                                                    <span className="text-text-tertiary w-5 shrink-0 text-xs tabular-nums">
                                                        {String(
                                                            index + 1,
                                                        ).padStart(2, "0")}
                                                    </span>
                                                    <div className="min-w-0">
                                                        <p className="text-text-primary truncate font-mono text-xs font-medium">
                                                            {area.path}
                                                        </p>
                                                        {leadingPaths.has(
                                                            area.path,
                                                        ) && (
                                                            <p className="text-text-tertiary mt-0.5 text-[11px]">
                                                                Top 20% of
                                                                mapped
                                                                directories
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                                <p className="text-text-secondary text-right text-xs tabular-nums">
                                                    {area.changedPrs} PRs
                                                </p>
                                                <div className="col-span-2 pl-8 sm:col-span-1 sm:pl-0">
                                                    <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                                                        <span className="text-text-secondary">
                                                            {
                                                                area.linkedBugFixPrs
                                                            }{" "}
                                                            {area.linkedBugFixPrs ===
                                                            1
                                                                ? "linked bug"
                                                                : "linked bugs"}
                                                        </span>
                                                    </div>
                                                    <div className="bg-card-lv3 mt-1.5 h-1 overflow-hidden rounded-full">
                                                        <div
                                                            className="bg-primary-light h-full rounded-full"
                                                            style={{
                                                                width: `${proportion}%`,
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            </button>
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
                        </section>

                        <aside className="border-card-lv3/70 bg-card-lv1 h-fit min-w-0 rounded-lg border p-5 lg:sticky lg:top-5">
                            {activeArea ? (
                                <>
                                    <p className="text-text-tertiary text-xs font-medium tracking-wide uppercase">
                                        Area detail
                                    </p>
                                    <h2 className="text-text-primary mt-2 font-mono text-base font-medium break-all">
                                        {activeArea.path}
                                    </h2>
                                    <div className="border-card-lv3/70 mt-5 grid grid-cols-3 gap-2 border-y py-4">
                                        {[
                                            [
                                                "Changed PRs",
                                                activeArea.changedPrs,
                                            ],
                                            [
                                                "Linked bugs",
                                                activeArea.linkedBugFixPrs,
                                            ],
                                            [
                                                "Title signals",
                                                activeArea.titleBugFixPrs,
                                            ],
                                        ].map(([label, value]) => (
                                            <div key={label}>
                                                <p className="text-text-primary text-lg font-semibold tabular-nums">
                                                    {value}
                                                </p>
                                                <p className="text-text-tertiary text-[11px]">
                                                    {label}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                    <h3 className="text-text-primary mt-5 mb-3 text-xs font-semibold">
                                        Recent PR evidence
                                    </h3>
                                    <EvidenceList
                                        evidence={activeArea.recentEvidence}
                                    />
                                </>
                            ) : (
                                <p className="text-text-secondary text-sm">
                                    Select a directory to inspect its history.
                                </p>
                            )}
                        </aside>
                    </div>

                    <p className="text-text-tertiary max-w-3xl text-xs leading-5">
                        A bug fix is inferred from a linked bug issue or a PR
                        title. The ordering is an investigation aid, not a
                        measured probability of a future bug. A directory can
                        appear in more than one PR.
                    </p>
                </>
            )}
        </div>
    );
}
