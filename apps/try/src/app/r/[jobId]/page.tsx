"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
    getFeaturedReview,
    getJobStatus,
    type JobStatusResponse,
} from "@/lib/api";
import { loadSnapshot, saveSnapshot, type ReviewSnapshot } from "@/lib/snapshot";
import { isFeaturedSlug as detectFeaturedSlug } from "@/lib/jobId";
import { parseUnifiedDiff } from "@/lib/diff";
import { loadViewed, setViewed as persistViewed } from "@/lib/viewed";
import { ReviewProgressBar } from "@/components/ReviewProgressBar";
import { SignupBanner } from "@/components/SignupBanner";
import { DiffViewer } from "@/components/DiffViewer";
import { CommitsList } from "@/components/CommitsList";
import { DescriptionTab } from "@/components/DescriptionTab";
import { DiscussionList } from "@/components/DiscussionList";
import { FileTree } from "@/components/FileTree";
import { FileTreeGrouped } from "@/components/FileTreeGrouped";
import { MainHeader } from "@/components/MainHeader";
import { PrHeader, type PrTab } from "@/components/PrHeader";
import { RightSidebar } from "@/components/RightSidebar";
import { ViewSettingsMenu } from "@/components/ViewSettingsMenu";
import {
    loadPreferences,
    savePreferences,
    type Preferences,
} from "@/lib/preferences";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export default function ResultPage({
    params,
}: {
    params: Promise<{ jobId: string }>;
}) {
    const { jobId } = use(params);

    const [job, setJob] = useState<JobStatusResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
    const [activeFile, setActiveFile] = useState<string | null>(null);
    const [viewed, setViewedState] = useState<Record<string, boolean>>({});
    const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [activeTab, setActiveTab] = useState<PrTab>("review");
    const startedAtRef = useRef<number>(Date.now());

    useEffect(() => {
        setSnapshot(loadSnapshot(jobId));
        setViewedState(loadViewed(jobId));
        setPrefs(loadPreferences());
    }, [jobId]);

    const updatePrefs = (next: Preferences) => {
        setPrefs(next);
        savePreferences(next);
    };

    const toggleCollapsed = (path: string) => {
        setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
    };

    const expandAll = () => setCollapsed({});
    const collapseAll = () => {
        if (!snapshot) return;
        const next: Record<string, boolean> = {};
        for (const f of parseUnifiedDiff(snapshot.diff)) next[f.path] = true;
        setCollapsed(next);
    };

    const isFeaturedSlug = detectFeaturedSlug(jobId);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const tick = () =>
            setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));

        // Featured reviews are pre-curated snapshots — load once,
        // no polling, no progress strip. The result is fixed at
        // curation time, so we synthesize a "COMPLETED" job for the
        // rest of the UI to consume unchanged.
        const loadFeatured = async () => {
            try {
                const detail = await getFeaturedReview(jobId);
                if (cancelled) return;
                const fresh = { pr: detail.pr, diff: detail.diff };
                setSnapshot(fresh);
                saveSnapshot(jobId, fresh);
                setJob({
                    jobId,
                    status: "COMPLETED",
                    result: detail.result,
                    createdAt: new Date().toISOString(),
                } as JobStatusResponse);
            } catch (e: any) {
                if (cancelled) return;
                setError(
                    e?.message ||
                        "Couldn't load this featured review. Try again later.",
                );
            }
        };

        const poll = async () => {
            try {
                // After the first successful snapshot, ask the API
                // to skip re-sending publicPr/publicDiff — the
                // client already has them in sessionStorage. Trims
                // each poll from ~15 KB down to a few hundred bytes.
                const hasSnapshot = !!loadSnapshot(jobId);
                const result = await getJobStatus(jobId, {
                    omitPayload: hasSnapshot,
                });
                if (cancelled) return;
                setJob(result);
                tick();

                if (result.publicPr && result.publicDiff) {
                    setSnapshot((prev) => {
                        const prevHasState = !!prev?.pr?.state;
                        const serverHasState = !!result.publicPr?.state;
                        // Older snapshots may be richer than the server
                        // payload — never trade fields away on refresh.
                        if (prev && prevHasState && !serverHasState) {
                            return prev;
                        }
                        // Identical payload? Skip allocating a new
                        // object so the downstream useMemo on
                        // diffFiles doesn't re-parse the entire diff
                        // every 3-second poll.
                        if (
                            prev &&
                            prev.diff === result.publicDiff &&
                            prev.pr.state === result.publicPr?.state
                        ) {
                            return prev;
                        }
                        const fresh = {
                            pr: result.publicPr!,
                            diff: result.publicDiff!,
                        };
                        saveSnapshot(jobId, fresh);
                        return fresh;
                    });
                }

                const done =
                    result.status === "COMPLETED" ||
                    result.status === "FAILED";
                if (done) return;

                if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
                    setError(
                        "Review is taking longer than expected. Try again later.",
                    );
                    return;
                }

                timer = setTimeout(poll, POLL_INTERVAL_MS);
            } catch (e: any) {
                if (cancelled) return;
                setError(
                    e?.message ||
                        "Failed to load review status. Refresh to retry.",
                );
            }
        };

        const ticker = setInterval(tick, 1000);
        if (isFeaturedSlug) {
            loadFeatured();
        } else {
            poll();
        }

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            clearInterval(ticker);
        };
    }, [jobId, isFeaturedSlug]);

    const diffFiles = useMemo(() => {
        if (!snapshot) return [];
        return parseUnifiedDiff(snapshot.diff);
    }, [snapshot]);

    useEffect(() => {
        if (!activeFile && diffFiles.length > 0) {
            setActiveFile(diffFiles[0].path);
        }
    }, [diffFiles, activeFile]);

    const issues = job?.result?.issues ?? [];
    const isCompleted = job?.status === "COMPLETED" && !!job.result;
    const isFailed = job?.status === "FAILED";

    const jumpToFile = (path: string) => {
        setActiveFile(path);
        const el = document.getElementById(`file-${path}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const toggleViewed = (path: string, value: boolean) => {
        const next = persistViewed(jobId, path, value);
        setViewedState(next);
    };

    return (
        <main className="min-h-screen flex flex-col">
            <MainHeader />

            {/* Pin the progress strip right under the navbar while
                the review is still running. Lets the user read the PR
                in full while Kodus works in the background. */}
            {!isCompleted && !isFailed && !error && (
                <ReviewProgressBar
                    elapsedSeconds={elapsed}
                    pr={snapshot?.pr}
                    files={diffFiles.map((f) => f.path)}
                />
            )}

            <section className="flex-1 px-6 py-6">
                <div className="max-w-[1600px] mx-auto">
                    {error && (
                        <div className="rounded-lg border border-[var(--orange)]/30 bg-[var(--orange)]/5 px-4 py-3 text-sm text-[var(--text)] mb-6">
                            {error}
                        </div>
                    )}

                    {isFailed && (
                        <div className="rounded-lg border border-[var(--orange)]/30 bg-[var(--orange)]/5 px-4 py-3 text-sm text-[var(--text)] mb-6">
                            <p className="font-medium mb-1">Review failed</p>
                            <p className="text-[var(--text-muted)]">
                                {job?.error ||
                                    "Something went wrong inside the sandbox."}
                            </p>
                        </div>
                    )}

                    {diffFiles.length > 0 ? (
                        <div
                            className={`grid grid-cols-1 gap-5 transition-[grid-template-columns] duration-200 ease-out ${
                                prefs.fileTreeHidden
                                    ? "lg:grid-cols-[40px_minmax(0,1fr)_300px]"
                                    : "lg:grid-cols-[280px_minmax(0,1fr)_300px]"
                            }`}
                        >
                            <aside
                                className={`lg:sticky lg:self-start lg:overflow-y-auto kodus-scroll ${
                                    isCompleted || isFailed
                                        ? "lg:top-20 lg:max-h-[calc(100vh-6rem)]"
                                        : "lg:top-32 lg:max-h-[calc(100vh-9rem)]"
                                }`}
                            >
                                {prefs.fileTreeHidden ? (
                                    <FileTreeRail
                                        fileCount={diffFiles.length}
                                        onShow={() =>
                                            updatePrefs({
                                                ...prefs,
                                                fileTreeHidden: false,
                                            })
                                        }
                                    />
                                ) : prefs.fileTreeMode === "grouped" &&
                                  snapshot?.pr?.groupings &&
                                  snapshot.pr.groupings.length > 0 ? (
                                    <FileTreeGrouped
                                        groupings={snapshot.pr.groupings}
                                        files={diffFiles}
                                        issues={issues}
                                        activePath={activeFile}
                                        viewed={viewed}
                                        onPick={jumpToFile}
                                        prRef={
                                            snapshot
                                                ? `PR #${snapshot.pr.prNumber}`
                                                : undefined
                                        }
                                        onHide={() =>
                                            updatePrefs({
                                                ...prefs,
                                                fileTreeHidden: true,
                                            })
                                        }
                                        onToggleMode={() =>
                                            updatePrefs({
                                                ...prefs,
                                                fileTreeMode: "tree",
                                            })
                                        }
                                    />
                                ) : (
                                    <FileTree
                                        files={diffFiles}
                                        issues={issues}
                                        activePath={activeFile}
                                        viewed={viewed}
                                        onPick={jumpToFile}
                                        prRef={
                                            snapshot
                                                ? `PR #${snapshot.pr.prNumber}`
                                                : undefined
                                        }
                                        onHide={() =>
                                            updatePrefs({
                                                ...prefs,
                                                fileTreeHidden: true,
                                            })
                                        }
                                        onToggleMode={
                                            snapshot?.pr?.groupings &&
                                            snapshot.pr.groupings.length > 0
                                                ? () =>
                                                      updatePrefs({
                                                          ...prefs,
                                                          fileTreeMode:
                                                              "grouped",
                                                      })
                                                : undefined
                                        }
                                    />
                                )}
                            </aside>

                            <div className="min-w-0">
                                {snapshot?.pr && (
                                    <PrHeader
                                        pr={snapshot.pr}
                                        suggestionCount={issues.length}
                                        activeTab={activeTab}
                                        onTabChange={setActiveTab}
                                        toolbar={
                                            <ViewSettingsMenu
                                                prefs={prefs}
                                                onChange={updatePrefs}
                                                onExpandAll={expandAll}
                                                onCollapseAll={collapseAll}
                                            />
                                        }
                                    />
                                )}

                                {activeTab === "description" &&
                                    snapshot?.pr && (
                                        <DescriptionTab pr={snapshot.pr} />
                                    )}

                                {activeTab === "review" && (
                                    <DiffViewer
                                        files={diffFiles}
                                        issues={issues}
                                        rawDiff={snapshot?.diff ?? ""}
                                        pr={snapshot?.pr}
                                        viewed={viewed}
                                        onToggleViewed={toggleViewed}
                                        diffStyle={prefs.diffStyle}
                                        hideHighlights={prefs.hideHighlights}
                                        collapsed={collapsed}
                                        onToggleCollapsed={toggleCollapsed}
                                        isReviewing={
                                            !isCompleted && !isFailed && !error
                                        }
                                    />
                                )}

                                {activeTab === "commits" && (
                                    <CommitsList
                                        commits={snapshot?.pr?.commits ?? []}
                                    />
                                )}

                                {activeTab === "discussion" && (
                                    <DiscussionList
                                        comments={
                                            snapshot?.pr?.comments ?? []
                                        }
                                    />
                                )}

                                <div className="mt-6">
                                    <SignupBanner />
                                </div>
                            </div>

                            <aside
                                className={`lg:sticky lg:self-start lg:overflow-y-auto kodus-scroll ${
                                    isCompleted || isFailed
                                        ? "lg:top-20 lg:max-h-[calc(100vh-6rem)]"
                                        : "lg:top-32 lg:max-h-[calc(100vh-9rem)]"
                                }`}
                            >
                                <RightSidebar
                                    pr={snapshot?.pr}
                                    issues={issues}
                                    isCompleted={isCompleted}
                                    onJumpToIssue={jumpToFile}
                                />
                            </aside>
                        </div>
                    ) : (
                        !snapshot &&
                        isCompleted &&
                        job?.result && (
                            <FlatSuggestions issues={issues} />
                        )
                    )}
                </div>
            </section>

            <footer className="border-t border-[var(--border)] px-6 py-6">
                <div className="max-w-[1600px] mx-auto flex items-center justify-between text-xs text-[var(--text-dim)]">
                    <Link href="/" className="hover:text-[var(--text-muted)]">
                        ← Review another PR
                    </Link>
                    <a
                        href="https://kodus.io"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[var(--text-muted)]"
                    >
                        kodus.io
                    </a>
                </div>
            </footer>
        </main>
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
            title="Show file tree"
            // Occupies the exact same slot the FileTree did — same
            // border + bg + rounded corners — so "click here to expand"
            // reads as "this is where the sidebar lives, collapsed".
            className="group hidden lg:flex flex-col items-center gap-3 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/70 hover:bg-[var(--bg-3)] hover:border-[var(--border-strong)] py-3 transition-colors"
        >
            <span className="inline-flex items-center justify-center w-6 h-6 rounded text-[var(--text-muted)] group-hover:text-[var(--text)] transition-colors">
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                    <polyline points="14 9 17 12 14 15" />
                </svg>
            </span>
            <span
                className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-dim)] group-hover:text-[var(--text-muted)] font-mono transition-colors"
                style={{
                    writingMode: "vertical-rl",
                    transform: "rotate(180deg)",
                }}
            >
                {fileCount} file{fileCount === 1 ? "" : "s"}
            </span>
        </button>
    );
}

function FlatSuggestions({
    issues,
}: {
    issues: { file: string; line: number; severity: string; message: string }[];
}) {
    if (issues.length === 0) {
        return (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-5 py-6 text-center">
                <p className="text-[var(--green)] font-medium">
                    Nothing to flag.
                </p>
            </div>
        );
    }
    return (
        <ul className="space-y-2">
            {issues.map((issue, idx) => (
                <li
                    key={idx}
                    className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4 text-sm"
                >
                    <p className="font-mono text-xs text-[var(--text-dim)] mb-1">
                        {issue.file}:{issue.line}
                    </p>
                    <p>{issue.message}</p>
                </li>
            ))}
        </ul>
    );
}
