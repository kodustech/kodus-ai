"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { useTryReadTask } from "@services/business-logic/hooks";
import type { BusinessLogicSettingsValue } from "@services/business-logic/types";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useFormContext } from "react-hook-form";
import { unformatConfig } from "src/core/utils/helpers";

import type { CodeReviewFormType } from "../../../_types";

/** Reads one real task with the settings on screen, before saving (UC-01, UC-03, UC-05). */
export const TryIt = ({ teamId }: { teamId: string }) => {
    const form = useFormContext<CodeReviewFormType>();
    const [task, setTask] = useState("");
    const tryRead = useTryReadTask();
    const result = tryRead.data;

    const run = () => {
        const current = form.getValues("businessLogic" as never);
        const settings = current
            ? (unformatConfig(current as never) as BusinessLogicSettingsValue)
            : undefined;
        tryRead.mutate({ teamId, task, settings });
    };

    return (
        <section className="flex flex-col gap-3">
            <Heading variant="h3">Try it with a real task</Heading>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="min-w-60 flex-1"
                    placeholder="Task id or link, e.g. SAA-96"
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    onKeyDown={(e) => {
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

            {result && (
                <Card
                    color="lv1"
                    className="flex flex-col gap-2 px-5 py-4 text-sm">
                    {result.status === "found" && result.task ? (
                        <>
                            <span className="text-text-primary flex items-center gap-2 font-medium">
                                <CircleCheckIcon className="text-success size-4" />
                                Found {result.task.id}
                                {result.task.title
                                    ? ` · ${result.task.title}`
                                    : ""}{" "}
                                in {result.task.tracker}
                            </span>
                            <span className="text-text-secondary">
                                Description read ·{" "}
                                {result.task.descriptionLength} characters
                                {result.task.acceptanceCriteria
                                    ? ` · ${result.task.acceptanceCriteria} acceptance criteria${result.task.criteriaFromSettings ? " where you said they live" : ""}`
                                    : ""}
                            </span>
                            {!result.task.acceptanceCriteria && (
                                <span className="text-warning">
                                    No acceptance criteria found. Kody will
                                    judge against the whole description, which
                                    is less precise. Tell Kody where they live
                                    under “Tune to your team”.
                                </span>
                            )}
                            {!result.task.canJudge && (
                                <span className="text-warning">
                                    This task has too little in it to check a
                                    pull request against. Kody will ask the
                                    author for acceptance criteria.
                                </span>
                            )}
                            {result.task.hasAttachments && (
                                <span className="text-text-secondary">
                                    It has attachments. Kody doesn&apos;t read
                                    them; requirements that depend on them show
                                    as CHECK MANUALLY.
                                </span>
                            )}
                        </>
                    ) : (
                        <span className="text-text-primary flex items-center gap-2">
                            <CircleAlertIcon className="text-warning size-4" />
                            {result.message ?? "The task couldn't be read."}
                        </span>
                    )}
                </Card>
            )}
        </section>
    );
};
