"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { CODE_MANAGEMENT_API_PATHS } from "@services/codeManagement/types";
import { ChevronDown } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useFetch } from "src/core/utils/reactQuery";

import { ReviewSection } from "./review-section";

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
        windowStart: string;
        windowEnd: string;
        refreshedAt: string;
        coverage: {
            scannedPrs: number;
            scanComplete: boolean;
            prsWithCompleteFiles: number;
            prsWithIssueSupport: number;
        };
    } | null;
    sync: { complete: boolean; discoveredMergedPrs: number } | null;
    topAreas: CodeArea[];
};

const INITIAL_ROWS = 6;

const readableDate = (value: string) =>
    new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });

function AreaRow({ area }: { area: CodeArea }) {
    return (
        <details className="border-card-lv3/60 group border-t first:border-t-0">
            <summary className="hover:bg-card-lv2/40 focus-visible:ring-primary-light/70 grid cursor-pointer list-none gap-2 px-4 py-3 outline-none focus-visible:ring-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <span className="text-text-primary min-w-0 font-mono text-xs font-medium break-all">
                    {area.path}
                </span>
                <span className="text-text-secondary flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                    <span>{area.changedPrs} changed PRs</span>
                    <span className="text-text-primary">
                        {area.linkedBugFixPrs} linked bug fixes
                    </span>
                    <span>{area.titleBugFixPrs} title signals</span>
                    <ChevronDown
                        className="size-3.5 transition-transform group-open:rotate-180"
                        aria-hidden="true"
                    />
                </span>
            </summary>
            <div className="border-card-lv3/60 bg-card-lv2/25 border-t px-4 py-3">
                {area.recentEvidence.length ? (
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {area.recentEvidence.map((item) =>
                            /^https?:\/\//i.test(item.prUrl) ? (
                                <a
                                    key={item.prNumber}
                                    href={item.prUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary-light text-xs underline-offset-2 hover:underline">
                                    PR #{item.prNumber} ·{" "}
                                    {item.bugFixEvidence === "linked-bug-issue"
                                        ? "linked bug"
                                        : item.bugFixEvidence === "title-signal"
                                          ? "title signal"
                                          : "change"}
                                </a>
                            ) : null,
                        )}
                    </div>
                ) : (
                    <p className="text-text-tertiary text-xs">
                        No recent PR example is retained for this area.
                    </p>
                )}
            </div>
        </details>
    );
}

export function CodeAreaRiskSection({
    selectedRepository,
}: {
    selectedRepository: string | null;
}) {
    const { teamId } = useSelectedTeamId();
    const { data: repositories = [], isLoading: repositoriesLoading } =
        useGetSelectedRepositories(teamId);
    const [localRepositoryId, setLocalRepositoryId] = useState("");
    const [showAll, setShowAll] = useState(false);
    const focusedRepository = selectedRepository
        ? repositories.find(
              (repo) =>
                  repo.full_name === selectedRepository ||
                  repo.name === selectedRepository,
          )
        : null;
    const repository = selectedRepository
        ? focusedRepository
        : (repositories.find((repo) => repo.id === localRepositoryId) ??
          repositories[0]);
    const { data, isLoading, isError } = useFetch<AreaMapResponse>(
        CODE_MANAGEMENT_API_PATHS.GET_AREA_RISK_MAP,
        { params: { repositoryId: repository?.id } },
        !!repository?.id,
    );
    const areas = data?.topAreas ?? [];
    const visibleAreas = showAll ? areas : areas.slice(0, INITIAL_ROWS);

    return (
        <ReviewSection
            title="Code areas · bug-fix history"
            description="Areas to inspect, ranked by change volume and bug-fix evidence from merged PRs."
            className="min-w-0">
            {repositoriesLoading ? (
                <p className="text-text-secondary text-sm">
                    Loading repositories…
                </p>
            ) : !repositories.length ? (
                <p className="text-text-secondary text-sm">
                    Connect a repository to build its code-area history.
                </p>
            ) : selectedRepository && !focusedRepository ? (
                <p className="text-text-secondary text-sm">
                    The selected repository is not available for this team.
                </p>
            ) : (
                <div className="flex min-w-0 flex-col gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-text-tertiary text-xs">
                                {selectedRepository
                                    ? "Following the Cockpit repository filter"
                                    : "Repository"}
                            </p>
                            {selectedRepository ? (
                                <p className="text-text-primary truncate text-sm font-medium">
                                    {repository?.full_name ?? repository?.name}
                                </p>
                            ) : (
                                <Select
                                    value={repository?.id}
                                    onValueChange={(id) => {
                                        setLocalRepositoryId(id);
                                        setShowAll(false);
                                    }}>
                                    <SelectTrigger
                                        size="sm"
                                        aria-label="Code area repository"
                                        className="mt-1 max-w-full sm:w-72">
                                        <SelectValue placeholder="Select repository" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {repositories.map((repo) => (
                                            <SelectItem
                                                key={repo.id}
                                                value={repo.id}>
                                                {repo.full_name || repo.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                        {data?.map && (
                            <p className="text-text-tertiary text-xs">
                                {readableDate(data.map.windowStart)}–
                                {readableDate(data.map.windowEnd)}
                            </p>
                        )}
                    </div>

                    {isLoading ? (
                        <p className="text-text-secondary text-sm">
                            Loading code-area history…
                        </p>
                    ) : isError ? (
                        <p className="text-text-secondary text-sm">
                            Could not load code-area history for this
                            repository.
                        </p>
                    ) : !data?.map ? (
                        <p className="text-text-secondary text-sm">
                            History is being collected for this repository.
                            Check back after the first scan.
                        </p>
                    ) : (
                        <>
                            {!data.map.coverage.scanComplete && (
                                <p className="border-card-lv3/60 bg-card-lv2/40 text-text-secondary rounded-lg border px-3 py-2 text-xs">
                                    Scan in progress ·{" "}
                                    {data.map.coverage.scannedPrs} merged PRs
                                    scanned. Counts may change.
                                </p>
                            )}
                            {areas.length ? (
                                <div className="border-card-lv3/60 overflow-hidden rounded-lg border">
                                    {visibleAreas.map((area) => (
                                        <AreaRow key={area.path} area={area} />
                                    ))}
                                </div>
                            ) : (
                                <p className="text-text-secondary text-sm">
                                    No changed code areas were found in this
                                    history window.
                                </p>
                            )}
                            {areas.length > INITIAL_ROWS && (
                                <Button
                                    size="sm"
                                    variant="helper"
                                    className="self-start"
                                    onClick={() => setShowAll(!showAll)}>
                                    {showAll
                                        ? "Show fewer areas"
                                        : `Show all ${areas.length} areas`}
                                </Button>
                            )}
                            <p className="text-text-tertiary text-xs leading-5">
                                Bug fixes are inferred from linked bug issues or
                                PR titles. Counts are evidence, not a measured
                                chance of a future bug. Select an area to see
                                recent PRs. Linked issue data is available for{" "}
                                {data.map.coverage.prsWithIssueSupport} of{" "}
                                {data.map.coverage.scannedPrs} scanned PRs.
                            </p>
                        </>
                    )}
                </div>
            )}
        </ReviewSection>
    );
}
