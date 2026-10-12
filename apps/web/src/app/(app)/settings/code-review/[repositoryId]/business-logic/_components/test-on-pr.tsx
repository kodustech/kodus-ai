"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import { Markdown } from "@components/ui/markdown";
import { useTestOnPullRequest } from "@services/business-logic/hooks";
import type {
    BusinessLogicTestResult,
    RequirementState,
} from "@services/business-logic/types";
import { cn } from "src/core/utils/components";

import { useScreenSettings } from "./use-screen-settings";

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

const errorMessage = (error: unknown) =>
    (error as { body?: { message?: string } })?.body?.message ??
    "Couldn't run the test. Check the link and try again.";

/**
 * Runs Business Logic on a real pull request with the settings on screen,
 * saved or not, and shows every step and what would land on the PR. Nothing
 * is written until "Post to the pull request".
 */
export const TestOnPr = ({
    teamId,
    canEdit,
}: {
    teamId: string;
    canEdit: boolean;
}) => {
    const settings = useScreenSettings();
    const [prUrl, setPrUrl] = useState("");
    const [task, setTask] = useState("");
    const test = useTestOnPullRequest();
    const post = useTestOnPullRequest();
    const result = test.data;

    const canRun = !!prUrl.trim() && canEdit;
    const payload = () => ({
        teamId,
        prUrl: prUrl.trim(),
        taskInput: task.trim() || undefined,
        settings: settings(),
    });
    const run = () => {
        post.reset();
        test.mutate(payload());
    };
    const runOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && canRun) run();
    };

    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <Heading variant="h3">Test on a pull request</Heading>
                <p className="text-text-secondary text-sm">
                    Runs on a real pull request with the settings on this page,
                    saved or not. Nothing is posted until you choose to. Name a
                    task to check the pull request against it instead of the one
                    it references.
                </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="min-w-60 flex-1"
                    placeholder="Pull request link, e.g. https://github.com/acme/web/pull/47"
                    value={prUrl}
                    onChange={(e) => setPrUrl(e.target.value)}
                    onKeyDown={runOnEnter}
                />
                <Input
                    className="w-56"
                    placeholder="Task (optional), e.g. #245"
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    onKeyDown={runOnEnter}
                />
                <Button
                    size="md"
                    variant="secondary"
                    disabled={!canRun}
                    loading={test.isPending}
                    onClick={run}>
                    Run test
                </Button>
            </div>

            {test.isPending && (
                <p className="text-text-secondary text-sm">
                    Reading the task and checking the pull request. This takes
                    up to a minute.
                </p>
            )}
            {test.isError && (
                <p className="text-danger text-sm">
                    {errorMessage(test.error)}
                </p>
            )}

            {result && !test.isPending && (
                <TestResult
                    result={result}
                    canEdit={canEdit}
                    posting={post.isPending}
                    posted={post.data?.posted}
                    postError={post.isError ? errorMessage(post.error) : null}
                    onPost={() => post.mutate({ ...payload(), post: true })}
                />
            )}
        </section>
    );
};

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

const TestResult = ({
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
                            {INTENT[r.intent]}
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
                    Check <code>kody/business-logic</code>:{" "}
                    {result.check.supported
                        ? `${result.check.conclusion} · ${result.check.title}`
                        : "not written: this platform has no checks"}
                </span>
                <span>
                    Comment:{" "}
                    {result.comment.posted
                        ? result.comment.editsExisting
                            ? "edits the existing comment"
                            : "posted"
                        : `not posted. ${result.comment.reason ?? ""}`}
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
