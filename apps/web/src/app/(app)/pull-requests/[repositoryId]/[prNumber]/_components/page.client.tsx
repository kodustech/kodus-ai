"use client";

import { useEffect, useMemo } from "react";
import NextLink from "next/link";
import { Spinner } from "@components/ui/spinner";
import {
    useInfinitePullRequestExecutions,
    usePullRequestFiles,
    usePullRequestSuggestions,
    type PullRequestFile,
} from "@services/pull-requests";
import {
    ArrowLeftIcon,
    ExternalLinkIcon,
    GitBranchIcon,
    PanelLeftCloseIcon,
    PanelLeftOpenIcon,
    PanelRightCloseIcon,
    PanelRightOpenIcon,
} from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";

import { DiffViewer } from "./diff-viewer";
import { FileTree } from "./file-tree";
import { ReviewStateProvider, useReviewStore } from "./review-store";
import { SummaryPanel } from "./summary-panel";

interface ReviewPageClientProps {
    repositoryId: string;
    prNumber: number;
}

export function ReviewPageClient({
    repositoryId,
    prNumber,
}: ReviewPageClientProps) {
    const { teamId } = useSelectedTeamId();

    const {
        data: suggestionsData,
        isLoading: suggestionsLoading,
        error: suggestionsError,
    } = usePullRequestSuggestions(repositoryId, prNumber);

    // Get PR metadata from executions
    const { items: executions, isLoading: executionsLoading } =
        useInfinitePullRequestExecutions(
            {
                teamId,
                repositoryId,
                pullRequestNumber: prNumber.toString(),
            },
            { pageSize: 1 },
        );

    const prExecution = useMemo(
        () => executions.find((e) => e.prNumber === prNumber),
        [executions, prNumber],
    );

    // Extract repo name from suggestions or execution data
    const repoFullName =
        suggestionsData?.data?.repositoryFullName ??
        prExecution?.repositoryName;
    const repoName = repoFullName?.includes("/")
        ? repoFullName.split("/").pop()
        : repoFullName;

    // Get full file diffs from Git provider
    const {
        data: filesData,
        isLoading: filesLoading,
        error: filesError,
    } = usePullRequestFiles(repositoryId, prNumber, teamId, repoName);

    const fileSuggestions = suggestionsData?.data?.suggestions?.files ?? [];
    const prLevelSuggestions =
        suggestionsData?.data?.suggestions?.prLevel ?? [];
    const patchFiles: PullRequestFile[] = filesData?.data?.files ?? [];
    const patchFilenames = useMemo(
        () => patchFiles.map((f) => f.filename),
        [patchFiles],
    );

    if (suggestionsLoading) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <Spinner className="size-6" />
                    <p className="text-text-tertiary text-sm">
                        Loading suggestions...
                    </p>
                </div>
            </div>
        );
    }

    if (suggestionsError) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="text-center">
                    <p className="text-sm text-red-500">
                        Failed to load review data.
                    </p>
                    <p className="text-text-tertiary mt-1 text-xs">
                        {suggestionsError.message}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <ReviewStateProvider
            suggestions={fileSuggestions}
            patchFilenames={patchFilenames}>
            <ReviewLayout
                fileSuggestions={fileSuggestions}
                prLevelSuggestions={prLevelSuggestions}
                patchFiles={patchFiles}
                patchesLoading={filesLoading}
                patchesError={filesError}
                prTitle={prExecution?.title}
                prNumber={prNumber}
                prUrl={prExecution?.url}
                baseBranch={prExecution?.baseBranchRef}
                headBranch={prExecution?.headBranchRef}
                repositoryName={
                    suggestionsData?.data?.repositoryFullName ??
                    prExecution?.repositoryName
                }
            />
        </ReviewStateProvider>
    );
}

function ReviewLayout({
    fileSuggestions,
    prLevelSuggestions,
    patchFiles,
    patchesLoading,
    patchesError,
    prTitle,
    prNumber,
    prUrl,
    baseBranch,
    headBranch,
    repositoryName,
}: {
    fileSuggestions: any[];
    prLevelSuggestions: any[];
    patchFiles: PullRequestFile[];
    patchesLoading: boolean;
    patchesError?: Error | null;
    prTitle?: string;
    prNumber: number;
    prUrl?: string;
    baseBranch?: string;
    headBranch?: string;
    repositoryName?: string;
}) {
    const { state, dispatch, navigateFile } = useReviewStore();

    // Keyboard shortcuts
    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement
            )
                return;

            switch (e.key) {
                case "j":
                    e.preventDefault();
                    navigateFile("next");
                    break;
                case "k":
                    e.preventDefault();
                    navigateFile("prev");
                    break;
                case "b":
                    e.preventDefault();
                    dispatch({ type: "TOGGLE_SIDEBAR" });
                    break;
                case "i":
                    e.preventDefault();
                    dispatch({ type: "TOGGLE_SUMMARY" });
                    break;
                case "Escape":
                    dispatch({ type: "SELECT_FILE", path: null });
                    break;
            }
        }

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [dispatch, navigateFile]);

    return (
        <div className="flex h-full flex-col overflow-hidden">
            {/* Top bar */}
            <div className="border-card-lv2 bg-card-lv1 flex items-center gap-4 border-b px-4 py-2.5">
                <NextLink
                    href="/pull-requests"
                    className="text-text-tertiary hover:bg-card-lv3 hover:text-text-primary rounded p-1 transition-colors">
                    <ArrowLeftIcon className="size-4" />
                </NextLink>

                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <h1 className="text-text-primary truncate text-sm font-medium">
                        {prTitle ?? `PR #${prNumber}`}
                    </h1>
                    <span className="text-text-tertiary shrink-0 text-xs">
                        #{prNumber}
                    </span>
                </div>

                {(baseBranch || headBranch) && (
                    <div className="text-text-tertiary hidden items-center gap-1.5 text-xs md:flex">
                        <GitBranchIcon className="size-3" />
                        <span className="font-mono">{headBranch ?? "?"}</span>
                        <span className="text-text-tertiary/50">→</span>
                        <span className="font-mono">{baseBranch ?? "?"}</span>
                    </div>
                )}

                <div className="flex items-center gap-1">
                    <button
                        onClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
                        className={cn(
                            "rounded p-1.5 transition-colors",
                            state.sidebarOpen
                                ? "text-text-secondary hover:text-text-primary"
                                : "text-text-tertiary hover:text-text-primary",
                        )}
                        title="Toggle file tree (b)">
                        {state.sidebarOpen ? (
                            <PanelLeftCloseIcon className="size-4" />
                        ) : (
                            <PanelLeftOpenIcon className="size-4" />
                        )}
                    </button>
                    <button
                        onClick={() => dispatch({ type: "TOGGLE_SUMMARY" })}
                        className={cn(
                            "rounded p-1.5 transition-colors",
                            state.summaryPanelOpen
                                ? "text-text-secondary hover:text-text-primary"
                                : "text-text-tertiary hover:text-text-primary",
                        )}
                        title="Toggle summary (i)">
                        {state.summaryPanelOpen ? (
                            <PanelRightCloseIcon className="size-4" />
                        ) : (
                            <PanelRightOpenIcon className="size-4" />
                        )}
                    </button>

                    {prUrl && (
                        <a
                            href={prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-text-tertiary hover:text-text-primary rounded p-1.5 transition-colors"
                            title="Open in provider">
                            <ExternalLinkIcon className="size-4" />
                        </a>
                    )}
                </div>
            </div>

            {/* Three-panel layout */}
            <div className="flex min-h-0 flex-1">
                {/* File tree sidebar */}
                {state.sidebarOpen && (
                    <>
                        <div className="border-card-lv2 bg-card-lv1 w-64 shrink-0 overflow-hidden border-r">
                            <FileTree />
                        </div>
                    </>
                )}

                {/* Main diff viewer */}
                <div className="min-w-0 flex-1">
                    <DiffViewer
                        patchFiles={patchFiles}
                        patchesLoading={patchesLoading}
                        patchesError={patchesError}
                    />
                </div>

                {/* Summary panel */}
                {state.summaryPanelOpen && (
                    <>
                        <div className="border-card-lv2 bg-card-lv1 w-80 shrink-0 overflow-hidden border-l">
                            <SummaryPanel
                                fileSuggestions={fileSuggestions}
                                prLevelSuggestions={prLevelSuggestions}
                                prTitle={prTitle}
                                prNumber={prNumber}
                                repositoryName={repositoryName}
                            />
                        </div>
                    </>
                )}
            </div>

            {/* Keyboard shortcuts hint */}
            <div className="border-card-lv2 bg-card-lv1 flex items-center gap-4 border-t px-4 py-1.5">
                <ShortcutHint keys={["j", "k"]} label="navigate files" />
                <ShortcutHint keys={["b"]} label="toggle sidebar" />
                <ShortcutHint keys={["i"]} label="toggle summary" />
            </div>
        </div>
    );
}

function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
    return (
        <div className="text-text-tertiary flex items-center gap-1.5 text-[10px]">
            <div className="flex gap-0.5">
                {keys.map((key) => (
                    <kbd
                        key={key}
                        className="border-card-lv3 bg-card-lv2 rounded border px-1.5 py-0.5 font-mono text-[10px]">
                        {key}
                    </kbd>
                ))}
            </div>
            <span>{label}</span>
        </div>
    );
}
