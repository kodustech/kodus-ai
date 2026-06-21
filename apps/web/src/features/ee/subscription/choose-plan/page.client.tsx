"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { Label } from "@components/ui/label";
import { Link } from "@components/ui/link";
import { NumberInput } from "@components/ui/number-input";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useConfig } from "@providers/ConfigProvider";
import {
    BadgeDollarSignIcon,
    BookOpenIcon,
    BrainIcon,
    CheckIcon,
    ExternalLinkIcon,
    GaugeIcon,
    GitPullRequestIcon,
    HeadphonesIcon,
    KeyIcon,
    MessageCircleIcon,
    PlugIcon,
    RadarIcon,
    RocketIcon,
    ShieldCheckIcon,
    SparklesIcon,
    UsersIcon,
    type LucideIcon,
} from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { CurrencyHelpers } from "src/core/utils/currency";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { createCheckoutSessionAction } from "../_actions/create-checkout-session";
import { migrateToFree } from "../_services/billing/fetch";
import type { Plan } from "../_services/billing/types";
import type { SimulatorModel } from "./_services/models";

type PlansObject = Record<
    "free" | "teams_byok" | "enterprise",
    Plan | undefined
>;

export function ChoosePlanPageClient({
    plans,
    simulatorModels,
    tokenProjectionSlot,
}: {
    plans: PlansObject;
    simulatorModels: SimulatorModel[];
    tokenProjectionSlot: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-6">
            {tokenProjectionSlot}

            {/* Anchor message: the #1 thing people get wrong about pricing —
                reviews are unlimited on every plan because they run on the
                user's own key. Plans only change features. */}
            <AllPlansInclude />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {plans.free && <FreePlan plan={plans.free} />}
                {plans.teams_byok && <TeamsPlan plan={plans.teams_byok} />}
                {plans.enterprise && <EnterprisePlan plan={plans.enterprise} />}
            </div>
        </div>
    );
}

// Features that are common to all plans - these will be filtered from individual plan lists
const COMMON_FEATURES = [
    "Unlimited PRs using your own API key",
    "Unlimited users",
];

// Map feature keywords to icons
const FEATURE_ICONS: Array<{ keywords: string[]; icon: LucideIcon }> = [
    { keywords: ["kody rules", "rules"], icon: BookOpenIcon },
    { keywords: ["plugin"], icon: PlugIcon },
    { keywords: ["quality radar", "radar"], icon: RadarIcon },
    { keywords: ["learning", "memory"], icon: BrainIcon },
    { keywords: ["discord", "support", "email"], icon: MessageCircleIcon },
    { keywords: ["priority queue", "queue"], icon: RocketIcon },
    { keywords: ["metrics", "cockpit"], icon: GaugeIcon },
    { keywords: ["sso", "saml"], icon: KeyIcon },
    { keywords: ["soc 2", "soc2"], icon: ShieldCheckIcon },
    { keywords: ["rbac", "audit"], icon: ShieldCheckIcon },
    { keywords: ["hours", "onboarding", "dedicated"], icon: HeadphonesIcon },
    {
        keywords: ["private discord", "private channel"],
        icon: MessageCircleIcon,
    },
];

function getFeatureIcon(feature: string): LucideIcon {
    const lowerFeature = feature.toLowerCase();
    for (const { keywords, icon } of FEATURE_ICONS) {
        if (keywords.some((kw) => lowerFeature.includes(kw))) {
            return icon;
        }
    }
    return CheckIcon;
}

function AllPlansInclude() {
    const items = [
        { icon: GitPullRequestIcon, label: "Unlimited PR reviews" },
        { icon: UsersIcon, label: "Unlimited users" },
        { icon: KeyIcon, label: "Runs on your own AI key" },
    ];

    return (
        <div className="bg-card-lv1 border-card-lv3 flex flex-col gap-3 rounded-lg border px-5 py-4 md:flex-row md:items-center md:justify-between md:gap-6">
            <p className="text-text-primary text-sm font-semibold text-balance">
                Reviews are unlimited on every plan — they run on your own AI
                key.{" "}
                <span className="text-text-secondary font-normal">
                    Plans differ by features, not by how many PRs Kody can
                    review.
                </span>
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {items.map(({ icon: Icon, label }) => (
                    <div key={label} className="flex items-center gap-2">
                        <div className="bg-success/20 flex size-6 items-center justify-center rounded-full">
                            <Icon className="text-success size-3.5" />
                        </div>
                        <span className="text-text-primary text-sm whitespace-nowrap">
                            {label}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function FreePlan({ plan }: { plan: Plan }) {
    const { teamId } = useSelectedTeamId();
    const { organizationId } = useAuth();
    const router = useRouter();

    const [handleMigrateToFree, { loading }] = useAsyncAction(async () => {
        if (!teamId || !organizationId) {
            toast({
                title: "Error",
                description: "Missing team or organization information",
                variant: "danger",
            });
            return;
        }

        try {
            const result = await migrateToFree({
                organizationId,
                teamId,
            });

            if (result?.success) {
                toast({
                    title: "Successfully migrated to free plan",
                    description: (
                        <span>
                            <span className="text-primary-light mr-1 font-bold">
                                {plan.label}
                            </span>
                            <span>plan is now active.</span>
                        </span>
                    ),
                    variant: "success",
                });

                router.push("/settings/subscription");
                router.refresh();
            } else {
                toast({
                    title: "Migration failed",
                    description:
                        result?.message || "Failed to migrate to free plan",
                    variant: "danger",
                });
            }
        } catch (error) {
            toast({
                title: "Error",
                description:
                    "An unexpected error occurred while migrating to free plan",
                variant: "danger",
            });
            console.error("Migration error:", error);
        }
    });

    return (
        <Card className="flex flex-col overflow-hidden">
            <CardHeader className="pb-2">
                <div className="mb-3 flex items-center gap-2">
                    <div className="bg-card-lv1 flex size-8 items-center justify-center rounded-lg">
                        <SparklesIcon className="text-text-secondary size-4" />
                    </div>
                    <CardTitle className="text-balance">{plan.label}</CardTitle>
                </div>
                <CardDescription className="min-h-16 text-pretty">
                    {plan.description}
                </CardDescription>
            </CardHeader>

            <CardContent className="flex-none pt-2 pb-4">
                <div className="bg-card-lv1 rounded-lg p-4">
                    <Heading variant="h2" className="text-primary-light">
                        Free
                    </Heading>
                    <span className="text-text-tertiary text-sm">
                        Forever free
                    </span>
                </div>
            </CardContent>

            <CardContent className="flex-1 pb-4">
                <p className="text-text-tertiary mb-3 text-xs font-medium uppercase">
                    Includes
                </p>
                <PlanFeatures features={plan.features} />
            </CardContent>

            <CardContent className="flex-none pt-0 pb-5">
                <Button
                    size="md"
                    variant="secondary"
                    className="w-full"
                    loading={loading}
                    onClick={() => handleMigrateToFree()}>
                    Choose this plan
                </Button>
            </CardContent>
        </Card>
    );
}

function TeamsPlan({ plan }: { plan: Plan }) {
    const { teamId } = useSelectedTeamId();
    const [quantity, setQuantity] = useState(1);
    const [isAddonActive, setIsAddonActive] = useState(false);

    const planPricing = plan.pricing.find((p) => p.interval === "month");
    if (!planPricing) {
        return null;
    }

    const addon = plan.addons.at(0);
    const addonPricing = addon?.pricing.find((p) => p.interval === "month");

    const [createLinkToCheckout, { loading: isCreatingLinkToCheckout }] =
        useAsyncAction(async () => {
            const { url } = await createCheckoutSessionAction({
                teamId,
                planId: isAddonActive ? addon!.id : plan.id,
                quantity,
            });
            window.location.href = url;
        });

    return (
        <Card className="border-primary-dark relative flex flex-col overflow-hidden border-2">
            {/* Popular badge */}
            <div className="bg-primary-light absolute top-4 right-4 rounded-full px-3 py-1">
                <span className="text-xs font-semibold text-black">
                    Most popular
                </span>
            </div>

            <CardHeader className="pb-2">
                <div className="mb-3 flex items-center gap-2">
                    <div className="bg-primary-dark flex size-8 items-center justify-center rounded-lg">
                        <UsersIcon className="text-primary-light size-4" />
                    </div>
                    <CardTitle className="text-balance">{plan.label}</CardTitle>
                </div>
                <CardDescription className="min-h-16 text-pretty">
                    {plan.description}
                </CardDescription>
            </CardHeader>

            <CardContent className="flex-none pt-2 pb-4">
                <div className="bg-primary-dark/30 rounded-lg p-4">
                    <div className="flex items-baseline gap-1">
                        <Heading
                            variant="h2"
                            className="text-primary-light tabular-nums">
                            {CurrencyHelpers.format({
                                currency: planPricing.currency,
                                amount: planPricing.amount,
                                maximumFractionDigits: 0,
                            })}
                        </Heading>
                        <span className="text-text-secondary text-sm">
                            /dev/month
                        </span>
                    </div>
                    <span className="text-text-tertiary text-sm">
                        + AI token costs (pay-as-you-go)
                    </span>
                </div>
            </CardContent>

            {addonPricing && (
                <Label className="bg-card-lv1 mx-5 mb-4 flex cursor-pointer items-center justify-between gap-4 rounded-lg p-4">
                    <div className="space-y-0.5">
                        <p className="text-text-primary text-sm font-medium">
                            {addon?.description}
                        </p>
                        <p className="text-text-secondary text-sm">
                            <span className="text-primary-light font-semibold">
                                +{" "}
                                {CurrencyHelpers.format({
                                    maximumFractionDigits: 0,
                                    currency: addonPricing.currency,
                                    amount:
                                        addonPricing.amount -
                                        planPricing.amount,
                                })}
                            </span>
                            <span className="text-text-tertiary">
                                /dev/month
                            </span>
                        </p>
                    </div>

                    <Switch
                        checked={isAddonActive}
                        onCheckedChange={setIsAddonActive}
                    />
                </Label>
            )}

            <CardContent className="flex-1 pb-4">
                <p className="text-text-tertiary mb-3 text-xs font-medium uppercase">
                    Everything in Free, plus
                </p>
                <PlanFeatures features={plan.features} />
            </CardContent>

            <CardContent className="flex flex-none flex-col gap-4 pt-0 pb-5">
                <FormControl.Root>
                    <FormControl.Label htmlFor="teams-quantity">
                        Developer licenses
                    </FormControl.Label>

                    <FormControl.Input>
                        <NumberInput.Root
                            min={1}
                            size="md"
                            value={quantity}
                            onValueChange={setQuantity}>
                            <NumberInput.Decrement />
                            <NumberInput.Input id="teams-quantity" />
                            <NumberInput.Increment />
                        </NumberInput.Root>
                    </FormControl.Input>

                    <p className="text-text-tertiary text-xs">
                        One license per developer whose PRs Kody reviews.
                        Workspace members (reviewers, viewers, admins) are
                        unlimited and free.
                    </p>
                </FormControl.Root>

                <Button
                    size="md"
                    variant="primary"
                    className="w-full"
                    leftIcon={<BadgeDollarSignIcon />}
                    loading={isCreatingLinkToCheckout}
                    onClick={() => createLinkToCheckout()}>
                    Choose this plan
                </Button>
            </CardContent>
        </Card>
    );
}

function EnterprisePlan({ plan }: { plan: Plan }) {
    const { email } = useAuth();
    const cfg = useConfig();

    return (
        <Card className="flex flex-col overflow-hidden">
            <CardHeader className="pb-2">
                <div className="mb-3 flex items-center gap-2">
                    <div className="bg-tertiary-dark flex size-8 items-center justify-center rounded-lg">
                        <BadgeDollarSignIcon className="text-tertiary-light size-4" />
                    </div>
                    <CardTitle className="text-balance">{plan.label}</CardTitle>
                </div>
                <CardDescription className="min-h-16 text-pretty">
                    {plan.description}
                </CardDescription>
            </CardHeader>

            <CardContent className="flex-none pt-2 pb-4">
                <div className="bg-card-lv1 rounded-lg p-4">
                    <Heading variant="h2" className="text-primary-light">
                        Custom
                    </Heading>
                    <span className="text-text-tertiary text-sm">
                        Tailored to your needs
                    </span>
                </div>
            </CardContent>

            <CardContent className="flex-1 pb-4">
                <p className="text-text-tertiary mb-3 text-xs font-medium uppercase">
                    Everything in Teams, plus
                </p>
                <PlanFeatures features={plan.features} />
            </CardContent>

            <CardContent className="flex-none pt-0 pb-5">
                <Link
                    target="_blank"
                    href={addSearchParamsToUrl(
                        cfg.supportTalkToFounderUrl || "",
                        {
                            email,
                            notes: "I want to know more about Enterprise plan.",
                        },
                    )}>
                    <Button
                        size="md"
                        decorative
                        variant="tertiary"
                        className="w-full"
                        leftIcon={<ExternalLinkIcon />}>
                        Talk to sales
                    </Button>
                </Link>
            </CardContent>
        </Card>
    );
}

function PlanFeatures({ features }: { features: Array<string> }) {
    // Filter out common features that are shown in "All plans include"
    const filteredFeatures = features.filter(
        (f) =>
            !COMMON_FEATURES.some((common) =>
                f.toLowerCase().includes(common.toLowerCase()),
            ),
    );

    return (
        <div className="flex flex-col gap-3">
            {filteredFeatures.map((f) => {
                const textWithoutComingSoon = f.split("(coming soon)")[0];
                const Icon = getFeatureIcon(f);

                return (
                    <div
                        key={f}
                        className="text-text-secondary flex items-start gap-3 text-sm">
                        <div className="bg-card-lv1 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md">
                            <Icon className="text-text-tertiary size-3.5" />
                        </div>
                        <div className="pt-0.5">
                            {textWithoutComingSoon}

                            {f !== textWithoutComingSoon && (
                                <small className="text-text-tertiary ml-1">
                                    (coming soon)
                                </small>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
