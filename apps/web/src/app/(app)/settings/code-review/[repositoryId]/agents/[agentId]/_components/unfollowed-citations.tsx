"use client";

import { useMemo } from "react";
import { Button } from "@components/ui/button";
import {
    citationCandidates,
    isLinked,
    knowledgeKey,
    repositoryKey,
    sameKnowledge,
} from "@services/custom-agents/drafts";
import { useResolveCustomAgent } from "@services/custom-agents/hooks";
import type {
    CustomAgentUnfollowedCitation,
    KnowledgeItem,
} from "@services/custom-agents/types";
import { BookOpenIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { KnowledgeSourceChip } from "./knowledge-card";

type Offer = {
    item: Pick<KnowledgeItem, "path" | "kind" | "repository" | "ref">;
    findings: number;
    pullRequests: number;
    /** The file also feeds Kody Rules: following it can comment twice. */
    kodyRuleSource: boolean;
};

/**
 * Files the agent's dropped findings quoted as their rule, while the agent
 * does not follow them: each one it can follow, checked to exist first, with
 * how many findings it would have kept. Nothing shows when none resolves.
 */
export const UnfollowedCitations = ({
    agentId,
    citations,
    knowledge,
    repositories,
    canEdit,
    teamId,
    repositoryId,
    onFollow,
}: {
    agentId: string;
    citations: CustomAgentUnfollowedCitation[];
    knowledge: KnowledgeItem[];
    /** Where skills and docs come from besides this repository: the linked
     *  repositories and any already in use. */
    repositories: string[];
    canEdit: boolean;
    teamId?: string;
    repositoryId?: string;
    onFollow: (item: Offer["item"]) => void;
}) => {
    const candidates = useMemo(
        () =>
            citations.map((citation) => ({
                citation,
                options: citationCandidates(citation.file, repositories),
            })),
        [citations, repositories],
    );
    const toCheck = useMemo(() => {
        // One branch or tag per repository: a candidate reads at the one in
        // use.
        const refOf = (repository?: string) =>
            repository
                ? knowledge.find(
                      (item) =>
                          repositoryKey(item) === repository.toLowerCase() &&
                          item.ref,
                  )?.ref
                : undefined;
        const unique = new Map<string, KnowledgeItem>();
        for (const { options } of candidates) {
            for (const option of options) {
                const ref = refOf(option.repository);
                unique.set(knowledgeKey(option), {
                    ...option,
                    ...(ref && { ref }),
                    linkedTo: [{ agentId }],
                });
            }
        }
        return [...unique.values()];
    }, [candidates, agentId, knowledge]);
    const check = useResolveCustomAgent({
        teamId,
        repositoryId,
        knowledge: toCheck,
        enabled: toCheck.length > 0 && !!repositoryId,
    });
    const report =
        check.data?.knowledge.status === "ok" ? check.data.knowledge : null;

    const offers: Offer[] = [];
    for (const { citation, options } of candidates) {
        const found = options
            .map((option) =>
                report?.items.find(
                    (entry) => entry.found && sameKnowledge(entry, option),
                ),
            )
            .find(Boolean);
        if (!found) continue;
        const item = toCheck.find((entry) => sameKnowledge(entry, found))!;
        const followed = knowledge.some(
            (entry) =>
                sameKnowledge(entry, item) && isLinked(entry, { agentId }),
        );
        if (followed) continue;
        // `repo/x.md` and `x.md` can both name the same file: one offer.
        const same = offers.find((offer) => sameKnowledge(offer.item, item));
        if (same) {
            same.findings += citation.findings;
            same.pullRequests = Math.max(
                same.pullRequests,
                citation.pullRequests,
            );
            continue;
        }
        offers.push({
            item: {
                path: item.path,
                kind: item.kind,
                ...(item.repository && { repository: item.repository }),
                ...(item.ref && { ref: item.ref }),
            },
            findings: citation.findings,
            pullRequests: citation.pullRequests,
            kodyRuleSource: found.kodyRuleSource === true,
        });
    }
    if (!offers.length) return null;
    offers.sort((a, b) => b.findings - a.findings);

    return (
        <section
            aria-label="Cited by dropped findings"
            className="border-card-lv3 bg-card-lv2/40 flex flex-col gap-2 rounded-lg border p-3">
            <span className="flex flex-col gap-0.5">
                <span className="text-text-primary text-xs font-medium">
                    Cited by dropped findings
                </span>
                <span className="text-text-secondary text-xs">
                    Recent reviews dropped findings that quoted these files,
                    because this agent doesn&apos;t follow them. Follow one so
                    the findings that apply it are kept.
                </span>
            </span>
            <ul className="flex flex-col">
                {offers.map((offer) => {
                    const name =
                        offer.item.kind === "skill"
                            ? (offer.item.path.split("/").pop() ??
                              offer.item.path)
                            : offer.item.path;
                    return (
                        <li
                            key={knowledgeKey(offer.item)}
                            className="border-card-lv3/60 flex items-start gap-2 border-t py-2 first:border-t-0">
                            {offer.item.kind === "skill" ? (
                                <SparklesIcon
                                    aria-hidden
                                    className="text-text-tertiary mt-0.5 size-4 shrink-0"
                                />
                            ) : (
                                <BookOpenIcon
                                    aria-hidden
                                    className="text-text-tertiary mt-0.5 size-4 shrink-0"
                                />
                            )}
                            <span className="flex min-w-0 flex-1 flex-col gap-1">
                                <span
                                    className={cn(
                                        "text-text-primary truncate text-xs font-medium",
                                        offer.item.kind === "doc" &&
                                            "font-mono",
                                    )}>
                                    {name}
                                </span>
                                <span className="flex flex-wrap items-center gap-1.5">
                                    {offer.item.repository && (
                                        <KnowledgeSourceChip
                                            item={offer.item}
                                        />
                                    )}
                                    <span className="text-text-tertiary text-xs">
                                        {offer.findings}{" "}
                                        {offer.findings === 1
                                            ? "finding"
                                            : "findings"}{" "}
                                        dropped · {offer.pullRequests}{" "}
                                        {offer.pullRequests === 1
                                            ? "PR"
                                            : "PRs"}
                                    </span>
                                    {offer.kodyRuleSource && (
                                        <span className="text-warning text-xs">
                                            · Also a Kody Rules source
                                        </span>
                                    )}
                                </span>
                            </span>
                            {canEdit && (
                                <Button
                                    size="xs"
                                    variant="secondary"
                                    leftIcon={<PlusIcon />}
                                    className="shrink-0"
                                    aria-label={`Follow ${
                                        offer.item.repository
                                            ? `${offer.item.repository}:`
                                            : ""
                                    }${offer.item.path}`}
                                    onClick={() => onFollow(offer.item)}>
                                    Follow
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
};
