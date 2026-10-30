"use client";

import { useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import { useGetPastReviewers } from "@services/kodyRules/hooks";
import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { Check, ChevronsUpDown } from "lucide-react";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "src/core/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "src/core/components/ui/popover";
import { cn } from "src/core/utils/components";

/**
 * Denylist picker for issue #1497: choose git reviewers whose past review
 * comments Kody should NOT learn from. Empty = learn from everyone. Reviewers
 * are lazy-loaded (current members ∪ PR authors in the window) only when the
 * dropdown opens, since that involves a git call.
 */
export const ExcludedReviewersPicker = ({
    teamId,
    repositoryId,
    initialExcluded,
    canEdit,
}: {
    teamId: string;
    repositoryId?: string;
    initialExcluded: string[];
    canEdit: boolean;
}) => {
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<string[]>(initialExcluded);

    // "global" is the settings sentinel for team-wide config; the reviewers
    // endpoint wants a real repo id (or nothing → team-wide).
    const repoParam =
        repositoryId && repositoryId !== "global" ? repositoryId : undefined;

    const { data: reviewers, isLoading } = useGetPastReviewers(
        { teamId, repositoryId: repoParam },
        { enabled: open },
    );

    const options = useMemo(() => reviewers ?? [], [reviewers]);

    const [handleSave, { loading: isSaving }] = useAsyncAction(async () => {
        try {
            await createOrUpdateCodeReviewParameter(
                { kodyLearningExcludedReviewers: pending },
                teamId,
                repositoryId,
            );

            invalidateQueries({
                queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                    params: {
                        key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                        teamId,
                    },
                }),
            });
            invalidateQueries({
                queryKey: generateQueryKey(KODY_RULES_PATHS.CHECK_SYNC_STATUS, {
                    params: { teamId, repositoryId },
                }),
            });
            invalidateQueries({
                queryKey: generateQueryKey(
                    PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                    { params: { teamId } },
                ),
            });

            toast({ description: "Reviewers updated", variant: "success" });
            setOpen(false);
        } catch {
            toast({
                title: "Error",
                description:
                    "Couldn't update the reviewer list. Please try again.",
                variant: "danger",
            });
        }
    });

    const toggle = (id: string) => {
        if (!canEdit || isSaving) return;
        setPending((current) =>
            current.includes(id)
                ? current.filter((x) => x !== id)
                : [...current, id],
        );
    };

    const excludedCount = pending.length;
    const label =
        excludedCount > 0
            ? `Excluding ${excludedCount} reviewer${excludedCount === 1 ? "" : "s"}`
            : "Learning from all reviewers";

    return (
        <div className="mt-1 mb-2 ml-2 flex flex-col gap-1">
            <span className="text-text-secondary text-xs">
                Exclude specific developers so Kody doesn&apos;t learn rules
                from their review comments.
            </span>

            <Popover
                open={open}
                onOpenChange={(isOpen) => {
                    if (isOpen) setPending(initialExcluded);
                    setOpen(isOpen);
                }}>
                <PopoverTrigger asChild>
                    <Button
                        variant="helper"
                        size="md"
                        role="combobox"
                        aria-expanded={open}
                        className="w-full justify-between"
                        disabled={!canEdit}>
                        {label}
                        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    className="flex w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-0"
                    align="start">
                    <Command className="flex max-h-[400px] flex-col">
                        <CommandInput placeholder="Search reviewers..." />

                        <CommandList className="max-h-[250px] overflow-y-auto">
                            <CommandEmpty>
                                {isLoading
                                    ? "Loading reviewers…"
                                    : "No reviewer found."}
                            </CommandEmpty>
                            <CommandGroup>
                                {options.map((reviewer) => (
                                    <CommandItem
                                        key={reviewer.id}
                                        value={`${reviewer.id}:${reviewer.name}`}
                                        disabled={!canEdit || isSaving}
                                        onSelect={() => toggle(reviewer.id)}>
                                        {reviewer.name}
                                        <Check
                                            className={cn(
                                                "mr-2 size-4",
                                                pending.includes(reviewer.id)
                                                    ? "opacity-100"
                                                    : "opacity-0",
                                            )}
                                        />
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>

                    <div className="flex shrink-0 items-center gap-2 border-t p-2">
                        <Button
                            className="flex-1"
                            size="sm"
                            variant="cancel"
                            onClick={() => setOpen(false)}
                            disabled={isSaving}>
                            Cancel
                        </Button>
                        <Button
                            className="flex-1"
                            size="sm"
                            variant="primary"
                            onClick={handleSave}
                            loading={isSaving}
                            disabled={!canEdit}>
                            Apply
                        </Button>
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    );
};
