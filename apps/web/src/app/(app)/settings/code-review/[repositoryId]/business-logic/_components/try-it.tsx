"use client";

import { useState, type KeyboardEvent } from "react";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import {
    useTestOnPullRequest,
    useTryReadTask,
} from "@services/business-logic/hooks";
import type { TryReadResult } from "@services/business-logic/types";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";

import { errorMessage, TestResult } from "./test-result";
import { useScreenSettings } from "./use-screen-settings";

/**
 * Reads one task the way a validation would, with the settings on screen,
 * saved or not (UC-01, UC-03, UC-05): where the admin picks the source, so a
 * wrong source or plugin shows before anything else is set.
 */
export const ReadTask = ({
    teamId,
    repositoryId,
}: {
    teamId: string;
    repositoryId: string;
}) => {
    const settings = useScreenSettings();
    const [task, setTask] = useState("");
    const tryRead = useTryReadTask();
    const run = () =>
        tryRead.mutate({
            teamId,
            task: task.trim(),
            settings: settings(),
            repositoryId,
        });

    return (
        <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
            <span className="flex flex-col">
                <span className="text-text-primary text-sm font-medium">
                    Read a task
                </span>
                <span className="text-text-secondary text-xs">
                    See what Kody reads from one of your tasks with the source
                    above, saved or not.
                </span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="min-w-60 flex-1"
                    placeholder="Task id or link, e.g. SAA-96, #12 or a ClickUp link"
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter" && task.trim()) run();
                    }}
                />
                <Button
                    size="md"
                    variant="secondary"
                    disabled={!task.trim()}
                    loading={tryRead.isPending}
                    onClick={run}>
                    Read task
                </Button>
            </div>
            {tryRead.isError && (
                <p className="text-danger text-sm">
                    Couldn&apos;t reach Kodus to read the task. Try again.
                </p>
            )}
            {tryRead.data && <TaskRead result={tryRead.data} />}
        </Card>
    );
};

/**
 * The whole check on a pull request, with the settings on screen, saved or
 * not: against the task it references, or the one named here. Nothing is
 * posted until "Post to the pull request".
 */
export const TryIt = ({
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

    const canRun = !!prUrl.trim() && canEdit;
    const payload = () => ({
        teamId,
        prUrl: prUrl.trim(),
        taskInput: task.trim() || undefined,
        settings: settings(),
    });
    const run = () => {
        test.reset();
        post.reset();
        test.mutate(payload());
    };
    const runOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && canRun) run();
    };

    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <Heading variant="h3">Check a pull request</Heading>
                <p className="text-text-secondary text-sm">
                    Runs the whole check with the settings on this page, saved
                    or not, against the task the pull request references or the
                    one you name. Nothing is posted until you choose to.
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
                    placeholder="Task (optional), e.g. SAA-96"
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
                    Run check
                </Button>
            </div>
            {!canEdit && (
                <p className="text-text-secondary text-xs">
                    Checking a pull request needs permission to edit these
                    settings.
                </p>
            )}

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
            {test.data && !test.isPending && (
                <TestResult
                    result={test.data}
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

const TaskRead = ({ result }: { result: TryReadResult }) => (
    <Card color="lv1" className="flex flex-col gap-2 px-5 py-4 text-sm">
        {result.status === "found" && result.task ? (
            <>
                <span className="text-text-primary flex items-center gap-2 font-medium">
                    <CircleCheckIcon className="text-success size-4" />
                    Found {result.task.id}
                    {result.task.title ? ` · ${result.task.title}` : ""} in{" "}
                    {result.task.tracker}
                </span>
                <span className="text-text-secondary">
                    Description read · {result.task.descriptionLength}{" "}
                    characters
                    {result.task.acceptanceCriteria
                        ? ` · ${result.task.acceptanceCriteria} acceptance criteria${result.task.criteriaFromSettings ? " where you said they live" : ""}`
                        : ""}
                </span>
                {result.task.criteriaNotWhereSaid && (
                    <span className="text-warning">
                        This task has no heading or field where you said
                        criteria live, so Kody detected them as with “Detect
                        automatically”.
                    </span>
                )}
                {!result.task.acceptanceCriteria &&
                    result.task.canJudge &&
                    !result.task.parent && (
                        <span className="text-warning">
                            No acceptance criteria found, so Kody will judge
                            against the whole description, which is less
                            precise. Write them as a list or a checklist in the
                            task, or, if they already live under a heading or in
                            a custom field, say where under “Tune to your team”.
                        </span>
                    )}
                {!result.task.canJudge && (
                    <span className="text-warning">
                        This task has too little in it to check a pull request
                        against. Kody will ask the author for acceptance
                        criteria.
                    </span>
                )}
                {result.task.parent && (
                    <span className="text-text-secondary">
                        Part of {result.task.parent.id}
                        {result.task.parent.title
                            ? ` · ${result.task.parent.title}`
                            : ""}
                        .{" "}
                        {result.task.acceptanceCriteria
                            ? "Kody reads it too, as context for this task."
                            : "This task has no criteria of its own, so Kody takes the parent's criteria this task covers."}
                    </span>
                )}
                {!!result.task.subtasks && (
                    <span className="text-text-secondary">
                        Split into {result.task.subtasks} sub-task
                        {result.task.subtasks === 1 ? "" : "s"}. What one of
                        them covers shows as CHECK MANUALLY, not MISSING.
                    </span>
                )}
                {result.task.hasAttachments && (
                    <span className="text-text-secondary">
                        It has attachments. Kody doesn&apos;t read them;
                        requirements that depend on them show as CHECK MANUALLY.
                    </span>
                )}
                <span className="text-text-tertiary text-xs">
                    Check a pull request against it at the end of this page.
                </span>
            </>
        ) : (
            <span className="text-text-primary flex items-center gap-2">
                <CircleAlertIcon className="text-warning size-4" />
                {result.message ?? "The task couldn't be read."}
            </span>
        )}
    </Card>
);
