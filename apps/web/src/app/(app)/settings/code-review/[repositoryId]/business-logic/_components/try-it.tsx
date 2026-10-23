"use client";

import { useState, type KeyboardEvent } from "react";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Input } from "@components/ui/input";
import {
    usePostTestResult,
    useTestOnPullRequest,
    useTryReadTask,
} from "@services/business-logic/hooks";
import type { TryReadResult } from "@services/business-logic/types";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";

import { errorMessage, TestResult } from "./test-result";
import { useScreenSettings } from "./use-screen-settings";

/**
 * One test for the settings on screen, saved or not. A task alone shows how
 * Kody reads it (UC-01, UC-03, UC-05); a pull request runs the whole check,
 * against the task it references or the one named here. Nothing is posted
 * until "Post to the pull request".
 */
export const TryIt = ({
    teamId,
    repositoryId,
    canEdit,
}: {
    teamId: string;
    repositoryId: string;
    canEdit: boolean;
}) => {
    const settings = useScreenSettings();
    const [prUrl, setPrUrl] = useState("");
    const [task, setTask] = useState("");
    const tryRead = useTryReadTask();
    const test = useTestOnPullRequest();
    const post = usePostTestResult();

    const onPr = !!prUrl.trim();
    // Both spend the org's model and read with its tracker credentials.
    const canRun = canEdit && (onPr || !!task.trim());
    const payload = () => ({
        teamId,
        prUrl: prUrl.trim(),
        taskInput: task.trim() || undefined,
        settings: settings(),
    });
    const run = () => {
        tryRead.reset();
        test.reset();
        post.reset();
        if (onPr) {
            test.mutate(payload());
        } else {
            tryRead.mutate({
                teamId,
                task: task.trim(),
                settings: settings(),
                repositoryId,
            });
        }
    };
    const runOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && canRun) run();
    };

    return (
        <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
            <span className="flex flex-col">
                <span className="text-text-primary text-sm font-medium">
                    Try it
                </span>
                <span className="text-text-secondary text-xs">
                    Paste a task to see what Kody reads from it, or a pull
                    request to run the whole check. Runs with the settings on
                    this page, saved or not; nothing is posted until you choose
                    to.
                </span>
            </span>
            <div className="flex flex-col gap-2">
                <div className="min-w-0">
                    <Input
                        size="md"
                        placeholder="Pull request link (optional)"
                        value={prUrl}
                        onChange={(e) => setPrUrl(e.target.value)}
                        onKeyDown={runOnEnter}
                    />
                </div>
                <div className="min-w-0">
                    <Input
                        size="md"
                        placeholder={
                            onPr
                                ? "Task (optional), else the one the PR references"
                                : "Task id or link, e.g. SAA-96 or #12"
                        }
                        value={task}
                        onChange={(e) => setTask(e.target.value)}
                        onKeyDown={runOnEnter}
                    />
                </div>
                <Button
                    size="md"
                    variant="secondary"
                    className="self-end"
                    disabled={!canRun}
                    loading={tryRead.isPending || test.isPending}
                    onClick={run}>
                    {onPr ? "Run check" : "Read task"}
                </Button>
            </div>
            {!canEdit && (
                <p className="text-text-secondary text-xs">
                    Trying a task or a pull request needs permission to edit
                    these settings.
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
            {tryRead.isError && (
                <p className="text-danger text-sm">
                    Couldn&apos;t reach Kodus to read the task. Try again.
                </p>
            )}

            {tryRead.data && <TaskRead result={tryRead.data} />}
            {test.data && !test.isPending && (
                <TestResult
                    result={test.data}
                    canEdit={canEdit}
                    posting={post.isPending}
                    posted={post.data?.posted}
                    postError={post.isError ? errorMessage(post.error) : null}
                    // The result on screen, as it is: not a second run.
                    onPost={() =>
                        post.mutate({
                            teamId,
                            previewToken: test.data!.previewToken,
                        })
                    }
                />
            )}
        </Card>
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
                    Add a pull request above to check it against this task.
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
