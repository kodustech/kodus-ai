"use client";

import { Suspense, useId } from "react";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { Skeleton } from "@components/ui/skeleton";
import { useSuspenseFindLibraryKodyRules } from "@services/kodyRules/hooks";
import { resolveKodyRuleDisplaySeverity } from "@services/kodyRules/types";
import {
    BookOpenCheckIcon,
    BookOpenIcon,
    ChevronRightIcon,
    NotebookPenIcon,
    PlusIcon,
} from "lucide-react";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { useCodeReviewRouteParams } from "../../../../_hooks";

const ROW_CLASS =
    "text-text-primary hover:bg-card-lv2 focus-visible:ring-ring flex w-full items-center gap-4 px-4 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset";

// Three library rules as a short list: enough to show what a rule looks like
// and one click from adding it, without turning the empty page into a
// catalogue — the library itself is one button away.
const SuggestedRules = () => {
    const rules = useSuspenseFindLibraryKodyRules();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();

    return rules.slice(0, 3).map((rule) => {
        const severity = rule.severity
            ? resolveKodyRuleDisplaySeverity(rule)
            : undefined;

        return (
            <li key={rule.uuid}>
                <Link
                    noHoverUnderline
                    href={addSearchParamsToUrl(
                        `/library/kody-rules/${rule.uuid}`,
                        { repositoryId, directoryId },
                    )}
                    className={ROW_CLASS}>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-semibold">
                                {rule.title}
                            </span>
                            {rule.plug_and_play && (
                                <span className="text-text-tertiary shrink-0 text-xs">
                                    Plug-and-play
                                </span>
                            )}
                        </span>
                        <span className="text-text-secondary line-clamp-1 text-[13px]">
                            {rule.rule}
                        </span>
                    </span>
                    {severity && (
                        <IssueSeverityLevelBadge severity={severity} />
                    )}
                    <ChevronRightIcon
                        aria-hidden
                        className="text-text-tertiary size-4 shrink-0"
                    />
                </Link>
            </li>
        );
    });
};

const SuggestedRulesSkeleton = () =>
    [0, 1, 2].map((index) => (
        <li key={index} className="flex flex-col gap-1.5 px-4 py-3.5">
            <Skeleton className="h-4 w-64 max-w-full" />
            <Skeleton className="h-3.5 w-full max-w-lg" />
        </li>
    ));

type KodyRulesEmptyStateProps = {
    canEdit: boolean;
    entityLabel?: "rule" | "memory";
    showDiscovery?: boolean;
    onAddNewRule: () => void;
};

const COPY = {
    rule: {
        icon: BookOpenCheckIcon,
        title: "No review rules yet",
        description:
            "Rules are checks Kody runs on every pull request — your conventions, your security bar, the things reviewers keep repeating.",
        action: "New rule",
    },
    memory: {
        icon: NotebookPenIcon,
        title: "No memories yet",
        description:
            "Memories are context Kody carries into every review and conversation — decisions and conventions your team wants it to remember.",
        action: "New memory",
    },
} as const;

export const KodyRulesEmptyState = ({
    canEdit,
    entityLabel = "rule",
    showDiscovery = true,
    onAddNewRule,
}: KodyRulesEmptyStateProps) => {
    const { repositoryId } = useCodeReviewRouteParams();
    const suggestionsHeadingId = useId();
    const copy = COPY[entityLabel];
    const Icon = copy.icon;
    // Carries the scope so the library's breadcrumb can send the reader back
    // to THEIR rules page rather than always to global.
    const libraryHref = `/library/kody-rules/featured?from=${encodeURIComponent(repositoryId)}`;

    return (
        <div className="flex flex-col gap-10 py-6">
            <div className="flex max-w-xl flex-col items-start gap-4">
                <span
                    aria-hidden
                    className="bg-card-lv2 text-text-secondary flex size-10 items-center justify-center rounded-xl">
                    <Icon className="size-5" />
                </span>
                <div className="flex flex-col gap-1.5">
                    <Heading variant="h2">{copy.title}</Heading>
                    <p className="text-text-secondary text-sm">
                        {copy.description}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<PlusIcon />}
                        disabled={!canEdit}
                        onClick={onAddNewRule}>
                        {copy.action}
                    </Button>
                    {showDiscovery && (
                        <Link href={libraryHref} noHoverUnderline>
                            <Button
                                decorative
                                size="md"
                                variant="helper"
                                leftIcon={<BookOpenIcon />}>
                                Browse the library
                            </Button>
                        </Link>
                    )}
                </div>
            </div>

            {showDiscovery && (
                <section
                    aria-labelledby={suggestionsHeadingId}
                    className="flex max-w-3xl flex-col gap-2">
                    <h3
                        id={suggestionsHeadingId}
                        className="text-text-secondary text-sm font-semibold">
                        Start from the library
                    </h3>
                    <ul className="border-card-lv3/60 divide-card-lv3/60 divide-y overflow-hidden rounded-xl border">
                        <Suspense fallback={<SuggestedRulesSkeleton />}>
                            <SuggestedRules />
                        </Suspense>
                    </ul>
                </section>
            )}
        </div>
    );
};
