"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useGetRepositories } from "@services/codeManagement/hooks";
import { useGetPastReviewers } from "@services/kodyRules/hooks";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import {
    GitPullRequestIcon,
    ClockFadingIcon,
    Check,
    ChevronsUpDown,
} from "lucide-react";
import { safeArray } from "src/core/utils/safe-array";
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
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";

import { StepIndicators } from "../_components/step-indicators";

const NEXT_STEP = "/setup/review-mode";

export default function SelectReviewersPage() {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();

    // Candidate reviewers across the team: current members ∪ authors of PRs in
    // the last 3 months, so recently-departed devs are still selectable.
    const { data: reviewers = [], isLoading } = useGetPastReviewers({ teamId });

    const { data: repositories = [] } = useGetRepositories(teamId);
    const selectedRepoIds = useMemo(
        () =>
            safeArray<{ id: string; selected?: boolean }>(repositories)
                .filter((repo) => repo.selected)
                .map((repo) => repo.id),
        [repositories],
    );

    const [excluded, setExcluded] = useState<string[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [open, setOpen] = useState(false);

    const toggle = (id: string) => {
        setExcluded((current) =>
            current.includes(id)
                ? current.filter((x) => x !== id)
                : [...current, id],
        );
    };

    const goNext = () => router.push(NEXT_STEP);

    const handleContinue = async () => {
        // Nothing to exclude, or no repos to apply it to → just move on. The
        // generator config lives per-repo (the toggle is repo-scoped), so we
        // write the exclusions to each onboarded repo rather than to a global
        // list that no per-repo screen would surface for editing.
        if (!teamId || excluded.length === 0 || selectedRepoIds.length === 0) {
            goNext();
            return;
        }
        try {
            setIsSaving(true);
            const results = await Promise.allSettled(
                selectedRepoIds.map((repositoryId) =>
                    createOrUpdateCodeReviewParameter(
                        { kodyLearningExcludedReviewers: excluded },
                        teamId,
                        repositoryId,
                    ),
                ),
            );
            if (results.some((r) => r.status === "rejected")) {
                toast({
                    variant: "warning",
                    description:
                        "Some repositories couldn't be updated. You can adjust the list later in Settings.",
                });
            }
            goNext();
        } catch (error) {
            console.error("Error saving excluded reviewers", error);
            toast({
                variant: "danger",
                description: "We couldn't save your selection. Please try again.",
            });
        } finally {
            setIsSaving(false);
        }
    };

    const excludedCount = excluded.length;

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-col gap-6 p-6 lg:flex-row lg:gap-6">
            <div className="bg-card-lv1 flex w-full flex-col justify-center gap-10 rounded-3xl p-8 lg:max-w-none lg:flex-10 lg:p-12">
                <div className="flex-1 space-y-6 overflow-hidden">
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <GitPullRequestIcon /> Kody learns from your past reviews
                    </h1>
                    <p className="text-text-secondary text-md">
                        Kody learns coding standards from your team&apos;s last 3
                        months of PR reviews, and keeps learning every week.
                        Exclude anyone whose review comments you&apos;d rather
                        Kody not learn from.
                    </p>
                    <Alert>
                        <ClockFadingIcon size={24} />
                        <AlertTitle>
                            <span className="text-text-secondary text-sm">
                                You can change this anytime in Settings, per
                                repository.
                            </span>
                        </AlertTitle>
                    </Alert>
                </div>
            </div>

            <div className="flex w-full flex-col gap-10 lg:flex-14 lg:p-10">
                <div className="flex flex-1 flex-col gap-8">
                    <StepIndicators.Auto />

                    <div className="flex flex-col gap-2">
                        <Heading variant="h2">
                            Whose reviews should Kody learn from?
                        </Heading>
                        <span className="text-text-secondary text-sm">
                            Everyone is included by default. Select developers to
                            exclude
                            {excludedCount > 0
                                ? ` — ${excludedCount} excluded`
                                : ""}
                            .
                        </span>
                    </div>

                    <Popover open={open} onOpenChange={setOpen}>
                        <PopoverTrigger asChild>
                            <Button
                                variant="helper"
                                size="md"
                                role="combobox"
                                aria-expanded={open}
                                className="w-full justify-between">
                                {excludedCount > 0
                                    ? `Excluding ${excludedCount} reviewer${excludedCount === 1 ? "" : "s"}`
                                    : "Learning from all reviewers"}
                                <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent
                            className="flex w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-0"
                            align="start">
                            <Command className="flex max-h-[400px] flex-col">
                                <CommandInput placeholder="Search developers..." />
                                <CommandList className="max-h-[250px] overflow-y-auto">
                                    <CommandEmpty>
                                        {isLoading
                                            ? "Loading developers…"
                                            : "No developers found."}
                                    </CommandEmpty>
                                    <CommandGroup>
                                        {reviewers.map((reviewer) => (
                                            <CommandItem
                                                key={reviewer.id}
                                                value={`${reviewer.id}:${reviewer.name}`}
                                                onSelect={() =>
                                                    toggle(reviewer.id)
                                                }>
                                                {reviewer.name}
                                                <Check
                                                    className={cn(
                                                        "mr-2 size-4",
                                                        excluded.includes(
                                                            reviewer.id,
                                                        )
                                                            ? "opacity-100"
                                                            : "opacity-0",
                                                    )}
                                                />
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                </CommandList>
                            </Command>
                        </PopoverContent>
                    </Popover>

                    <div className="flex items-center gap-3">
                        <Button
                            size="lg"
                            variant="cancel"
                            className="flex-1"
                            onClick={goNext}
                            disabled={isSaving}>
                            Skip for now
                        </Button>
                        <Button
                            size="lg"
                            variant="primary"
                            className="flex-1"
                            onClick={handleContinue}
                            loading={isSaving}
                            disabled={isSaving}>
                            {isLoading ? (
                                <Spinner className="h-4 w-4" />
                            ) : (
                                "Continue"
                            )}
                        </Button>
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
