"use client";

import { useState } from "react";
import { RelativeTime } from "@components/runtime/relative-time";
import { StatusChip } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import { Skeleton } from "@components/ui/skeleton";
import { toast } from "@components/ui/toaster/use-toast";
import type { RuntimeLesson } from "@services/runtime/contracts";
import { blockerKindLabel } from "@services/runtime/labels";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    useEnvironmentLessons,
    useUpdateEnvironmentLesson,
} from "@services/runtime/queries";

// What Kody learned (ADR-018): each fix that got a blocker past, proven by a
// clean setup of the default branch right after it was blocked. A lesson of
// this repo applies here; promoted by an org admin, it applies to every repo
// of the org. Every text is a template; nothing here came from the repo.

type Pending = { lesson: RuntimeLesson; action: "promote" | "retire" };

const ACTION_COPY = {
    promote: {
        title: "Use this lesson in every repository of the org?",
        description:
            "When another repository hits the same blocker, this fix is offered first there too. It never leaves your organization.",
        confirm: "Promote",
        done: "Lesson promoted to the org",
    },
    retire: {
        title: "Retire this lesson?",
        description:
            "Kody stops offering this fix first. The fix itself stays in the catalog.",
        confirm: "Retire",
        done: "Lesson retired",
    },
} as const;

const LessonRow = ({
    lesson,
    canManage,
    onAct,
    repositoryId,
}: {
    lesson: RuntimeLesson;
    canManage: boolean;
    onAct: (p: Pending) => void;
    /** This environment's repository: a lesson proven in another one says so. */
    repositoryId?: string;
}) => (
    <li
        aria-label={lesson.problem}
        className="bg-card-lv2 flex flex-col gap-2 rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{lesson.problem}</span>
            <StatusChip tone="warning">
                {blockerKindLabel(lesson.kind)}
            </StatusChip>
            <StatusChip tone={lesson.scope === "org" ? "info" : "neutral"}>
                {lesson.scope === "org" ? "Whole org" : "This repository"}
            </StatusChip>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-tertiary">Cause</dt>
            <dd className="text-text-secondary">{lesson.cause}</dd>
            <dt className="text-text-tertiary">What worked</dt>
            <dd className="text-text-secondary">{lesson.fix.summary}</dd>
            <dt className="text-text-tertiary">Proven</dt>
            <dd className="text-text-secondary">
                by a clean setup of{" "}
                {lesson.origin.branch ?? "the default branch"} at{" "}
                <span className="font-mono text-xs">
                    {lesson.origin.sha.slice(0, 7)}
                </span>{" "}
                · <RelativeTime at={lesson.origin.at} />
                {lesson.helped > 1 ? ` · helped ${lesson.helped}×` : ""}
                {repositoryId &&
                    lesson.origin.repositoryId !== repositoryId &&
                    " · learned in another repository of the org, promoted to the whole org"}
            </dd>
        </dl>
        {canManage && (
            <div className="flex gap-2">
                {lesson.scope === "repo" && (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onAct({ lesson, action: "promote" })}>
                        Use in the whole org
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="cancel"
                    onClick={() => onAct({ lesson, action: "retire" })}>
                    Retire
                </Button>
            </div>
        )}
    </li>
);

export const EnvironmentLessons = ({
    environmentId,
    repositoryId,
    canManage,
}: {
    environmentId: string;
    repositoryId?: string;
    /** Org admins promote and retire; everyone who reads the environment sees the lessons. */
    canManage: boolean;
}) => {
    const lessons = useEnvironmentLessons(environmentId);
    const update = useUpdateEnvironmentLesson();
    const [pending, setPending] = useState<Pending>();

    if (lessons.isLoading) return <Skeleton className="h-16 w-full" />;
    if (lessons.isError) {
        return (
            <p className="text-text-secondary text-sm">
                Couldn't load what Kody learned. Reload the page to try again.
            </p>
        );
    }
    const list = lessons.data ?? [];
    if (list.length === 0) {
        return (
            <p className="text-text-secondary text-sm">
                Nothing learned yet. When a fix gets a blocker past, the next
                clean setup proves it and it shows up here, offered first the
                next time.
            </p>
        );
    }

    const copy = pending ? ACTION_COPY[pending.action] : undefined;
    return (
        <>
            <ul aria-label="Lessons" className="flex flex-col gap-2">
                {list.map((l) => (
                    <LessonRow
                        key={l.lessonId}
                        lesson={l}
                        canManage={canManage}
                        onAct={setPending}
                        repositoryId={repositoryId}
                    />
                ))}
            </ul>
            <ConfirmModal
                open={!!pending}
                title={copy?.title ?? ""}
                description={copy?.description ?? ""}
                confirmText={copy?.confirm ?? ""}
                loading={update.isPending}
                onCancel={() => setPending(undefined)}
                onConfirm={() =>
                    pending &&
                    update.mutate(
                        {
                            environmentId,
                            lessonId: pending.lesson.lessonId,
                            action: pending.action,
                        },
                        {
                            onSuccess: () => {
                                toast({
                                    variant: "success",
                                    title: copy!.done,
                                });
                                setPending(undefined);
                            },
                            onError: (error) =>
                                toast({
                                    variant: "danger",
                                    title: "Couldn't update the lesson",
                                    description: runtimeErrorMessage(error, {
                                        fallback: "Try again in a moment.",
                                        403: "Only an org admin can change what Kody learned.",
                                    }),
                                }),
                        },
                    )
                }
            />
        </>
    );
};
