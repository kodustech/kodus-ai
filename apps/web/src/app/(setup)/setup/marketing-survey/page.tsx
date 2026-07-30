"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { ScrollArea } from "@components/ui/scroll-area";
import { saveMarketingSurvey } from "@services/users/fetch";
import {
    ArrowRight,
    BookOpen,
    Clock,
    Globe,
    Megaphone,
    MessageCircle,
    Search,
    Shield,
    Sparkles,
    Target,
    Users,
    Zap,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { StepIndicators } from "../_components/step-indicators";

const REFERRAL_SOURCES = [
    {
        id: "search",
        label: "Search engine",
        description: "Google, Bing, etc.",
        icon: Search,
    },
    {
        id: "social",
        label: "Social media",
        description: "LinkedIn, Twitter, etc.",
        icon: Globe,
    },
    {
        id: "recommendation",
        label: "Recommendation",
        description: "Friend or colleague",
        icon: Users,
    },
    {
        id: "community",
        label: "Developer community",
        description: "Discord, Reddit, etc.",
        icon: MessageCircle,
    },
    {
        id: "ads",
        label: "Advertisement",
        description: "Online ad or sponsored content",
        icon: Megaphone,
    },
    {
        id: "other",
        label: "Other",
        description: "Something else",
        icon: Sparkles,
    },
] as const;

const GOALS = [
    {
        id: "speed",
        label: "Ship faster",
        description: "Reduce code review time and merge PRs quickly",
        icon: Zap,
    },
    {
        id: "quality",
        label: "Improve code quality",
        description: "Catch bugs and issues before they reach production",
        icon: Shield,
    },
    {
        id: "consistency",
        label: "Enforce standards",
        description: "Keep the codebase consistent across the team",
        icon: Target,
    },
    {
        id: "learning",
        label: "Help the team learn",
        description: "Share knowledge and best practices through reviews",
        icon: BookOpen,
    },
    {
        id: "time",
        label: "Save reviewer time",
        description: "Free up senior devs from routine review tasks",
        icon: Clock,
    },
    {
        id: "other",
        label: "Something else",
        description: "I have a different goal in mind",
        icon: Sparkles,
    },
] as const;

type ReferralSource = (typeof REFERRAL_SOURCES)[number]["id"];
type Goal = (typeof GOALS)[number]["id"];

const SelectionCard = ({
    label,
    description,
    icon: Icon,
    selected,
    onSelect,
}: {
    label: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    selected: boolean;
    onSelect: () => void;
}) => {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                "flex flex-row items-center gap-3 rounded-xl border p-4 text-left transition-colors",
                selected
                    ? "border-primary-light bg-primary-light/5"
                    : "border-card-lv3 hover:border-card-lv3/80",
            )}>
            <div
                className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                    selected ? "bg-primary-light/20" : "bg-card-lv2",
                )}>
                <Icon
                    className={cn(
                        "h-5 w-5",
                        selected ? "text-primary-light" : "text-text-secondary",
                    )}
                />
            </div>
            <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">{label}</span>
                <span className="text-text-secondary text-xs">
                    {description}
                </span>
            </div>
        </button>
    );
};

export default function MarketingSurveyPage() {
    const router = useRouter();

    const [selectedSource, setSelectedSource] = useState<ReferralSource | null>(
        null,
    );
    const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleContinue = async () => {
        setIsSubmitting(true);

        try {
            await saveMarketingSurvey({
                referralSource: selectedSource ?? undefined,
                primaryGoal: selectedGoal ?? undefined,
            });
        } catch (error) {
            console.error("Error saving marketing survey", error);
        } finally {
            setIsSubmitting(false);
            router.push("/setup/connecting-git-tool");
        }
    };

    const handleSkip = () => {
        router.push("/setup/connecting-git-tool");
    };

    const canContinue = selectedSource && selectedGoal;

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-col gap-6 p-6 lg:flex-row lg:gap-6">
            <div className="bg-card-lv1 flex w-full flex-col justify-center gap-10 rounded-3xl p-8 lg:max-w-none lg:flex-10 lg:p-12">
                <div className="flex-1 space-y-6 overflow-hidden">
                    <h1 className="text-2xl font-bold">
                        Help us improve your experience
                    </h1>
                    <p className="text-text-secondary text-base">
                        Understanding how you found us and what you're looking
                        to achieve helps us build a better product for you.
                    </p>

                    <div className="bg-card-lv2 rounded-xl p-5">
                        <div className="flex items-start gap-3">
                            <div className="bg-primary-light/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                                <Sparkles className="text-primary-light h-5 w-5" />
                            </div>
                            <div className="flex flex-col gap-1">
                                <span className="text-sm font-semibold">
                                    Quick survey
                                </span>
                                <span className="text-text-secondary text-xs">
                                    Just 2 questions, takes less than 30
                                    seconds. Your answers help us personalize
                                    your setup.
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <ScrollArea className="flex w-full flex-col gap-10 lg:flex-14 lg:p-10">
                <div className="flex flex-col gap-8 pb-10">
                    <StepIndicators.Auto />

                    <div className="flex flex-col gap-6">
                        <div className="flex flex-col gap-2">
                            <Heading variant="h2">
                                How did you hear about us?
                            </Heading>
                            <span className="text-text-secondary text-sm">
                                Select the option that best describes how you
                                found Kody.
                            </span>
                        </div>

                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {REFERRAL_SOURCES.map((source) => (
                                <SelectionCard
                                    key={source.id}
                                    label={source.label}
                                    description={source.description}
                                    icon={source.icon}
                                    selected={selectedSource === source.id}
                                    onSelect={() =>
                                        setSelectedSource(source.id)
                                    }
                                />
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col gap-6">
                        <div className="flex flex-col gap-2">
                            <Heading variant="h2">
                                What are you looking to solve?
                            </Heading>
                            <span className="text-text-secondary text-sm">
                                Select your primary goal for using Kody.
                            </span>
                        </div>

                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {GOALS.map((goal) => (
                                <SelectionCard
                                    key={goal.id}
                                    label={goal.label}
                                    description={goal.description}
                                    icon={goal.icon}
                                    selected={selectedGoal === goal.id}
                                    onSelect={() => setSelectedGoal(goal.id)}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col items-center gap-4">
                        <Button
                            size="lg"
                            variant="primary"
                            className="w-full"
                            rightIcon={<ArrowRight />}
                            onClick={handleContinue}
                            loading={isSubmitting}
                            disabled={!canContinue || isSubmitting}>
                            Continue
                        </Button>

                        <button
                            type="button"
                            onClick={handleSkip}
                            disabled={isSubmitting}
                            className={cn(
                                "text-primary-light text-sm hover:underline",
                                isSubmitting && "opacity-60",
                            )}>
                            Skip for now
                        </button>
                    </div>
                </div>
            </ScrollArea>
        </Page.Root>
    );
}
