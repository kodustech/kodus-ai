"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { useGetPastReviewers } from "@services/kodyRules/hooks";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import {
    GitPullRequestIcon,
    ClockFadingIcon,
    Check,
    ChevronsUpDown,
} from "lucide-react";
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

    // Off until the team opts in: learning is not turned on for them.
    const [learnFromPastReviews, setLearnFromPastReviews] = useState(false);
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
        if (!teamId) {
            goNext();
            return;
        }
        try {
            setIsSaving(true);
            // Saved once at global level: every repository follows it unless
            // it sets its own value later in Settings.
            const result = await createOrUpdateCodeReviewParameter(
                {
                    kodyRulesGeneratorEnabled: learnFromPastReviews,
                    ...(learnFromPastReviews && {
                        kodyLearningExcludedReviewers: excluded,
                    }),
                },
                teamId,
                "global",
            );
            if (result?.error) {
                toast({
                    variant: "warning",
                    description:
                        "We couldn't save this choice. You can change it later in Settings.",
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
                        Kody can learn coding standards from your team&apos;s PR
                        reviews: on its next weekly run it drafts rules from the
                        last 3 months, then keeps learning every week. You can
                        leave out anyone whose review comments you&apos;d rather
                        Kody not learn from.
                    </p>
                    <Alert>
                        <ClockFadingIcon size={24} />
                        <AlertTitle>
                            <span className="text-text-secondary text-sm">
                                You can change this anytime in Settings, for
                                every repository or per repository.
                            </span>
                        </AlertTitle>
                    </Alert>
                </div>
            </div>

            <div className="flex w-full flex-col gap-10 lg:flex-14 lg:p-10">
                <div className="flex flex-1 flex-col gap-8">
                    <StepIndicators.Auto />

                    <label className="bg-card-lv1 flex cursor-pointer items-center justify-between gap-6 rounded-xl p-5">
                        <div className="flex flex-col gap-1">
                            <Heading variant="h2">
                                Learn from past reviews?
                            </Heading>
                            <span className="text-text-secondary text-sm">
                                Kody drafts rules from your team&apos;s review
                                comments. Off unless you turn it on.
                            </span>
                        </div>
                        <Switch
                            checked={learnFromPastReviews}
                            onCheckedChange={setLearnFromPastReviews}
                        />
                    </label>

                    {learnFromPastReviews && (
                        <div className="flex flex-col gap-8">
                            <div className="flex flex-col gap-2">
                                <Heading variant="h2">
                                    Whose reviews should Kody learn from?
                                </Heading>
                                <span className="text-text-secondary text-sm">
                                    Everyone is included by default. Select
                                    developers to exclude
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
                                            {isLoading && (
                                                <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                                                    <Spinner className="h-4 w-4" />
                                                    Loading developers…
                                                </div>
                                            )}
                                            <CommandEmpty>
                                                No developers found.
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
                        </div>
                    )}

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
                            Continue
                        </Button>
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
