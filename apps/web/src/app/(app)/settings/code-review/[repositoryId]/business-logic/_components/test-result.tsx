"use client";

import type { ReactNode } from "react";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Link } from "@components/ui/link";
import { Markdown } from "@components/ui/markdown";
import type {
    BusinessLogicTestResult,
    RequirementState,
} from "@services/business-logic/types";
import { cn } from "src/core/utils/components";

const SOURCE: Record<string, string> = {
    command: "the task you named",
    title: "the title",
    branch: "the branch",
    body: "the description",
};

const INTENT: Record<string, string> = {
    closes: "closes it",
    part_of: "part of it",
    mentions: "mentions it",
};

const STATE: Record<RequirementState, { label: string; tone: string }> = {
    met: { label: "MET", tone: "text-success" },
    partial: { label: "PARTIAL", tone: "text-warning" },
    missing: { label: "MISSING", tone: "text-danger" },
    check_manually: { label: "CHECK MANUALLY", tone: "text-text-secondary" },
};

const LOOKUP: Record<string, { label: string; tone: string }> = {
    found: { label: "found", tone: "text-success" },
    not_found: { label: "doesn't exist there", tone: "text-text-secondary" },
    error: { label: "failed", tone: "text-danger" },
};

export const errorMessage = (error: unknown) =>
    (error as { body?: { message?: string } })?.body?.message ??
    "Couldn't run the test. Check the link and try again.";

const Step = ({
    n,
    title,
    children,
}: {
    n: number;
    title: string;
    children: ReactNode;
}) => (
    <div className="flex gap-3">
        <span className="bg-card-lv2 text-text-secondary flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
            {n}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-text-primary text-sm font-medium">
                {title}
            </span>
            <div className="text-text-secondary flex flex-col gap-1 text-sm">
                {children}
            </div>
        </div>
    </div>
);

/** Every step of a test on a pull request, and what would land on it. */
export const TestResult = ({
    result,
    canEdit,
    posting,
    posted,
    postError,
    onPost,
}: {
    result: BusinessLogicTestResult;
    canEdit: boolean;
    posting: boolean;
    posted?: BusinessLogicTestResult["posted"];
    postError: string | null;
    onPost: () => void;
}) => {
    const { pullRequest, references, attempts, tasks, verdict } = result;
    const judged = verdict.tasks.length > 0;
    const named = references.some((r) => r.source === "command");

    return (
        <Card color="lv1" className="flex flex-col gap-5 px-5 py-4">
            <p className="text-text-secondary text-sm">
                <Link href={pullRequest.url} target="_blank">
                    {pullRequest.repositoryName} #{pullRequest.number}
                </Link>
                {pullRequest.title ? ` · ${pullRequest.title}` : ""}
            </p>

            <Step n={1} title="Task references in the pull request">
                {references.length ? (
                    references.map((r) => (
                        <span key={`${r.kind}:${r.id}`}>
                            <code>{r.raw}</code> in {SOURCE[r.source]} ·{" "}
                            {named && r.source !== "command"
                                ? "not used: you named the task"
                                : INTENT[r.intent]}
                        </span>
                    ))
                ) : (
                    <span>
                        None. Kody looks in the title, the branch and the
                        description for a task id or link, e.g. SAA-96 or #12.
                    </span>
                )}
            </Step>

            <Step n={2} title="Where each task was read">
                {attempts.length ? (
                    attempts.map((a, i) => (
                        <span key={i}>
                            <code>{a.reference}</code> → {a.tracker}:{" "}
                            <span className={LOOKUP[a.status]?.tone}>
                                {LOOKUP[a.status]?.label ?? a.status}
                            </span>
                            {a.tools?.length
                                ? ` · called ${a.tools.join(", ")}`
                                : ""}
                            {a.message ? ` · ${a.message}` : ""}
                        </span>
                    ))
                ) : (
                    <span>
                        No tracker was asked
                        {result.trackers.length
                            ? ""
                            : ": none of the connected plugins reads tasks"}
                        .
                    </span>
                )}
            </Step>

            <Step n={3} title="What the task asks">
                {tasks.length ? (
                    tasks.map((t) => (
                        <div key={t.id} className="flex flex-col gap-1">
                            <span className="text-text-primary">
                                {t.url ? (
                                    <Link href={t.url} target="_blank">
                                        {t.id}
                                    </Link>
                                ) : (
                                    t.id
                                )}
                                {t.title ? ` · ${t.title}` : ""}
                            </span>
                            {t.criteria.length ? (
                                <ul className="list-disc pl-4.5">
                                    {t.criteria.map((c) => (
                                        <li key={c}>{c}</li>
                                    ))}
                                </ul>
                            ) : (
                                <span className="text-warning">
                                    No acceptance criteria found: judged against
                                    the description ({t.descriptionLength}{" "}
                                    characters).
                                </span>
                            )}
                        </div>
                    ))
                ) : (
                    <Markdown className="[&_h2]:text-text-primary [&_h2]:text-sm [&_h2]:font-medium">
                        {(verdict.message ?? "No task was read.").replace(
                            /<!--[\s\S]*?-->/g,
                            "",
                        )}
                    </Markdown>
                )}
            </Step>

            {judged && (
                <Step n={4} title="Verdict">
                    {verdict.tasks.map((t) => (
                        <div key={t.id} className="flex flex-col gap-1">
                            {verdict.tasks.length > 1 && (
                                <span className="text-text-primary">
                                    {t.id}
                                </span>
                            )}
                            {t.requirements.map((r, i) => (
                                <span key={i}>
                                    <span
                                        className={cn(
                                            "font-medium",
                                            STATE[r.state]?.tone,
                                        )}>
                                        {r.accepted
                                            ? "ACCEPTED"
                                            : STATE[r.state]?.label}
                                    </span>{" "}
                                    {r.requirement}
                                    {r.note ? ` — ${r.note}` : ""}
                                </span>
                            ))}
                            {t.outOfScope.map((o, i) => (
                                <span key={`o${i}`}>
                                    <span className="text-warning font-medium">
                                        NOT IN TASK
                                    </span>{" "}
                                    {o.change}
                                </span>
                            ))}
                        </div>
                    ))}
                </Step>
            )}

            <Step n={judged ? 5 : 4} title="On the pull request">
                <span>
                    Check <code>kody/business-logic</code> would be:{" "}
                    {result.check.supported
                        ? `${result.check.conclusion} · ${result.check.title}`
                        : "not written: this platform has no checks"}
                </span>
                <span>
                    Comment:{" "}
                    {result.comment.posted
                        ? result.comment.editsExisting
                            ? "would edit the existing comment"
                            : "would be posted"
                        : `wouldn't be posted. ${result.comment.reason ?? ""}`}
                </span>
                {result.comment.body && (
                    <div className="border-card-lv3/60 bg-background mt-2 rounded-lg border px-4 py-3">
                        <Markdown>{result.comment.body}</Markdown>
                    </div>
                )}
            </Step>

            <div className="flex flex-wrap items-center gap-3">
                <Button
                    size="md"
                    variant="secondary"
                    disabled={!canEdit || !!posted}
                    loading={posting}
                    onClick={onPost}>
                    Post to the pull request
                </Button>
                <span className="text-text-secondary text-xs">
                    {posted
                        ? posted === "none"
                            ? "Nothing to post: the comment isn't posted for this result. The check was updated."
                            : `Comment ${posted} on #${pullRequest.number}.`
                        : "Runs again and posts the comment and the check, as @kody -v business-logic does."}
                </span>
                {postError && (
                    <span className="text-danger text-xs">{postError}</span>
                )}
            </div>
        </Card>
    );
};
