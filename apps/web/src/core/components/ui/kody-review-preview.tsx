"use client";

import * as React from "react";
import { GitPullRequest, MessageSquare } from "lucide-react";
import { cn } from "src/core/utils/components";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

type ReviewMode = "inline" | "pr-comment";

type Author = {
    name: string;
    avatar?: string;
    isBot?: boolean;
};

const KODY_AUTHOR: Author = {
    name: "kody-ci",
    avatar: "/assets/images/logo-nav.svg",
    isBot: true,
};

type KodyReviewPreviewProps = {
    mode: ReviewMode;
    author?: Author;
    comment?: string;
    className?: string;
    codeLine?: {
        number: number;
        content: string;
    };
};

function InlineReviewPreview({
    author,
    comment,
    codeLine,
}: {
    author: Author;
    comment: string;
    codeLine?: { number: number; content: string };
}) {
    return (
        <div className="border-card-lv3 flex flex-col overflow-hidden rounded-lg border text-xs">
            {codeLine && (
                <div className="bg-card-lv1 border-card-lv3 flex items-center border-b">
                    <span className="text-text-placeholder border-card-lv3 border-r px-3 py-1.5 font-mono select-none">
                        {codeLine.number}
                    </span>
                    <code className="text-text-secondary truncate px-3 py-1.5 font-mono">
                        {codeLine.content}
                    </code>
                </div>
            )}
            <div className="bg-card-lv2 flex gap-2.5 p-3">
                <Avatar className="size-6 shrink-0">
                    {author.avatar && (
                        <AvatarImage src={author.avatar} alt={author.name} />
                    )}
                    <AvatarFallback className="text-[10px] font-medium">
                        {author.name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                        <span className="text-text-primary font-medium">
                            {author.name}
                        </span>
                        {author.isBot && (
                            <span className="bg-card-lv3 text-text-secondary rounded px-1.5 py-0.5 text-[10px]">
                                bot
                            </span>
                        )}
                    </div>
                    <p className="text-text-secondary leading-relaxed">
                        {comment}
                    </p>
                </div>
            </div>
        </div>
    );
}

function PRCommentPreview({
    author,
    comment,
}: {
    author: Author;
    comment: string;
}) {
    return (
        <div className="border-card-lv3 flex flex-col overflow-hidden rounded-lg border text-xs">
            <div className="bg-card-lv1 border-card-lv3 flex items-center gap-2 border-b px-3 py-2">
                <GitPullRequest className="text-text-secondary size-3.5" />
                <span className="text-text-secondary">PR Comment</span>
            </div>
            <div className="bg-card-lv2 flex gap-2.5 p-3">
                <Avatar className="size-6 shrink-0">
                    {author.avatar && (
                        <AvatarImage src={author.avatar} alt={author.name} />
                    )}
                    <AvatarFallback className="text-[10px] font-medium">
                        {author.name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                        <span className="text-text-primary font-medium">
                            {author.name}
                        </span>
                        {author.isBot && (
                            <span className="bg-card-lv3 text-text-secondary rounded px-1.5 py-0.5 text-[10px]">
                                bot
                            </span>
                        )}
                    </div>
                    <p className="text-text-secondary leading-relaxed">
                        {comment}
                    </p>
                </div>
            </div>
        </div>
    );
}

export function KodyReviewPreview({
    mode,
    author = KODY_AUTHOR,
    comment = "This looks good! Consider adding error handling here.",
    className,
    codeLine = { number: 42, content: "const result = await fetchData();" },
}: KodyReviewPreviewProps) {
    return (
        <div className={cn("w-full", className)}>
            {mode === "inline" ? (
                <InlineReviewPreview
                    author={author}
                    comment={comment}
                    codeLine={codeLine}
                />
            ) : (
                <PRCommentPreview author={author} comment={comment} />
            )}
        </div>
    );
}

export function KodyReviewPreviewComparison({
    className,
    inlineComment = "Consider using optional chaining here.",
    prComment = "Overall the PR looks good. Here's a summary of the review...",
}: {
    className?: string;
    inlineComment?: string;
    prComment?: string;
}) {
    return (
        <div className={cn("flex flex-col gap-4", className)}>
            <div className="flex flex-col gap-2">
                <div className="text-text-secondary flex items-center gap-2 text-xs">
                    <MessageSquare className="size-3.5" />
                    <span>Inline comments (Per file)</span>
                </div>
                <KodyReviewPreview mode="inline" comment={inlineComment} />
            </div>
            <div className="flex flex-col gap-2">
                <div className="text-text-secondary flex items-center gap-2 text-xs">
                    <GitPullRequest className="size-3.5" />
                    <span>Single comment (Per PR)</span>
                </div>
                <KodyReviewPreview mode="pr-comment" comment={prComment} />
            </div>
        </div>
    );
}

export { KODY_AUTHOR };
export type { Author, ReviewMode };
