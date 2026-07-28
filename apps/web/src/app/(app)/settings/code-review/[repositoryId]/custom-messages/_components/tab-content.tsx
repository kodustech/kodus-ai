"use client";

import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { Heading } from "@components/ui/heading";
import { Label } from "@components/ui/label";
import { Markdown } from "@components/ui/markdown";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Textarea } from "@components/ui/textarea";
import { useSuspenseParentPullRequestMessages } from "@services/pull-request-messages/hooks";
import {
    CustomMessageConfig,
    PullRequestMessageStatus,
} from "@services/pull-request-messages/types";
import { ChevronDownIcon } from "lucide-react";
import { RuleType } from "markdown-to-jsx";
import { useDefaultCodeReviewConfig } from "src/app/(app)/settings/_components/context";
import { useCurrentConfigLevel } from "src/app/(app)/settings/_hooks";

import { OverrideIndicator } from "../../../_components/override";
import { FormattedConfig, FormattedConfigLevel } from "../../../_types";
import { CustomMessagesOptionsDropdown } from "./dropdown";
import { dropdownItems, VARIABLE_REGEX } from "./options";

// A faithful sample of Kody's default error comment (the `withErrors` template
// in the i18n dictionaries, with a representative reason). Shown in the Error
// preview so teams see exactly what their note gets appended to.
const DEFAULT_ERROR_COMMENT_SAMPLE = `## Code Review Could Not Complete ⚠️

The review failed before suggestions could be generated.

**Reason:** The configured AI provider rejected the request (invalid or missing API key).

After fixing the issue, comment \`@kody review\` on this PR to re-run the review.`;

// Kody always appends this guide footer to its review comments (success and
// error alike), generated server-side by generateConfigReviewMarkdown. It is
// NOT part of the custom message and can't be edited — shown here (static) only
// so the preview matches what actually lands on the PR.
const KODY_GUIDE_FOOTER_SAMPLE = `<details><summary>Kody Guide: Usage and Configuration</summary>

- Interacting with Kody
- Current Kody Configuration
</details>`;

// The error note preserves the author's line breaks: single \n collapse in
// Markdown, so convert each to a hard break (two trailing spaces) — mirrors the
// runtime so the preview matches what lands on the PR.
const preserveLineBreaks = (md: string) => md.replace(/\n/g, "  \n");

// Renders a message body with the same @variable substitution the live comment
// uses, so the preview matches what Kody actually posts.
const MessagePreview = ({ content }: { content: string }) => (
    <Markdown
        options={{
            renderRule: (next, node) => {
                if (node.type !== RuleType.text) return next();

                const regex = node.text.match(VARIABLE_REGEX);

                if (regex) {
                    const key = regex[0]?.replace(
                        "@",
                        "",
                    ) as keyof typeof dropdownItems;

                    if (!dropdownItems[key]) return next();

                    return (
                        <span key={key}>{dropdownItems[key]?.example}</span>
                    );
                }

                return next();
            },
        }}>
        {content}
    </Markdown>
);

const getStatusLabel = (status: PullRequestMessageStatus): string => {
    switch (status) {
        case PullRequestMessageStatus.EVERY_PUSH:
            return "Every push";
        case PullRequestMessageStatus.ONLY_WHEN_OPENED:
            return "Only when opened";
        case PullRequestMessageStatus.OFF:
            return "Off";
        case PullRequestMessageStatus.ACTIVE:
            return "Active (Legacy)";
        case PullRequestMessageStatus.INACTIVE:
            return "Inactive (Legacy)";
        default:
            return status;
    }
};

export const TabContent = (props: {
    type: "startReviewMessage" | "endReviewMessage" | "errorReviewMessage";
    value: FormattedConfig<CustomMessageConfig["startReviewMessage"]>;
    initialState: FormattedConfig<CustomMessageConfig["startReviewMessage"]>;
    onChangeAction: (value: CustomMessageConfig["startReviewMessage"]) => void;
    canEdit: boolean;
}) => {
    const defaults = useDefaultCodeReviewConfig()?.customMessages;
    const currentLevel = useCurrentConfigLevel();
    const hasParent = currentLevel !== FormattedConfigLevel.GLOBAL;
    const isGlobalScope = currentLevel === FormattedConfigLevel.GLOBAL;
    const isErrorMessage = props.type === "errorReviewMessage";
    // The error message has no on/off toggle — the presence of content is the
    // only switch. Any content write persists ACTIVE so the runtime append-gate
    // (status === ACTIVE && content) passes; clearing the content disables the
    // custom message. For the other messages this mirrors the current status.
    const contentStatus = isErrorMessage
        ? PullRequestMessageStatus.ACTIVE
        : props.value.status.value;
    const parentMessages = useSuspenseParentPullRequestMessages();
    const inheritedContentTarget = hasParent
        ? props.type === "startReviewMessage"
            ? parentMessages.startReviewMessage.content.value
            : props.type === "endReviewMessage"
              ? parentMessages.endReviewMessage.content.value
              : parentMessages.errorReviewMessage.content.value
        : undefined;

    const defaultContentTarget =
        props.type === "startReviewMessage"
            ? (defaults?.startReviewMessage?.content ?? "")
            : props.type === "endReviewMessage"
              ? (defaults?.endReviewMessage?.content ?? "")
              : (defaults?.errorReviewMessage?.content ?? "");

    const currentContent = props.value.content.value ?? "";

    const handleStatusRevert = () => {
        props.onChangeAction({
            content: props.value.content.value,
            status: props.initialState.status.value,
        });
    };

    const handleContentRevert = () => {
        props.onChangeAction({
            content: props.initialState.content.value,
            status: contentStatus,
        });
    };

    return (
        <div className="flex flex-1 flex-col gap-4">
            {isErrorMessage && (
                <p className="text-text-tertiary text-sm">
                    This message is appended below Kody's default error comment
                    when a review fails. Leave it empty to post only the default
                    comment.
                </p>
            )}

            {!isErrorMessage && (
            <Card color="lv3">
                <CardHeader className="flex flex-col gap-4 p-4">
                    <div className="flex items-center justify-between gap-6">
                        <div className="flex-1">
                            <Heading variant="h3">Message settings</Heading>
                            <OverrideIndicator
                                currentValue={props.value.status.value}
                                initialState={props.initialState.status}
                                handleRevert={handleStatusRevert}
                            />
                        </div>
                    </div>

                    <div className="flex flex-col gap-2">
                        <Label>Message behavior</Label>
                        <Select
                            value={props.value.status.value}
                            onValueChange={(value: PullRequestMessageStatus) =>
                                props.onChangeAction({
                                    content: props.value.content.value,
                                    status: value,
                                })
                            }
                            disabled={!props.canEdit}>
                            <SelectTrigger>
                                <SelectValue>
                                    {getStatusLabel(props.value.status.value)}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    value={PullRequestMessageStatus.EVERY_PUSH}>
                                    {getStatusLabel(
                                        PullRequestMessageStatus.EVERY_PUSH,
                                    )}
                                </SelectItem>
                                <SelectItem
                                    value={
                                        PullRequestMessageStatus.ONLY_WHEN_OPENED
                                    }>
                                    {getStatusLabel(
                                        PullRequestMessageStatus.ONLY_WHEN_OPENED,
                                    )}
                                </SelectItem>
                                <SelectItem value={PullRequestMessageStatus.OFF}>
                                    {getStatusLabel(PullRequestMessageStatus.OFF)}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <p className="text-text-tertiary text-xs">
                            {props.value.status.value ===
                                PullRequestMessageStatus.EVERY_PUSH &&
                                "Kody will send a message every time code is pushed to the PR"}
                            {props.value.status.value ===
                                PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                                "Kody will send a message only when the PR is opened"}
                            {props.value.status.value ===
                                PullRequestMessageStatus.OFF &&
                                "Kody won't send any messages"}
                            {props.value.status.value ===
                                PullRequestMessageStatus.ACTIVE &&
                                "Will be migrated to 'every_push'"}
                            {props.value.status.value ===
                                PullRequestMessageStatus.INACTIVE &&
                                "Will be migrated to 'off'"}
                        </p>
                    </div>
                </CardHeader>
            </Card>
            )}

            <div className="mt-4 flex flex-1">
                <div className="flex flex-2 shrink-0 flex-col gap-2">
                    <div className="flex h-7 items-center gap-2">
                        <Label htmlFor="custom-message">Custom message</Label>

                        {!isErrorMessage && (
                            <CustomMessagesOptionsDropdown
                                value={props.value}
                                onChange={props.onChangeAction}
                                canEdit={props.canEdit}
                                messageType={props.type}
                            />
                        )}

                        <OverrideIndicator
                            currentValue={props.value.content.value}
                            initialState={props.initialState.content}
                            handleRevert={handleContentRevert}
                        />
                    </div>

                    <Card color="lv3" className="flex-1 rounded-r-none">
                        <CardHeader className="h-full p-0 *:h-full">
                            <Textarea
                                value={props.value.content.value}
                                id="custom-message"
                                placeholder="Write your custom message here..."
                                className="h-full resize-none rounded-none bg-transparent p-6"
                                disabled={
                                    !props.canEdit ||
                                    (!isErrorMessage &&
                                        (props.value.status.value ===
                                            PullRequestMessageStatus.OFF ||
                                            props.value.status.value ===
                                                PullRequestMessageStatus.INACTIVE))
                                }
                                onChange={(ev) =>
                                    props.onChangeAction({
                                        content: ev.target.value,
                                        status: contentStatus,
                                    })
                                }
                            />
                        </CardHeader>
                    </Card>
                </div>

                <div className="flex flex-3 shrink-0 flex-col gap-2">
                    <div className="flex h-7 items-center justify-between">
                        <Label>Preview</Label>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="xs"
                                    variant="cancel"
                                    rightIcon={
                                        <ChevronDownIcon className="-mr-1" />
                                    }
                                    className="text-tertiary-light min-h-auto self-end"
                                    disabled={!props.canEdit}>
                                    Reset to…
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                {hasParent && (
                                    <DropdownMenuItem
                                        disabled={
                                            !props.canEdit ||
                                            inheritedContentTarget ===
                                                undefined ||
                                            currentContent.trim() ===
                                                (
                                                    inheritedContentTarget || ""
                                                ).trim()
                                        }
                                        onClick={() => {
                                            if (
                                                inheritedContentTarget ===
                                                undefined
                                            )
                                                return;
                                            props.onChangeAction({
                                                status: contentStatus,
                                                content: inheritedContentTarget,
                                            });
                                        }}>
                                        <div>
                                            Inherited message
                                            <p className="text-text-tertiary text-xs">
                                                Restore content from parent
                                                scope
                                            </p>
                                        </div>
                                    </DropdownMenuItem>
                                )}
                                {isGlobalScope && (
                                    <DropdownMenuItem
                                        disabled={
                                            !props.canEdit ||
                                            currentContent.trim() ===
                                                (
                                                    defaultContentTarget || ""
                                                ).trim()
                                        }
                                        onClick={() => {
                                            props.onChangeAction({
                                                status: contentStatus,
                                                content: defaultContentTarget,
                                            });
                                        }}>
                                        <div>
                                            Default message
                                            <p className="text-text-tertiary text-xs">
                                                Restore platform default content
                                            </p>
                                        </div>
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>

                    <Card className="flex-1 rounded-l-none">
                        <CardHeader className="h-full overflow-auto">
                            {isErrorMessage ? (
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-2">
                                        <span className="text-text-tertiary text-[11px] font-medium tracking-wide uppercase">
                                            Kody's default error comment
                                        </span>
                                        <Card color="lv2" className="p-4">
                                            <MessagePreview
                                                content={
                                                    DEFAULT_ERROR_COMMENT_SAMPLE
                                                }
                                            />
                                        </Card>
                                    </div>

                                    <div className="text-text-tertiary flex items-center gap-3 text-[11px] font-medium tracking-wide uppercase">
                                        <span className="bg-card-lv3 h-px flex-1" />
                                        Your custom message
                                        <span className="bg-card-lv3 h-px flex-1" />
                                    </div>

                                    {currentContent.trim().length > 0 ? (
                                        <Card color="lv2" className="p-4">
                                            <MessagePreview
                                                content={preserveLineBreaks(
                                                    props.value.content.value,
                                                )}
                                            />
                                        </Card>
                                    ) : (
                                        <p className="text-text-secondary text-sm italic">
                                            Write a message on the left — it will
                                            be appended right here, below the
                                            default comment.
                                        </p>
                                    )}

                                    <div className="text-text-tertiary flex items-center gap-3 text-[11px] font-medium tracking-wide uppercase">
                                        <span className="bg-card-lv3 h-px flex-1" />
                                        Always appended (not editable)
                                        <span className="bg-card-lv3 h-px flex-1" />
                                    </div>

                                    <Card color="lv2" className="p-4 opacity-70">
                                        <MessagePreview
                                            content={KODY_GUIDE_FOOTER_SAMPLE}
                                        />
                                    </Card>
                                </div>
                            ) : (
                                <>
                                    <MessagePreview
                                        content={props.value.content.value}
                                    />

                                    <div className="flex h-full items-center justify-center">
                                        {props.value.content.value.trim()
                                            .length === 0 && (
                                            <p className="text-text-secondary text-sm">
                                                No content to preview
                                            </p>
                                        )}
                                    </div>
                                </>
                            )}
                        </CardHeader>
                    </Card>
                </div>
            </div>
        </div>
    );
};
