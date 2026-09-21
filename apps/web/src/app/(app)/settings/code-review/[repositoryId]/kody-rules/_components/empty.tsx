"use client";

/* Hallmark · component: empty state (Kody Rules / Memories) · genre: modern-minimal · theme: Kodus system tokens (card-lv*, text-*, primary-light)
 * redesign: floating icon-tile + text block → one bordered panel, two columns: what it is + actions | real content (library rules, or labelled examples)
 * states: row default · hover · focus-visible · active · loading (skeleton rows) · error (library panel drops out, actions stay) · disabled (no edit permission)
 * contrast: pass (40–41) · tokens: pass (48) · honest: pass (46 — real library count; memory samples labelled as examples) · responsive: stacks < md
 * pre-emit critique: P4 H5 E4 S4 R5 V4
 */
import { Suspense, useId } from "react";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { Skeleton } from "@components/ui/skeleton";
import { useSuspenseFindLibraryKodyRules } from "@services/kodyRules/hooks";
import { resolveKodyRuleDisplaySeverity } from "@services/kodyRules/types";
import { ArrowRightIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { ErrorBoundary } from "react-error-boundary";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { useCodeReviewRouteParams } from "../../../../_hooks";

const ROW =
    "text-text-primary hover:bg-card-lv2 active:bg-card-lv3 focus-visible:ring-ring flex w-full items-center gap-4 px-4 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset";

// Illustrations of the format, not anyone's data — the panel labels them so.
const MEMORY_EXAMPLES = [
    "We deploy with Argo CD; the Helm charts live in /deploy.",
    "tenant_id is a UUID everywhere — never an integer.",
    "The /v1 API is frozen: only security fixes land there.",
];

const COPY = {
    rule: {
        title: "No review rules yet",
        description:
            "Rules are checks Kody runs on every pull request: your conventions, your security bar, the comments reviewers keep repeating.",
        action: "Write a rule",
    },
    memory: {
        title: "No memories yet",
        description:
            "Memories are context Kody carries into every review and conversation: how your system works and what your team has already decided.",
        action: "Add a memory",
    },
} as const;

const LibraryRules = ({ libraryHref }: { libraryHref: string }) => {
    const rules = useSuspenseFindLibraryKodyRules();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();

    return (
        <>
            <ul className="divide-card-lv3/60 divide-y">
                {rules.slice(0, 3).map((rule) => {
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
                                className={ROW}>
                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="truncate text-sm font-semibold">
                                        {rule.title}
                                    </span>
                                    <span className="text-text-secondary line-clamp-1 text-[13px]">
                                        {rule.rule}
                                    </span>
                                </span>
                                {severity && (
                                    <IssueSeverityLevelBadge
                                        severity={severity}
                                    />
                                )}
                                <ChevronRightIcon
                                    aria-hidden
                                    className="text-text-tertiary size-4 shrink-0"
                                />
                            </Link>
                        </li>
                    );
                })}
            </ul>
            <div className="border-card-lv3/60 border-t px-4 py-3">
                <Link
                    href={libraryHref}
                    noHoverUnderline
                    className="text-text-secondary hover:text-text-primary focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2">
                    Browse all {rules.length} rules in the library
                    <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
            </div>
        </>
    );
};

const LibraryRulesSkeleton = () => (
    <ul className="divide-card-lv3/60 divide-y" aria-hidden>
        {[0, 1, 2].map((index) => (
            <li key={index} className="flex flex-col gap-1.5 px-4 py-3.5">
                <Skeleton className="h-4 w-56 max-w-full" />
                <Skeleton className="h-3.5 w-full max-w-md" />
            </li>
        ))}
    </ul>
);

type KodyRulesEmptyStateProps = {
    canEdit: boolean;
    entityLabel?: "rule" | "memory";
    showDiscovery?: boolean;
    onAddNewRule: () => void;
};

export const KodyRulesEmptyState = ({
    canEdit,
    entityLabel = "rule",
    showDiscovery = true,
    onAddNewRule,
}: KodyRulesEmptyStateProps) => {
    const { repositoryId } = useCodeReviewRouteParams();
    const asideHeadingId = useId();
    const copy = COPY[entityLabel];
    const showLibrary = entityLabel === "rule" && showDiscovery;
    // Carries the scope so the library's breadcrumb can send the reader back
    // to THEIR rules page rather than always to global.
    const libraryHref = `/library/kody-rules/featured?from=${encodeURIComponent(repositoryId)}`;

    return (
        // One deliberate object instead of a text block floating in the page:
        // what this is and what to do on the left, something real on the
        // right — rules to start from, or what a memory reads like.
        <div className="border-card-lv3/60 bg-card-lv1 grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-2xl border md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <div className="flex flex-col justify-center gap-6 p-6 md:p-10">
                <div className="flex flex-col gap-2">
                    <Heading variant="h2" className="[overflow-wrap:anywhere]">
                        {copy.title}
                    </Heading>
                    <p className="text-text-secondary max-w-md text-sm leading-relaxed">
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
                    {showLibrary && (
                        <Link href={libraryHref} noHoverUnderline>
                            <Button decorative size="md" variant="helper">
                                Browse the library
                            </Button>
                        </Link>
                    )}
                </div>
            </div>

            <section
                aria-labelledby={asideHeadingId}
                className="border-card-lv3/60 bg-background/40 flex flex-col border-t md:border-t-0 md:border-l">
                <h3
                    id={asideHeadingId}
                    className="text-text-secondary px-4 pt-5 pb-2 text-sm font-semibold">
                    {showLibrary
                        ? "Start from the library"
                        : "What a memory reads like"}
                </h3>

                {showLibrary ? (
                    // A failed library fetch drops the list, not the page:
                    // the actions on the left still work.
                    <ErrorBoundary
                        fallback={
                            <p className="text-text-tertiary px-4 pb-5 text-sm">
                                The library couldn&apos;t load right now.
                            </p>
                        }>
                        <Suspense fallback={<LibraryRulesSkeleton />}>
                            <LibraryRules libraryHref={libraryHref} />
                        </Suspense>
                    </ErrorBoundary>
                ) : (
                    <>
                        <ul className="divide-card-lv3/60 divide-y">
                            {MEMORY_EXAMPLES.map((memory) => (
                                <li
                                    key={memory}
                                    className="text-text-secondary px-4 py-3 text-sm">
                                    {memory}
                                </li>
                            ))}
                        </ul>
                        <p className="text-text-tertiary border-card-lv3/60 border-t px-4 py-3 text-xs">
                            Examples of the format — write your own.
                        </p>
                    </>
                )}
            </section>
        </div>
    );
};
