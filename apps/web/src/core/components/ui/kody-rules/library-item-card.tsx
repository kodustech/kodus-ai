"use client";

import { useEffect, useState } from "react";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Badge } from "@components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import {
    resolveKodyRuleDisplaySeverity,
    type LibraryRule,
} from "@services/kodyRules/types";
import {
    removeRuleFeedback,
    sendRuleFeedback,
    type FeedbackType,
} from "@services/ruleFeedback/fetch";
import { useMutation } from "@tanstack/react-query";
import { PlugIcon, ThumbsDown, ThumbsUp } from "lucide-react";
import { SuggestionsModal } from "src/app/(app)/library/kody-rules/_components/suggestions-modal";
import { ProgrammingLanguage } from "src/core/enums/programming-language";
import { useAuth } from "src/core/providers/auth.provider";
import { cn } from "src/core/utils/components";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { Button } from "../button";
import { Link } from "../link";
import { Separator } from "../separator";
import { Spinner } from "../spinner";

export const KodyRuleLibraryItem = ({
    rule,
    repositoryId,
    directoryId,
    showLikeButton,
    showSuggestionsButton = false,
}: {
    rule: LibraryRule;
    repositoryId?: string;
    directoryId?: string;
    showLikeButton?: boolean;
    showSuggestionsButton?: boolean;
}) => {
    const { userId } = useAuth();
    const [positiveCount, setPositiveCount] = useState(rule.positiveCount ?? 0);
    const [negativeCount, setNegativeCount] = useState(rule.negativeCount ?? 0);
    const [userFeedback, setUserFeedback] = useState<FeedbackType | null>(
        rule.userFeedback as FeedbackType | null,
    );

    useEffect(() => {
        setPositiveCount(rule.positiveCount ?? 0);
        setNegativeCount(rule.negativeCount ?? 0);
        setUserFeedback(rule.userFeedback as FeedbackType | null);
    }, [rule.positiveCount, rule.negativeCount, rule.userFeedback]);

    const { mutate: sendFeedback, isPending: isFeedbackActionInProgress } =
        useMutation<any, Error, FeedbackType>({
            mutationFn: async (feedback: FeedbackType) => {
                const isRemovingFeedback = userFeedback === feedback;

                if (isRemovingFeedback) {
                    return removeRuleFeedback(rule.uuid);
                } else {
                    return sendRuleFeedback(rule.uuid, feedback);
                }
            },
            onSuccess: (data, feedback) => {
                const isRemovingFeedback = userFeedback === feedback;
                const newFeedback = isRemovingFeedback ? null : feedback;

                if (feedback === "positive") {
                    if (isRemovingFeedback) {
                        setPositiveCount((prev) => prev - 1);
                    } else {
                        setPositiveCount((prev) => prev + 1);
                        if (userFeedback === "negative") {
                            setNegativeCount((prev) => prev - 1);
                        }
                    }
                } else {
                    if (isRemovingFeedback) {
                        setNegativeCount((prev) => prev - 1);
                    } else {
                        setNegativeCount((prev) => prev + 1);
                        if (userFeedback === "positive") {
                            setPositiveCount((prev) => prev - 1);
                        }
                    }
                }

                setUserFeedback(newFeedback);
            },
            onError: (error) => {
                console.error("Error sending feedback:", error);
            },
        });

    const href = addSearchParamsToUrl(`/library/kody-rules/${rule.uuid}`, {
        repositoryId,
        directoryId,
    });

    return (
        <Card
            key={rule.uuid}
            className="flex w-full cursor-default flex-col items-start overflow-visible bg-transparent">
            <Link className="w-full flex-1" href={href}>
                <Button
                    size="lg"
                    decorative
                    variant="helper"
                    className="h-full w-full flex-col gap-0 rounded-b-none px-0 py-0">
                    <CardHeader className="flex-row justify-between gap-4">
                        <Heading
                            variant="h3"
                            className="line-clamp-2 flex min-h-6 items-center font-semibold">
                            {rule.title}
                        </Heading>

                        {!!rule.severity && (
                            <IssueSeverityLevelBadge
                                severity={resolveKodyRuleDisplaySeverity(rule)}
                            />
                        )}
                    </CardHeader>

                    <CardContent className="flex flex-1 flex-col">
                        <p className="text-text-secondary line-clamp-3 text-[13px]">
                            {rule.rule}
                        </p>
                    </CardContent>
                </Button>
            </Link>

            <Separator className="opacity-70" />

            <CardFooter className="bg-card-lv2 flex w-full cursor-auto items-end justify-between gap-4 rounded-b-xl px-5 py-4">
                <div className="flex flex-wrap items-center gap-[3px]">
                    {rule.language && (
                        <Badge
                            className="pointer-events-none h-2 px-2.5 font-normal"
                            variant="secondary">
                            {ProgrammingLanguage[rule.language]}
                        </Badge>
                    )}
                    {rule.plug_and_play && (
                        <Badge
                            className="pointer-events-none h-2 px-2.5 font-normal"
                            variant="primary-dark">
                            <PlugIcon className="size-2" />
                            <span>Plug-and-Play</span>
                        </Badge>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {showSuggestionsButton && (
                        <SuggestionsModal
                            ruleId={rule.uuid}
                            ruleTitle={rule.title}
                        />
                    )}

                    {showLikeButton && (
                        <div className="flex items-center gap-1">
                            <Button
                                size="sm"
                                variant="cancel"
                                onClick={() => sendFeedback("positive")}
                                disabled={isFeedbackActionInProgress}
                                className={cn(
                                    "-my-2 gap-1 px-2 transition-colors",
                                    userFeedback === "positive" &&
                                        "border-green-500/20 bg-green-500/10 text-green-500",
                                )}
                                rightIcon={
                                    isFeedbackActionInProgress ? (
                                        <Spinner className="size-2.5" />
                                    ) : (
                                        <ThumbsUp className="size-3" />
                                    )
                                }>
                                {positiveCount > 0 ? positiveCount : null}
                            </Button>

                            <Button
                                size="sm"
                                variant="cancel"
                                onClick={() => sendFeedback("negative")}
                                disabled={isFeedbackActionInProgress}
                                className={cn(
                                    "-my-2 gap-1 px-2 transition-colors",
                                    userFeedback === "negative" &&
                                        "border-red-500/20 bg-red-500/10 text-red-500",
                                )}
                                rightIcon={
                                    isFeedbackActionInProgress ? (
                                        <Spinner className="size-2.5" />
                                    ) : (
                                        <ThumbsDown className="size-3" />
                                    )
                                }>
                                {negativeCount > 0 ? negativeCount : null}
                            </Button>
                        </div>
                    )}
                </div>
            </CardFooter>
        </Card>
    );
};
