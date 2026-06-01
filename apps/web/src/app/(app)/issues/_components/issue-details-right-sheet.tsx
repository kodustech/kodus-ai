"use client";

import { Fragment, useEffect, useMemo } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { ButtonWithFeedback } from "@components/ui/button-with-feedback";
import { Card, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Keycap } from "@components/ui/keycap";
import { Link } from "@components/ui/link";
import { Markdown } from "@components/ui/markdown";
import { Progress } from "@components/ui/progress";
import { ScrollArea } from "@components/ui/scroll-area";
import { Separator } from "@components/ui/separator";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { usePrevious } from "@hooks/use-previous";
import { useShortcut } from "@hooks/use-shortcut";
import { useIssue } from "@services/issues/hooks";
import type { IssueListItem } from "@services/issues/types";
import { useQueryClient } from "@tanstack/react-query";
import {
    ArrowDownIcon,
    ArrowRightToLineIcon,
    ArrowUpIcon,
    FileIcon,
    FolderGit2Icon,
    GitPullRequestArrowIcon,
    RefreshCwIcon,
    Share2Icon,
    ThumbsDownIcon,
    ThumbsUpIcon,
} from "lucide-react";
import { useQueryState } from "nuqs";
import { ClipboardHelpers } from "src/core/utils/clipboard";
import { cn } from "src/core/utils/components";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { generateQueryKey } from "src/core/utils/reactQuery";

import { SeverityLevelSelect } from "./severity-level-select";
import { StatusSelect } from "./status-select";
import { useFineTuningEnabled } from "@services/fineTuning/hooks";

export const IssueDetailsRightSheet = ({
    issues,
}: {
    issues: IssueListItem[];
}) => {
    const queryClient = useQueryClient();
    const [peek, setPeek] = useQueryState("peek");
    const previousPeek = usePrevious(peek);

    const query = useIssue(peek);
    const issue = query.data;
    const { enabled: fineTuningEnabled } = useFineTuningEnabled(issue?.repository?.id);

    const currentIssueIndex = useMemo(
        () => issues.findIndex((i) => i.uuid === peek),
        [issues, peek],
    );

    const previousIssueId = useMemo<string | undefined>(
        () => issues[currentIssueIndex - 1]?.uuid,
        [currentIssueIndex],
    );

    const nextIssueId = useMemo<string | undefined>(
        () => issues[currentIssueIndex + 1]?.uuid,
        [currentIssueIndex],
    );

    useEffect(() => {
        if (!previousPeek || previousPeek === peek) return;

        queryClient.cancelQueries({
            queryKey: generateQueryKey(apiProxyPath(`/issues/${previousPeek}`)),
        });
    }, [peek]);

    useShortcut(
        "escape",
        () => {
            setPeek(null);
        },
        { enabled: !!peek },
    );

    useShortcut(
        "k",
        () => {
            setPeek(previousIssueId!);
        },
        { enabled: !!peek && !!previousIssueId },
    );

    useShortcut(
        "j",
        () => {
            setPeek(nextIssueId!);
        },
        { enabled: !!peek && !!nextIssueId },
    );

    if (!peek || !issue) return null;

    return (
        <Sheet modal={false} open>
            <SheetContent className="sm:max-w-2xl">
                <SheetHeader className="mb-6 flex flex-row justify-between px-6">
                    <div className="flex items-center gap-1">
                        <div className="flex items-center">
                            <Button
                                size="sm"
                                variant="cancel"
                                className="p-0"
                                onClick={() => setPeek(null)}>
                                <ArrowRightToLineIcon />
                                <Keycap>Esc</Keycap>
                            </Button>
                        </div>

                        <Separator orientation="vertical" className="mx-2" />

                        <Tooltip delayDuration={500}>
                            <TooltipTrigger asChild>
                                <Button
                                    size="icon-sm"
                                    variant="helper"
                                    disabled={!nextIssueId}
                                    onClick={() => setPeek(nextIssueId!)}>
                                    <ArrowDownIcon />
                                </Button>
                            </TooltipTrigger>

                            <TooltipContent>
                                Press <Keycap>J</Keycap> to next issue
                            </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    size="icon-sm"
                                    variant="helper"
                                    disabled={!previousIssueId}
                                    onClick={() => setPeek(previousIssueId!)}>
                                    <ArrowUpIcon />
                                </Button>
                            </TooltipTrigger>

                            <TooltipContent>
                                Press <Keycap>K</Keycap> to previous issue
                            </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="cancel"
                                    size="icon-sm"
                                    loading={query.isFetching}
                                    onClick={() => query.refetch()}>
                                    <RefreshCwIcon />
                                </Button>
                            </TooltipTrigger>

                            <TooltipContent>Refresh</TooltipContent>
                        </Tooltip>
                    </div>

                    <div className="flex items-center gap-3">
                        <ButtonWithFeedback
                            size="xs"
                            variant="helper"
                            data-disabled={undefined}
                            className="min-w-21 py-2"
                            onClick={() => {
                                ClipboardHelpers.copyTextToClipboard(
                                    window.location.toString(),
                                );
                            }}>
                            <ButtonWithFeedback.Feedback>
                                <span className="text-success font-semibold">
                                    Copied!
                                </span>
                            </ButtonWithFeedback.Feedback>

                            <ButtonWithFeedback.Content>
                                <Share2Icon /> Share
                            </ButtonWithFeedback.Content>
                        </ButtonWithFeedback>

                        <StatusSelect
                            issueId={peek}
                            status={issue.status}
                            repoId={issue.repository.id}
                        />
                    </div>
                </SheetHeader>

                <SheetHeader>
                    <SheetTitle>
                        <Markdown className="font-bold">{issue.title}</Markdown>
                    </SheetTitle>

                    <SheetDescription>Opened {issue.age}</SheetDescription>

                    <div className="mt-4 flex gap-2">
                        <SeverityLevelSelect
                            issueId={peek}
                            severity={issue.severity}
                            repoId={issue.repository.id}
                        />
                    </div>
                </SheetHeader>

                <Separator className="mt-4" />

                <ScrollArea className="flex-1 *:py-6">
                    <div className="list-outside space-y-4 px-6 text-sm *:break-all">
                        <div className="flex gap-3">
                            <FolderGit2Icon className="text-secondary-light size-4.5" />

                            <Link
                                target="_blank"
                                href={issue.repositoryLink.url}
                                className="text-text-secondary link-hover:text-primary-light link-focused:text-primary-light underline">
                                {issue.gitOrganizationName}/
                                {issue.repositoryLink.label}
                            </Link>
                        </div>
                        <div className="flex gap-3">
                            <GitPullRequestArrowIcon className="text-secondary-light size-4.5" />

                            <div>
                                {issue.prLinks.map((c, i) => (
                                    <Fragment key={c.url}>
                                        {i > 0 ? ", " : ""}
                                        <Link
                                            href={c.url}
                                            target="_blank"
                                            className="text-text-secondary link-hover:text-primary-light link-focused:text-primary-light underline">
                                            #{c.label}
                                        </Link>
                                    </Fragment>
                                ))}
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <FileIcon className="text-secondary-light size-4.5" />

                            <Link
                                href={issue.fileLink.url}
                                target="_blank"
                                className="text-text-secondary link-hover:text-primary-light link-focused:text-primary-light underline">
                                {issue.fileLink.label}
                            </Link>
                        </div>
                    </div>

                    <div className="mt-10 px-6">
                        <Heading variant="h3" className="mb-2">
                            Description
                        </Heading>

                        <div className="mb-10 flex flex-col gap-4">
                            {issue.description
                                // break after `. ` that is not inside double quotes
                                .split(new RegExp(/(?![^"]*"\B)[.]\s/g))
                                .map((p, i) => (
                                    <Markdown
                                        key={i}
                                        className="text-text-secondary">
                                        {/* splitted string cut a `. ` in the end of each part */}
                                        {p.endsWith("..") || !p.endsWith(".")
                                            ? `${p}.`
                                            : p}
                                    </Markdown>
                                ))}
                        </div>
                    </div>
                </ScrollArea>

                <Separator />

                <SheetFooter className="mt-4">
                    {fineTuningEnabled && (
                        <Card className="text-sm" color="lv1">
                            <CardHeader className="flex flex-row items-center justify-between gap-6 py-4">
                                <p>Team feedback from PR reactions</p>

                                <div className="flex items-center gap-1">
                                    <Badge
                                        size="xs"
                                        variant="helper"
                                        className="pointer-events-none min-w-16"
                                        leftIcon={
                                            <ThumbsUpIcon className="text-success mr-1" />
                                        }>
                                        {issue.reactions.thumbsUp}
                                    </Badge>

                                    <Badge
                                        size="xs"
                                        variant="helper"
                                        className="pointer-events-none min-w-16"
                                        leftIcon={
                                            <ThumbsDownIcon className="text-danger mr-1" />
                                        }>
                                        {issue.reactions.thumbsDown}
                                    </Badge>
                                </div>
                            </CardHeader>

                            <Progress
                                data-value={issue.reactions.thumbsUp}
                                data-max={
                                    issue.reactions.thumbsUp +
                                    issue.reactions.thumbsDown
                                }
                                className={cn(
                                    "h-1",
                                    "[--progress-background:var(--color-danger)]",
                                    "[--progress-foreground:var(--color-success)]",

                                    !issue.reactions.thumbsUp &&
                                        !issue.reactions.thumbsDown &&
                                        "[--progress-background:var(--color-card-lv3)]",
                                )}
                            />
                        </Card>
                    )}
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
};
