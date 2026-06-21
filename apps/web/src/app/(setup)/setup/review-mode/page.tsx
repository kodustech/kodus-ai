"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Alert, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useGetRepositories } from "@services/codeManagement/hooks";
import { applyCodeReviewPreset } from "@services/parameters/fetch";
import { PULL_REQUEST_API } from "@services/pull-requests/fetch";
import {
    AlertCircleIcon,
    CheckCircle2Icon,
    CheckIcon,
    Sparkle,
} from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";
import { useFetch } from "src/core/utils/reactQuery";
import { safeArray } from "src/core/utils/safe-array";

import { StepIndicators } from "../_components/step-indicators";

type ReviewMode = "default" | "safety" | "speed" | "coach";

const REVIEW_MODE_GUIDE: Record<
    ReviewMode,
    { subtitle: string; items: string[]; note?: string }
> = {
    default: {
        subtitle: "Balanced start without extra friction.",
        items: [
            "Keeps comments to a steady, manageable level.",
            "Covers the usual issues without slowing the team.",
            "Easy to tweak later once the team feels the fit.",
        ],
    },
    safety: {
        subtitle: "Cautious mode for thorough reviews.",
        items: [
            "Reviews every new push automatically.",
            "Surfaces issues from Medium severity and higher.",
            "Provides more detailed feedback on each PR so fewer issues slip through.",
            "Uses minimal filtering, so you see most of what Kody finds.",
        ],
    },
    speed: {
        subtitle: "Fast lane with only the essentials.",
        items: [
            "Runs when the PR opens, not on every push.",
            "Keeps the review lean so merges stay fast.",
            "Only flags the most critical issues for the PR.",
            "Stays brief, around 4–6 suggestions per PR when needed.",
        ],
    },
    coach: {
        subtitle: "Coaching mode with steady, actionable feedback.",
        items: [
            "Comments on every push, including drafts.",
            "Stays active throughout the PR so you can iterate quickly.",
            "Alerts from Medium severity upward.",
            "Typically shares around 10–12 suggestions per PR to help the team improve.",
            "Tone focuses on why and how to fix, with short examples and minimal nitpicks.",
        ],
    },
};

const REVIEW_MODES = [
    {
        id: "default" as const,
        title: "Default",
        description: "Balanced review with a steady amount of comments.",
        image: "/assets/images/kody_default.png",
    },
    {
        id: "safety" as const,
        title: "Safety",
        description:
            "More issues flagged and more comments. Best for thorough reviews.",
        image: "/assets/images/kody_safety.png",
        recommended: true,
    },
    {
        id: "speed" as const,
        title: "Speed",
        description: "Only high impact issues. Minimal comments.",
        image: "/assets/images/kody_speed.png",
    },
    {
        id: "coach" as const,
        title: "Coach",
        description: "More suggestions and explanations with less nitpicking.",
        image: "/assets/images/kody_coach.png",
    },
];

const ReviewModeCard = ({
    mode,
    selected,
    recommended,
    onSelect,
}: {
    mode: (typeof REVIEW_MODES)[number];
    selected: boolean;
    recommended?: boolean;
    onSelect: () => void;
}) => {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                "relative flex flex-row items-center gap-4 rounded-xl border p-4 text-left transition-colors",
                selected
                    ? "border-primary-light bg-primary-light/5"
                    : "border-card-lv3 hover:border-card-lv3/80",
            )}>
            {recommended && (
                <span className="bg-primary-light ring-primary/30 absolute -top-2.5 right-3 rounded px-2.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-black shadow-sm ring-1">
                    Recommended based on your repo
                </span>
            )}
            <Image
                src={mode.image}
                alt={mode.title}
                width={56}
                height={56}
                className="shrink-0"
            />
            <div className="flex flex-col gap-1">
                <span className="text-sm font-semibold">{mode.title}</span>
                <span className="text-text-secondary text-xs">
                    {mode.description}
                </span>
            </div>
        </button>
    );
};

export default function ReviewModePage() {
    const router = useRouter();
    const { userId } = useAuth();
    const { teamId } = useSelectedTeamId();
    const { data: repositories = [], isLoading: isLoadingRepositories } =
        useGetRepositories(teamId);
    const [selectedMode, setSelectedMode] = useState<ReviewMode>("default");
    const [isApplyingPreset, setIsApplyingPreset] = useState(false);

    const selectedRepoIds = useMemo(() => {
        return safeArray<{ id: string; selected?: boolean }>(repositories)
            .filter((r) => r.selected)
            .map((r) => r.id);
    }, [repositories]);

    const onboardingEnabled =
        Boolean(teamId) && Boolean(selectedRepoIds.length);

    const {
        data: onboardingSignals = [],
        isLoading: isOnboardingSignalsLoading = onboardingEnabled,
        isFetching: isOnboardingSignalsFetching = false,
        isError: isOnboardingSignalsError = false,
        failureCount: onboardingSignalsFailureCount = 0,
        refetch: refetchOnboardingSignals,
    } = useFetch<
        Array<{
            repositoryId: string;
            recommendation?: { mode?: string };
        }>
    >(
        onboardingEnabled
            ? PULL_REQUEST_API.GET_ONBOARDING_SIGNALS({
                  teamId,
                  repositoryIds: selectedRepoIds,
                  limit: 5,
              })
            : null,
        undefined,
        onboardingEnabled,
        {
            staleTime: 10000,
            refetchOnMount: "always",
            refetchOnReconnect: true,
            retry: 3,
            retryDelay: (attempt) => Math.min(2000 * (attempt + 1), 8000),
            refetchInterval: onboardingEnabled
                ? (data) => {
                      const signals = Array.isArray(data) ? data : [];
                      const hasRecommendation = signals.some((signal) => {
                          const mode =
                              signal?.recommendation?.mode?.toLowerCase();
                          return (
                              mode === "safety" ||
                              mode === "speed" ||
                              mode === "coach" ||
                              mode === "default"
                          );
                      });
                      return hasRecommendation ? false : 15000;
                  }
                : false,
        },
    );

    const recommendedMode = useMemo(() => {
        const signals = Array.isArray(onboardingSignals)
            ? onboardingSignals
            : [];
        const mode = signals
            .find((signal) => signal?.recommendation?.mode)
            ?.recommendation?.mode?.toLowerCase();
        if (
            mode === "safety" ||
            mode === "speed" ||
            mode === "coach" ||
            mode === "default"
        )
            return mode as ReviewMode;
        return undefined;
    }, [onboardingSignals]);

    const handleSelectMode = (mode: ReviewMode) => {
        setSelectedMode(mode);
    };

    const recommendationLoading =
        Boolean(teamId && selectedRepoIds.length) &&
        !recommendedMode &&
        (isOnboardingSignalsLoading ||
            isOnboardingSignalsFetching ||
            isOnboardingSignalsError);

    // Manual backoff to refetch when the endpoint fails, reducing the need for a full page refresh.
    useEffect(() => {
        if (
            !onboardingEnabled ||
            recommendedMode ||
            isOnboardingSignalsLoading ||
            isOnboardingSignalsFetching ||
            !isOnboardingSignalsError
        ) {
            return;
        }

        const retryDelay = Math.min(
            2000 * Math.max(1, onboardingSignalsFailureCount),
            8000,
        );

        const timeoutId = setTimeout(() => {
            refetchOnboardingSignals();
        }, retryDelay);

        return () => clearTimeout(timeoutId);
    }, [
        onboardingEnabled,
        recommendedMode,
        isOnboardingSignalsLoading,
        isOnboardingSignalsFetching,
        onboardingSignalsFailureCount,
        refetchOnboardingSignals,
        isOnboardingSignalsError,
    ]);

    const selectedModeLabel =
        REVIEW_MODES.find((m) => m.id === selectedMode)?.title ?? "Default";
    const selectedGuide =
        REVIEW_MODE_GUIDE[selectedMode] ?? REVIEW_MODE_GUIDE.default;

    useEffect(() => {
        if (recommendedMode) {
            setSelectedMode(recommendedMode);
        } else {
            setSelectedMode("default");
        }
    }, [recommendedMode, teamId]);

    const handleContinue = async () => {
        if (!teamId) {
            toast({
                variant: "danger",
                description: "Missing team. Please try again.",
            });
            return;
        }

        const preset = ["speed", "safety", "coach"].includes(selectedMode)
            ? (selectedMode as "speed" | "safety" | "coach")
            : undefined;

        if (!preset) {
            router.push("/setup/customize-team");
            return;
        }

        try {
            setIsApplyingPreset(true);
            await applyCodeReviewPreset({ teamId, preset });
            router.push("/setup/customize-team");
        } catch (error) {
            console.error("Error applying review mode preset", error);
            toast({
                variant: "danger",
                description:
                    "We couldn't apply this review mode. Please try again.",
            });
        } finally {
            setIsApplyingPreset(false);
        }
    };

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-col gap-6 p-6 lg:flex-row lg:gap-6">
            <div className="bg-card-lv1 flex w-full flex-col justify-center gap-10 rounded-3xl p-8 lg:max-w-none lg:flex-10 lg:p-12">
                <div className="flex-1 space-y-4 overflow-hidden">
                    <h1 className="text-2xl font-bold">
                        What changes with this mode?
                    </h1>
                    <div className="flex flex-row gap-2">
                        <div className="p-5">
                            <h2 className="text-text-primary flex items-center gap-2 text-base font-semibold">
                                <Sparkle /> {selectedModeLabel} mode
                            </h2>
                            <ul className="mt-4 space-y-3">
                                {selectedGuide.items.map((item, index) => (
                                    <li
                                        key={`${selectedMode}-${index}`}
                                        className="text-text-secondary text-md flex items-start gap-2">
                                        <span className="bg-primary/10 text-primary mt-0.5 flex h-4 w-6 shrink-0 items-center justify-center rounded-full">
                                            <CheckCircle2Icon size={16} />
                                        </span>
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                            {selectedGuide.note && (
                                <p className="text-text-tertiary mt-4 text-xs">
                                    {selectedGuide.note}
                                </p>
                            )}
                        </div>
                    </div>
                    <Alert>
                        <AlertCircleIcon size={24} />
                        <AlertTitle>
                            <span className="text-text-secondary text-sm">
                                Don&apos;t worry, you can change this anytime in
                                Settings.
                            </span>
                        </AlertTitle>
                    </Alert>
                </div>
            </div>

            <div className="flex w-full flex-col gap-10 lg:flex-14 lg:p-10">
                <div className="flex flex-1 flex-col gap-8">
                    <StepIndicators.Auto />

                    <Heading variant="h2">Choose a review mode</Heading>

                    <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-text-secondary text-sm">
                                Choose how deep Kody should review your code.
                            </span>
                            {recommendationLoading && (
                                <div className="text-text-secondary flex items-center gap-2 text-xs">
                                    <Spinner className="h-4 w-4" />
                                    <span>Loading recommendation...</span>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            {REVIEW_MODES.map((mode) => (
                                <ReviewModeCard
                                    key={mode.id}
                                    mode={mode}
                                    recommended={recommendedMode === mode.id}
                                    selected={selectedMode === mode.id}
                                    onSelect={() => handleSelectMode(mode.id)}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col items-center gap-4">
                        <Button
                            size="lg"
                            variant="primary"
                            className="w-full"
                            onClick={handleContinue}
                            loading={isApplyingPreset || isLoadingRepositories}
                            disabled={
                                isApplyingPreset || isLoadingRepositories
                            }>
                            {isLoadingRepositories
                                ? "Loading configuration..."
                                : `Continue with ${selectedModeLabel}`}
                        </Button>
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
