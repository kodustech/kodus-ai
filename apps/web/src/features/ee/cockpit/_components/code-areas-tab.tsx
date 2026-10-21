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
                                            className="text-primary-light focus-visible:ring-primary-light inline-flex items-center gap-1 rounded text-xs hover:underline focus-visible:ring-2">
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
    const maxChanges = areas.reduce(
        (max, area) => Math.max(max, area.changedPrs),
        1,
    );
    const maxLinkedFixes = areas.reduce(
        (max, area) => Math.max(max, area.linkedBugFixPrs),
        1,
    );
    const plottedAreas = useMemo(() => {
        const groups = new Map<string, CodeArea[]>();
        for (const area of filteredAreas) {
            const key = `${area.changedPrs}:${area.linkedBugFixPrs}`;
            groups.set(key, [...(groups.get(key) ?? []), area]);
        }
        return [...groups.values()];
    }, [filteredAreas]);
    const activePoint = plottedAreas.find((group) =>
        group.some((area) => area.path === activeArea?.path),
    );
    const selectPoint = (group: CodeArea[]) => {
        const selectedIndex = group.findIndex(
            (area) => area.path === activeArea?.path,
        );
        setSelectedPath(group[(selectedIndex + 1) % group.length].path);
    };
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
                                        Changes and linked bug fixes
                                    </h2>
                                    <p className="text-text-secondary mt-1 max-w-lg text-xs leading-5">
                                        Each point is a directory. Further right
                                        means more merged PRs changed it; higher
                                        means more PRs linked to bug issues.
                                        Select a point to see the PRs and
                                        issues.
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
                                <div className="px-4 pt-5 pb-4 sm:px-6">
                                    <div className="text-text-tertiary mb-2 flex justify-between text-[11px]">
                                        <span>PRs linked to bug issues ↑</span>
                                        <span>{maxLinkedFixes} at most</span>
                                    </div>
                                    <div className="border-card-lv3/70 bg-card-lv2/30 relative h-[360px] overflow-hidden rounded-md border sm:h-[420px]">
                                        <div
                                            className="border-card-lv3/70 pointer-events-none absolute inset-y-0 border-l border-dashed"
                                            style={{ left: "47.5%" }}
                                        />
                                        <div
                                            className="border-card-lv3/70 pointer-events-none absolute inset-x-0 border-t border-dashed"
                                            style={{ bottom: "46%" }}
                                        />
                                        <span className="text-text-tertiary pointer-events-none absolute top-4 left-4 text-[11px]">
                                            More fixes · fewer changes
                                        </span>
                                        <span className="text-text-tertiary pointer-events-none absolute top-4 right-4 text-right text-[11px]">
                                            More fixes · more changes
                                        </span>
                                        <span className="text-text-tertiary pointer-events-none absolute top-[53%] left-4 text-[11px]">
                                            Fewer fixes · fewer changes
                                        </span>
                                        <span className="text-text-tertiary pointer-events-none absolute top-[53%] right-4 text-right text-[11px]">
                                            Fewer fixes · more changes
                                        </span>
                                        {plottedAreas.map((group) => {
                                            const area = group[0];
                                            const selected = group.some(
                                                (item) =>
                                                    item.path ===
                                                    activeArea?.path,
                                            );
                                            return (
                                                <button
                                                    key={`${area.changedPrs}:${area.linkedBugFixPrs}`}
                                                    type="button"
                                                    onClick={() =>
                                                        selectPoint(group)
                                                    }
                                                    aria-label={`${group.length} ${group.length === 1 ? "directory" : "directories"}: ${group.map((item) => item.path).join(", ")}; ${area.changedPrs} changed PRs, ${area.linkedBugFixPrs} ${area.linkedBugFixPrs === 1 ? "PR" : "PRs"} linked to bug issues`}
                                                    aria-pressed={selected}
                                                    title={group
                                                        .map(
                                                            (item) => item.path,
                                                        )
                                                        .join(", ")}
                                                    className="focus-visible:ring-primary-light absolute z-10 flex size-8 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
                                                    style={{
                                                        left: `${5 + (area.changedPrs / maxChanges) * 85}%`,
                                                        bottom: `${8 + (area.linkedBugFixPrs / maxLinkedFixes) * 76}%`,
                                                    }}>
                                                    <span
                                                        className={`bg-primary-light flex items-center justify-center rounded-full text-[11px] font-semibold text-black tabular-nums ${group.length > 1 ? "size-6" : selected ? "ring-primary-light/20 size-4 ring-4" : "size-3 opacity-80"}`}>
                                                        {group.length > 1
                                                            ? group.length
                                                            : null}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <div className="text-text-tertiary mt-2 flex justify-between text-[11px]">
                                        <span>0</span>
                                        <span>
                                            Merged PRs that changed it →{" "}
                                            {maxChanges} at most
                                        </span>
                                    </div>
                                    <p className="text-text-tertiary mt-3 text-xs">
                                        Dashed lines mark half the largest count
                                        on each axis, not a risk threshold. A
                                        numbered point groups directories with
                                        the same counts.
                                    </p>
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
                                    {activePoint && activePoint.length > 1 && (
                                        <div className="mt-3 flex flex-wrap gap-1.5">
                                            {activePoint.map((area) => (
                                                <button
                                                    key={area.path}
                                                    type="button"
                                                    onClick={() =>
                                                        setSelectedPath(
                                                            area.path,
                                                        )
                                                    }
                                                    aria-pressed={
                                                        area.path ===
                                                        activeArea.path
                                                    }
                                                    className={`focus-visible:ring-primary-light rounded border px-2 py-1 font-mono text-[11px] focus-visible:ring-2 ${area.path === activeArea.path ? "border-primary-light text-text-primary" : "border-card-lv3 text-text-tertiary hover:text-text-primary"}`}>
                                                    {area.path}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <div className="border-card-lv3/70 mt-5 grid grid-cols-3 gap-2 border-y py-4">
                                        {[
                                            [
                                                "Changed PRs",
                                                activeArea.changedPrs,
                                            ],
                                            [
                                                "Linked bug-fix PRs",
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
                        The chart counts PRs linked to bug issues, not bugs
                        caused by a directory. Title-only signals appear in the
                        detail panel. This is an investigation aid, not a
                        measured probability of a future bug. A PR can touch
                        multiple directories.
                    </p>
                </>
            )}
        </div>
    );
}
