"use client";

import { useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useSearchParams } from "next/navigation";
import { Skeleton } from "@components/ui/skeleton";
import {
    useInfinitePullRequestExecutions,
    usePullRequestFiles,
    usePullRequestSuggestions,
    type PullRequestCommit,
    type PullRequestExecution,
    type PullRequestFile,
} from "@services/pull-requests";
import { ArrowLeftIcon } from "lucide-react";
// Review screen — ported from the `try` app: a max-w page that scrolls as a
// whole, with sticky left (file tree) and right (issues/metadata) rails and a
// center column carrying the PR header + diff.
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { DiffViewer } from "./diff-viewer";
import { ReviewStateProvider, useReviewStore } from "./review-store";
import { adaptForTryDiffViewer, buildHeaderPrInfo } from "./try-port/adapt";
import { CommitsList } from "./try-port/CommitsList";
import { FileTree, type FileTreeMode } from "./try-port/FileTree";
import { PrHeader, type PrTab } from "./try-port/PrHeader";
import { RightSidebar } from "./try-port/RightSidebar";

// Web only carries data for these two tabs (Kody doesn't store the PR body
// or comment threads), so we render a narrower tab bar than try's four.
const WEB_TABS: PrTab[] = ["review", "commits"];
const FILE_TREE_MODE_KEY = "kodus:pr-file-tree-mode";

function PanelError({ error }: FallbackProps) {
    const message =
        error instanceof Error ? error.message : String(error ?? "");
    return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-2)]/70 p-6 text-center text-sm">
            <p className="font-semibold text-[var(--red)]">
                This panel crashed
            </p>
            <p className="max-w-md font-mono text-xs break-words text-[var(--text-dim)]">
                {message}
            </p>
        </div>
    );
}

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
    const { items: executions } = useInfinitePullRequestExecutions(
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

    // Derive these through useMemo so their reference is stable across renders
    // while the underlying query data is unchanged. Without it, `?? []` (and
    // the optional-chain miss during loading) hands a fresh array to every
    // downstream memo — adaptForTryDiffViewer, buildTree, buildCohorts — on
    // each render, defeating their memoization on a screen whose diffs are the
    // expensive part to recompute.
    const fileSuggestions = useMemo(
        () => suggestionsData?.data?.suggestions?.files ?? [],
        [suggestionsData],
    );
    const prLevelSuggestions = useMemo(
        () => suggestionsData?.data?.suggestions?.prLevel ?? [],
        [suggestionsData],
    );
    const patchFiles: PullRequestFile[] = useMemo(
        () => filesData?.data?.files ?? [],
        [filesData],
    );
    const commits: PullRequestCommit[] = useMemo(
        () => filesData?.data?.commits ?? [],
        [filesData],
    );
    const patchFilenames = useMemo(
        () => patchFiles.map((f) => f.filename),
        [patchFiles],
    );

    if (suggestionsLoading) {
        return <ReviewPageSkeleton />;
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
                execution={prExecution}
                fileSuggestions={fileSuggestions}
                prLevelSuggestions={prLevelSuggestions}
                patchFiles={patchFiles}
                commits={commits}
                patchesLoading={filesLoading}
                patchesError={filesError}
                prNumber={prNumber}
                prUrl={prExecution?.url}
                repositoryName={
                    suggestionsData?.data?.repositoryFullName ??
                    prExecution?.repositoryName
                }
            />
        </ReviewStateProvider>
    );
}

// Mirrors ReviewLayout's shell (max-w-[1600px] + file-tree / diff / sidebar
// grid) so the page paints its structure immediately instead of a centered
// spinner while suggestions load.
function ReviewPageSkeleton() {
    return (
        <div className="kodus-scroll h-full overflow-y-auto bg-[var(--bg)]">
            <section className="px-6 py-6">
                <div className="mx-auto max-w-[1600px]">
                    <Skeleton className="mb-4 h-4 w-28" />
                    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
                        <div className="hidden flex-col gap-2 lg:flex">
                            {Array.from({ length: 9 }).map((_, i) => (
                                <Skeleton key={i} className="h-6 w-full" />
                            ))}
                        </div>
                        <div className="flex min-w-0 flex-col gap-4">
                            <Skeleton className="h-16 w-full rounded-xl" />
                            <Skeleton className="h-[60vh] w-full rounded-xl" />
                        </div>
                        <div className="hidden flex-col gap-3 lg:flex">
                            <Skeleton className="h-32 w-full rounded-xl" />
                            <Skeleton className="h-48 w-full rounded-xl" />
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
}

function ReviewLayout({
    execution,
    fileSuggestions,
    prLevelSuggestions,
    patchFiles,
    commits,
    patchesLoading,
    patchesError,
    prNumber,
    prUrl,
    repositoryName,
}: {
    execution?: PullRequestExecution;
    fileSuggestions: any[];
    prLevelSuggestions: any[];
    patchFiles: PullRequestFile[];
    commits: PullRequestCommit[];
    patchesLoading: boolean;
    patchesError?: Error | null;
    prNumber: number;
    prUrl?: string;
    repositoryName?: string;
}) {
    const { state, dispatch, navigateFile } = useReviewStore();
    const [activeTab, setActiveTab] = useState<PrTab>("review");
    // Folder tree vs. role-grouped cohorts. Persisted so the choice sticks
    // across PRs. Applied AFTER mount (not in the initializer) so the server
    // and the first client render agree on the "tree" default — reading
    // localStorage in the initializer would diverge and trip a hydration
    // mismatch. This one-time sync of a client-only preference is the case the
    // set-state-in-effect heuristic doesn't cover, hence the scoped disable.
    const [treeMode, setTreeMode] = useState<FileTreeMode>("tree");
    useEffect(() => {
        const saved = window.localStorage.getItem(FILE_TREE_MODE_KEY);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (saved === "grouped" || saved === "tree") setTreeMode(saved);
    }, []);
    const toggleTreeMode = () =>
        setTreeMode((m) => {
            const next = m === "tree" ? "grouped" : "tree";
            window.localStorage.setItem(FILE_TREE_MODE_KEY, next);
            return next;
        });

    // Deep link: /pull-requests/<repo>/<num>?file=<path>&suggestion=<id>
    // Lands the user on the exact finding — scrolls to it and lights it up.
    const searchParams = useSearchParams();
    const deepLinkFile = searchParams.get("file");
    const deepLinkIssue = searchParams.get("suggestion");

    const pr = useMemo(
        () =>
            buildHeaderPrInfo({
                execution,
                patchFiles,
                prNumber,
                repositoryName,
                commitsCount: commits.length,
            }),
        [execution, patchFiles, prNumber, repositoryName, commits.length],
    );

    // File tree + right-sidebar both want the diff-file metadata and a flat
    // issue list. Use the unfiltered suggestions so badges/counts reflect
    // every finding, not the current severity filter.
    const { files: treeFiles, issues: treeIssues } = useMemo(
        () =>
            adaptForTryDiffViewer({
                patchFiles,
                suggestions: fileSuggestions,
            }),
        [patchFiles, fileSuggestions],
    );

    const suggestionCount = fileSuggestions.length + prLevelSuggestions.length;

    const jumpToFile = (path: string) =>
        dispatch({ type: "SELECT_FILE", path });

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
                case "Escape":
                    dispatch({ type: "SELECT_FILE", path: null });
                    break;
            }
        }

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [dispatch, navigateFile]);

    // Deep-link landing: scroll to the target suggestion card (or file) once
    // it mounts. The diff loads async, so poll a few frames until the anchor
    // exists. For a file-only link we also mark it active in the tree.
    useEffect(() => {
        if (!deepLinkFile && !deepLinkIssue) return;
        if (deepLinkFile && !deepLinkIssue) {
            dispatch({ type: "SELECT_FILE", path: deepLinkFile });
        }
        const issueTarget = deepLinkIssue
            ? `suggestion-${deepLinkIssue}`
            : null;
        const fileTarget = deepLinkFile ? `file-${deepLinkFile}` : null;
        let raf = 0;
        let tries = 0;
        const tryScroll = () => {
            const el = issueTarget
                ? document.getElementById(issueTarget)
                : fileTarget
                  ? document.getElementById(fileTarget)
                  : null;
            if (el) {
                el.scrollIntoView({
                    behavior: "smooth",
                    block: issueTarget ? "center" : "start",
                });
                return;
            }
            // ~3s of frames — enough for the provider/diff fetch to land.
            if (tries++ < 180) {
                raf = requestAnimationFrame(tryScroll);
                return;
            }
            // The suggestion card never showed (id drift / filtered out) —
            // fall back to at least landing on the file.
            if (issueTarget && fileTarget) {
                document
                    .getElementById(fileTarget)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        };
        raf = requestAnimationFrame(tryScroll);
        return () => cancelAnimationFrame(raf);
    }, [deepLinkFile, deepLinkIssue, dispatch]);

    const stickyAside =
        "lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto kodus-scroll";

    return (
        <div className="kodus-scroll h-full overflow-y-auto bg-[var(--bg)]">
            <section className="px-6 py-6">
                <div className="mx-auto max-w-[1600px]">
                    <NextLink
                        href="/pull-requests"
                        className="mb-4 inline-flex items-center gap-1.5 text-xs text-[var(--text-dim)] transition-colors hover:text-[var(--text-muted)]">
                        <ArrowLeftIcon className="size-3.5" />
                        Pull requests
                    </NextLink>

                    <div
                        className={`grid grid-cols-1 gap-5 transition-[grid-template-columns] duration-200 ease-out ${
                            state.sidebarOpen
                                ? "lg:grid-cols-[280px_minmax(0,1fr)_300px]"
                                : "lg:grid-cols-[40px_minmax(0,1fr)_300px]"
                        }`}>
                        {/* LEFT — file tree / collapsed rail */}
                        <aside className={stickyAside}>
                            {state.sidebarOpen ? (
                                <FileTree
                                    files={treeFiles}
                                    issues={treeIssues}
                                    activePath={state.selectedFilePath}
                                    viewed={state.viewedFiles}
                                    onPick={jumpToFile}
                                    prRef={`PR #${prNumber}`}
                                    mode={treeMode}
                                    onToggleMode={toggleTreeMode}
                                    onHide={() =>
                                        dispatch({ type: "TOGGLE_SIDEBAR" })
                                    }
                                />
                            ) : (
                                <FileTreeRail
                                    fileCount={treeFiles.length}
                                    onShow={() =>
                                        dispatch({ type: "TOGGLE_SIDEBAR" })
                                    }
                                />
                            )}
                        </aside>

                        {/* CENTER — header + diff */}
                        <div className="min-w-0">
                            <PrHeader
                                pr={pr}
                                suggestionCount={suggestionCount}
                                activeTab={activeTab}
                                onTabChange={setActiveTab}
                                tabs={WEB_TABS}
                            />

                            {activeTab === "review" && (
                                <ErrorBoundary FallbackComponent={PanelError}>
                                    <DiffViewer
                                        patchFiles={patchFiles}
                                        patchesLoading={patchesLoading}
                                        patchesError={patchesError}
                                        prNumber={prNumber}
                                        prUrl={prUrl}
                                        repositoryName={repositoryName}
                                        highlightIssueId={
                                            deepLinkIssue ?? undefined
                                        }
                                    />
                                </ErrorBoundary>
                            )}

                            {activeTab === "commits" && (
                                <CommitsList commits={commits} />
                            )}
                        </div>

                        {/* RIGHT — issues + PR metadata */}
                        <aside className={stickyAside}>
                            <ErrorBoundary FallbackComponent={PanelError}>
                                <RightSidebar
                                    pr={pr}
                                    issues={treeIssues}
                                    isCompleted
                                    onJumpToIssue={jumpToFile}
                                />
                            </ErrorBoundary>
                        </aside>
                    </div>
                </div>
            </section>
        </div>
    );
}

function FileTreeRail({
    fileCount,
    onShow,
}: {
    fileCount: number;
    onShow: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onShow}
            aria-label="Show file tree"
            title="Show file tree (b)"
            className="group flex w-full flex-col items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/70 py-3 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-3)]">
            <span className="inline-flex size-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors group-hover:text-[var(--text)]">
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden>
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                    <polyline points="14 9 17 12 14 15" />
                </svg>
            </span>
            <span
                className="font-mono text-[10px] tracking-[0.16em] text-[var(--text-dim)] uppercase transition-colors group-hover:text-[var(--text-muted)]"
                style={{
                    writingMode: "vertical-rl",
                    transform: "rotate(180deg)",
                }}>
                {fileCount} file{fileCount === 1 ? "" : "s"}
            </span>
        </button>
    );
}
