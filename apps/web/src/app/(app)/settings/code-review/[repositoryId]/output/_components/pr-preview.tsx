"use client";

import type { ReactNode } from "react";
import { Button } from "@components/ui/button";
import { Markdown } from "@components/ui/markdown";
import { PullRequestMessageStatus } from "@services/pull-request-messages/types";
import { XIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import {
    BehaviourForNewCommits,
    CodeReviewSummaryOptions,
} from "../../../_types";
import type {
    CustomMessagesEditor,
    CustomMessageType,
} from "../../custom-messages/_components/custom-messages-editor";
import {
    DEFAULT_ERROR_COMMENT_SAMPLE,
    getStatusLabel,
    MessagePreview,
    preserveLineBreaks,
} from "../../custom-messages/_components/tab-content";

// A fixed sample PR. Everything Kody-authored below is composed from the
// settings on the left; the human-authored parts never change.
const EXISTING_DESCRIPTION =
    "Retries failed webhook deliveries up to 3 times with exponential backoff.\n\nFixes #482.";
const KODY_SUMMARY =
    "## Summary by Kody\n\n- Adds exponential backoff (3 attempts) to `WebhookDeliveryService`\n- New `WEBHOOK_RETRY_MAX` setting, default 3\n- Tests cover the retry and the give-up path";
const KODY_COMPLEMENT =
    "**What's new (by Kody):** backoff is exponential and capped by `WEBHOOK_RETRY_MAX`; the give-up path now emits a `webhook.failed` event.";
const SAMPLE_SUGGESTION =
    '**Possible null dereference**\n\n`payload.headers` is undefined when a webhook is replayed, so reading `x-signature` throws before the retry runs. Guard it first.\n\n```ts\nconst signature = payload.headers?.["x-signature"];\nif (!signature) return reject("missing signature");\n```';

const isPosted = (status: PullRequestMessageStatus) =>
    status !== PullRequestMessageStatus.OFF &&
    status !== PullRequestMessageStatus.INACTIVE;

const Comment = ({
    meta,
    editing,
    hidden,
    children,
}: {
    meta: string;
    editing?: boolean;
    /** "Post as hidden comment" is on: render as GitHub renders a minimized comment. */
    hidden?: boolean;
    children: ReactNode;
}) => (
    <div
        className={cn(
            "border-card-lv3/60 bg-card-lv1 rounded-lg border",
            editing && "ring-primary-light/40 ring-1",
        )}>
        <div className="border-card-lv3/60 flex items-center gap-2 border-b px-3 py-2 text-xs">
            <span
                aria-hidden
                className="bg-primary-light text-primary-dark text-2xs flex size-5 shrink-0 items-center justify-center rounded-full font-bold">
                K
            </span>
            <span className="text-text-primary font-medium">kody</span>
            <span className="text-text-tertiary truncate">{meta}</span>
            {editing && (
                <span className="bg-secondary-dark text-secondary-light text-2xs ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium">
                    Editing
                </span>
            )}
        </div>
        {hidden ? (
            <details className="px-3 py-2 text-xs">
                <summary className="text-text-tertiary cursor-pointer list-none">
                    This comment was minimized.{" "}
                    <span className="text-text-secondary underline">Show</span>
                </summary>
                <div className="mt-3 text-sm">{children}</div>
            </details>
        ) : (
            <div className="px-3 py-3 text-sm">{children}</div>
        )}
    </div>
);

const NotPosted = ({ children }: { children: ReactNode }) => (
    <p className="text-text-tertiary border-card-lv3/60 rounded-lg border border-dashed px-3 py-2 text-xs">
        {children}
    </p>
);

/**
 * A sample pull request that re-renders from the settings being edited:
 * the description with or without Kody's summary, the comments Kody posts
 * while reviewing, and whether they arrive minimized. Deterministic — no
 * model call — so it is exact for everything except the suggestion text,
 * which is a fixed sample.
 */
export const PrPreview = ({
    summaryOn,
    existingBehaviour,
    newCommitsBehaviour,
    messages,
    activeMessage,
    hideComments,
    copyPrompt,
    onHide,
}: {
    summaryOn: boolean;
    existingBehaviour?: string;
    newCommitsBehaviour?: string;
    messages: CustomMessagesEditor["editorState"]["messages"];
    activeMessage: CustomMessageType | null;
    hideComments: boolean;
    copyPrompt: boolean;
    onHide?: () => void;
}) => {
    const description = !summaryOn
        ? EXISTING_DESCRIPTION
        : existingBehaviour === CodeReviewSummaryOptions.CONCATENATE
          ? `${EXISTING_DESCRIPTION}\n\n${KODY_SUMMARY}`
          : existingBehaviour === CodeReviewSummaryOptions.COMPLEMENT
            ? `${EXISTING_DESCRIPTION}\n\n${KODY_COMPLEMENT}`
            : KODY_SUMMARY;
    const newCommitsNote = !summaryOn
        ? null
        : newCommitsBehaviour === BehaviourForNewCommits.CONCATENATE
          ? "On new commits, another summary is added below."
          : newCommitsBehaviour === BehaviourForNewCommits.REPLACE
            ? "On new commits, the summary is rewritten."
            : "Kept as is when new commits arrive.";

    const start = messages.startReviewMessage;
    const end = messages.endReviewMessage;
    const error = messages.errorReviewMessage;
    const editingError = activeMessage === "errorReviewMessage";

    return (
        <div className="border-card-lv3/60 bg-card-lv1/60 flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-text-primary text-sm font-semibold">
                        On the pull request
                    </span>
                    <span className="text-text-tertiary text-xs">
                        A sample PR. Updates as you change the settings.
                    </span>
                </div>
                {onHide && (
                    <Button
                        size="icon-xs"
                        variant="cancel"
                        aria-label="Hide preview"
                        title="Hide preview"
                        onClick={onHide}>
                        <XIcon />
                    </Button>
                )}
            </div>

            <div className="border-card-lv3/60 flex flex-col gap-1 rounded-lg border px-3 py-2">
                <span className="text-text-primary text-sm font-medium">
                    Add retry with backoff to webhook delivery
                </span>
                <span className="text-text-tertiary text-xs">
                    #482 · ana wants to merge feat/webhook-retry into main
                </span>
            </div>

            <div className="border-card-lv3/60 bg-card-lv1 rounded-lg border">
                <div className="border-card-lv3/60 text-text-tertiary border-b px-3 py-2 text-xs">
                    Description
                    {summaryOn && (
                        <span className="text-secondary-light">
                            {" "}
                            · with Kody&apos;s summary
                        </span>
                    )}
                </div>
                <div className="px-3 py-3 text-sm">
                    <Markdown>{description}</Markdown>
                </div>
                {newCommitsNote && (
                    <div className="border-card-lv3/60 text-text-tertiary border-t px-3 py-1.5 text-xs">
                        {newCommitsNote}
                    </div>
                )}
            </div>

            {isPosted(start.status.value) ? (
                <Comment
                    meta={`when the review starts · ${getStatusLabel(start.status.value)}`}
                    editing={activeMessage === "startReviewMessage"}
                    hidden={hideComments}>
                    <MessagePreview content={start.content.value} />
                </Comment>
            ) : (
                <NotPosted>No comment when the review starts.</NotPosted>
            )}

            <Comment
                meta="inline, on the changed line · sample"
                hidden={hideComments}>
                <Markdown>{SAMPLE_SUGGESTION}</Markdown>
                {copyPrompt && (
                    <span className="border-card-lv3 text-text-secondary mt-3 inline-flex items-center rounded-md border px-2 py-1 text-xs">
                        Copy prompt for your AI assistant
                    </span>
                )}
                <p className="text-text-tertiary mt-3 text-xs">
                    Sample text. Style instructions change how Kody phrases
                    suggestions on real PRs, not this sample.
                </p>
            </Comment>

            {editingError ? (
                <Comment
                    meta="when the review fails"
                    editing
                    hidden={hideComments}>
                    <MessagePreview content={DEFAULT_ERROR_COMMENT_SAMPLE} />
                    {error.content.value.trim() ? (
                        <div className="border-card-lv3/60 mt-3 border-t pt-3">
                            <MessagePreview
                                content={preserveLineBreaks(
                                    error.content.value,
                                )}
                            />
                        </div>
                    ) : null}
                </Comment>
            ) : isPosted(end.status.value) ? (
                <Comment
                    meta={`when the review ends · ${getStatusLabel(end.status.value)}`}
                    editing={activeMessage === "endReviewMessage"}
                    hidden={hideComments}>
                    <MessagePreview content={end.content.value} />
                </Comment>
            ) : (
                <NotPosted>No comment when the review ends.</NotPosted>
            )}
        </div>
    );
};
