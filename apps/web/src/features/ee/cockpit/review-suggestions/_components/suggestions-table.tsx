"use client";

// Suggestions explorer table — DataTable + side Sheet for the code diff.
import { useState } from "react";
import Link from "next/link";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Button } from "@components/ui/button";
import { DataTable } from "@components/ui/data-table";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { ExternalLink } from "lucide-react";

import type { SuggestionsExplorerItem } from "../../_services/analytics/review/explorer-fetch";
import { columns } from "./columns";

const statusLabel = (status: string | null) => {
    if (status === "implemented") return "✓ implemented";
    if (status === "partially_implemented") return "◐ partially implemented";
    return "○ not implemented";
};

/**
 * Deep link into the PR review screen, landing on this exact suggestion:
 * `?file=<path>&suggestion=<id>` makes the screen scroll to and highlight
 * the finding's card.
 */
const buildReviewDeepLink = (s: SuggestionsExplorerItem) => {
    const base = `/pull-requests/${s.repositoryId}/${s.prNumber}`;
    const params = new URLSearchParams();
    if (s.filePath) params.set("file", s.filePath);
    if (s.suggestionId) params.set("suggestion", s.suggestionId);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
};

export const SuggestionsTable = ({
    items,
}: {
    items: SuggestionsExplorerItem[];
}) => {
    const [selected, setSelected] = useState<SuggestionsExplorerItem | null>(
        null,
    );

    return (
        <>
            <div className="border-card-lv3 w-full overflow-x-auto rounded-lg border">
                <DataTable
                    columns={columns}
                    data={items}
                    getRowId={(row) => row.suggestionId}
                    EmptyComponent="No suggestions match these filters."
                    meta={{ peek: selected?.suggestionId }}
                    onRowClick={(row: SuggestionsExplorerItem) =>
                        setSelected(row)
                    }
                />
            </div>

            <Sheet
                open={!!selected}
                onOpenChange={(open) => !open && setSelected(null)}>
                <SheetContent className="flex w-[560px] flex-col gap-0 sm:max-w-[560px]">
                    {selected && (
                        <>
                            <SheetHeader>
                                <div className="mb-2 flex flex-wrap items-center gap-2">
                                    {selected.severity && (
                                        <IssueSeverityLevelBadge
                                            severity={selected.severity}
                                        />
                                    )}
                                    {selected.category && (
                                        <span className="bg-card-lv3 text-text-secondary rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
                                            {selected.category}
                                        </span>
                                    )}
                                    <span className="text-text-tertiary text-[11px] font-semibold">
                                        {statusLabel(
                                            selected.implementationStatus,
                                        )}
                                    </span>
                                </div>
                                <SheetTitle className="text-base leading-snug">
                                    {selected.summary ?? "(no summary)"}
                                </SheetTitle>
                                <SheetDescription className="font-mono text-[11px]">
                                    {selected.repository}
                                    {selected.filePath
                                        ? ` · ${selected.filePath}`
                                        : ""}
                                    {selected.prNumber
                                        ? ` · PR #${selected.prNumber}`
                                        : ""}
                                </SheetDescription>
                            </SheetHeader>

                            <div className="flex flex-1 flex-col gap-3 overflow-y-auto py-4">
                                {selected.existingCode && (
                                    <div className="border-card-lv3 overflow-hidden rounded-md border">
                                        <div className="bg-danger/10 text-danger px-3 py-1.5 text-[10px] font-bold uppercase">
                                            Existing code
                                        </div>
                                        <pre className="bg-card-lv1 text-text-secondary overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">
                                            {selected.existingCode}
                                        </pre>
                                    </div>
                                )}
                                {selected.improvedCode && (
                                    <div className="border-card-lv3 overflow-hidden rounded-md border">
                                        <div className="bg-success/10 text-success px-3 py-1.5 text-[10px] font-bold uppercase">
                                            Suggested code
                                        </div>
                                        <pre className="bg-card-lv1 text-text-secondary overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">
                                            {selected.improvedCode}
                                        </pre>
                                    </div>
                                )}
                                {!selected.existingCode &&
                                    !selected.improvedCode && (
                                        <p className="text-text-tertiary text-sm">
                                            No code diff available for this
                                            suggestion.
                                        </p>
                                    )}
                            </div>

                            {selected.repositoryId && selected.prNumber && (
                                <SheetFooter>
                                    <Button
                                        size="md"
                                        variant="primary"
                                        leftIcon={<ExternalLink />}
                                        asChild>
                                        <Link
                                            href={buildReviewDeepLink(
                                                selected,
                                            )}>
                                            Open in PR review
                                        </Link>
                                    </Button>
                                </SheetFooter>
                            )}
                        </>
                    )}
                </SheetContent>
            </Sheet>
        </>
    );
};
