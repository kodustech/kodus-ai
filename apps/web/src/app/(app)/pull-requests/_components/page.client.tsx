"use client";

import { useMemo, useState } from "react";
import { Page } from "@components/ui/page";
import { useDebounce } from "@hooks/use-debounce";
import {
    useInfinitePullRequestExecutions,
    usePullRequestExecutionSSE,
    type PullRequestExecution,
} from "@services/pull-requests";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { PrDataTable } from "./pr-data-table";
import { PullRequestsFilters } from "./pull-requests-filters";

export function PullRequestsPageClient() {
    const { teamId } = useSelectedTeamId();
    usePullRequestExecutionSSE();
    const [selectedRepository, setSelectedRepository] = useState<string>();
    const [pullRequestTitle, setPullRequestTitle] = useState("");
    const [pullRequestNumber, setPullRequestNumber] = useState("");
    const [suggestionsFilter, setSuggestionsFilter] = useState<
        "all" | "true" | "false"
    >("all");
    const [authorPolicy, setAuthorPolicy] = useState<
        "all" | "reviewable" | "excluded"
    >("reviewable");

    const debouncedTitle = useDebounce(pullRequestTitle, 400);
    const debouncedNumber = useDebounce(pullRequestNumber, 400);

    const normalizedTitle = debouncedTitle.trim();
    const normalizedNumber = debouncedNumber.trim();
    const hasSentSuggestionsParam =
        suggestionsFilter === "true"
            ? true
            : suggestionsFilter === "false"
              ? false
              : undefined;

    const {
        items: pullRequests,
        isLoading,
        error,
        hasNextPage,
        fetchNextPage,
        isFetchingNextPage,
    } = useInfinitePullRequestExecutions(
        {
            teamId,
            repositoryName: selectedRepository,
            pullRequestTitle: normalizedTitle ? normalizedTitle : undefined,
            pullRequestNumber: normalizedNumber ? normalizedNumber : undefined,
            hasSentSuggestions: hasSentSuggestionsParam,
            authorPolicy,
        },
        { pageSize: 30 },
    );

    const groupedPullRequests = useMemo(() => {
        const byPr = new Map<string, PullRequestExecution[]>();

        const getExecutionTime = (pr: PullRequestExecution) => {
            const value =
                pr.automationExecution?.createdAt ||
                pr.automationExecution?.updatedAt ||
                pr.updatedAt ||
                pr.createdAt;
            return value ? Date.parse(value) : 0;
        };

        pullRequests.forEach((pr) => {
            const existing = byPr.get(pr.prId) ?? [];
            existing.push(pr);
            byPr.set(pr.prId, existing);
        });

        const groups = Array.from(byPr.values()).map((executions) => {
            const sorted = [...executions].sort(
                (a, b) => getExecutionTime(b) - getExecutionTime(a),
            );
            const latest = sorted[0];

            return {
                prId: latest.prId,
                latest,
                executions: sorted,
                reviewCount: sorted.length,
            };
        });

        return groups.sort(
            (a, b) => getExecutionTime(b.latest) - getExecutionTime(a.latest),
        );
    }, [pullRequests]);

    return (
        <Page.Root className="pb-0">
            <Page.Header className="max-w-full">
                <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Page.Title className="text-balance">
                            Pull Requests
                        </Page.Title>

                        {groupedPullRequests.length > 0 && (
                            <span className="text-text-tertiary text-sm tabular-nums">
                                {groupedPullRequests.length} pull request
                                {groupedPullRequests.length > 1 ? "s" : ""}
                                {selectedRepository && (
                                    <>
                                        {" "}
                                        in{" "}
                                        <span className="text-text-secondary font-medium">
                                            {selectedRepository}
                                        </span>
                                    </>
                                )}
                            </span>
                        )}
                    </div>

                    <div className="ml-auto flex flex-wrap items-center gap-3">
                        <PullRequestsFilters
                            teamId={teamId}
                            selectedRepository={selectedRepository}
                            onRepositoryChange={setSelectedRepository}
                            pullRequestTitle={pullRequestTitle}
                            onTitleChange={(value) =>
                                setPullRequestTitle(value)
                            }
                            pullRequestNumber={pullRequestNumber}
                            onPullRequestNumberChange={(value) =>
                                setPullRequestNumber(
                                    value.replace(/[^\d]/g, ""),
                                )
                            }
                            suggestionsFilter={suggestionsFilter}
                            onSuggestionsFilterChange={(value) =>
                                setSuggestionsFilter(value)
                            }
                            authorPolicy={authorPolicy}
                            onAuthorPolicyChange={(value) =>
                                setAuthorPolicy(value)
                            }
                        />
                    </div>
                </div>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                {error ? (
                    <div className="py-12 text-center">
                        <p className="text-sm text-red-600">
                            Error loading pull requests. Please try again.
                        </p>
                    </div>
                ) : (
                    <PrDataTable
                        data={groupedPullRequests}
                        loading={isLoading && !groupedPullRequests.length}
                        hasNextPage={hasNextPage}
                        isFetchingNextPage={isFetchingNextPage}
                        fetchNextPage={fetchNextPage}
                    />
                )}
            </Page.Content>
        </Page.Root>
    );
}
