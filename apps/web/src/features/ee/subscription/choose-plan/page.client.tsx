"use client";

/* Hallmark · component: plan chooser (/choose-plan) · genre: modern-minimal · theme: Kodus system tokens + plan tones (plan-tone.ts)
 * redesign: three cards each shouting its own accent (orange Free button, orange Teams, rose Enterprise with a red "Talk to sales") → tier tones shared with the sidebar and the subscription page, one primary action on the page, prices in text colour, a tier-tinted check per feature, and the plan you're on marked
 * states: default · recommended (Teams) · current plan (CTA disabled) · CTA hover · focus-visible · active · loading (checkout, migrate) · disabled
 * contrast: pass (40–41) · tokens: pass (48) · honest: pass (46 — prices and features from billing's plan catalog) · responsive: cards stack < md
 * pre-emit critique: P4 H5 E4 S4 R5 V4
 */
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
    Building2Icon,
    CheckIcon,
    ExternalLinkIcon,
    GitPullRequestIcon,
    KeyIcon,
    SparklesIcon,
    UsersIcon,
    type LucideIcon,
} from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";
import { CurrencyHelpers } from "src/core/utils/currency";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { createCheckoutSessionAction } from "../_actions/create-checkout-session";
import { useSubscriptionStatus } from "../_hooks/use-subscription-status";
import { migrateToFree } from "../_services/billing/fetch";
import type { Plan } from "../_services/billing/types";
import {
    PLAN_BORDER_TONE,
    PLAN_CHIP_TONE,
    PLAN_TEXT_TONE,
    tierOf,
    type PlanTone,
} from "../_utils/plan-tone";
import type { SimulatorModel } from "./_services/models";

type PlansObject = Record<
    "free" | "teams_byok" | "enterprise",
    Plan | undefined
>;

export function ChoosePlanPageClient({
    plans,
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

            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-3">
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

/** Which plan card the organization is already on, if any. */
const useCurrentPlan = (): "free" | "teams" | "enterprise" | undefined => {
    const subscription = useSubscriptionStatus();
    if (subscription.status === "free") return "free";
    if (subscription.status !== "active") return undefined;
    const tier = tierOf(subscription.planType);
    return tier === "Teams"
        ? "teams"
        : tier === "Enterprise"
          ? "enterprise"
          : undefined;
};

function AllPlansInclude() {
    const items = [
        { icon: GitPullRequestIcon, label: "Unlimited PR reviews" },
        { icon: UsersIcon, label: "Unlimited users" },
        { icon: KeyIcon, label: "Runs on your own AI key" },
    ];

    return (
        <div className="bg-card-lv1 border-card-lv3/60 flex flex-col gap-3 rounded-2xl border px-5 py-4 md:flex-row md:items-center md:justify-between md:gap-6">
            <p className="text-text-primary text-sm font-semibold text-balance">
                Reviews are unlimited on every plan — they run on your own AI
                key.{" "}
                <span className="text-text-secondary font-normal">
                    Plans differ by features, not by how many PRs Kody can
                    review.
                </span>
            </p>
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {items.map(({ icon: Icon, label }) => (
                    <li key={label} className="flex items-center gap-2">
                        <Icon
                            className="text-success size-4 shrink-0"
                            aria-hidden
                        />
                        <span className="text-text-primary text-sm whitespace-nowrap">
                            {label}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** A plan's name in its tier's tone, and what it's for. */
function PlanCardHeader({
    icon: Icon,
    tone,
    plan,
    marker,
}: {
    icon: LucideIcon;
    tone: PlanTone;
    plan: Plan;
    marker?: ReactNode;
}) {
    return (
        <CardHeader className="pb-2">
            <div className="mb-3 flex items-center gap-2">
                <div
                    className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg",
                        PLAN_CHIP_TONE[tone],
                    )}>
                    <Icon className="size-4" aria-hidden />
                </div>
                <CardTitle className="text-balance">{plan.label}</CardTitle>
                {marker && <div className="ml-auto">{marker}</div>}
            </div>
            <CardDescription className="min-h-16 text-pretty">
                {plan.description}
            </CardDescription>
        </CardHeader>
    );
}

const Marker = ({ tone, children }: { tone: PlanTone; children: string }) => (
    <span
        className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap uppercase",
            PLAN_CHIP_TONE[tone],
        )}>
        {children}
    </span>
);

function FreePlan({ plan }: { plan: Plan }) {
    const { teamId } = useSelectedTeamId();
    const { organizationId } = useAuth();
    const router = useRouter();
    const current = useCurrentPlan() === "free";

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
            <PlanCardHeader
                icon={SparklesIcon}
                tone="neutral"
                plan={plan}
                marker={
                    current ? (
                        <Marker tone="neutral">Current plan</Marker>
                    ) : null
                }
            />

            <PriceBlock value="Free" note="Forever free" />

            <CardContent className="flex-1 pb-4">
                <FeaturesLabel>Includes</FeaturesLabel>
                <PlanFeatures features={plan.features} tone="neutral" />
            </CardContent>

            <CardContent className="flex-none pt-0 pb-5">
                {/* Secondary: outlined, since helper shares the card's fill. */}
                <Button
                    size="md"
                    variant="helper"
                    className="border-card-lv3 w-full border"
                    loading={loading}
                    disabled={current}
                    onClick={() => handleMigrateToFree()}>
                    {current ? "Your current plan" : "Choose Free"}
                </Button>
            </CardContent>
        </Card>
    );
}

function TeamsPlan({ plan }: { plan: Plan }) {
    const { teamId } = useSelectedTeamId();
    const [quantity, setQuantity] = useState(1);
    const [isAddonActive, setIsAddonActive] = useState(false);
    // A second Checkout would start a second subscription: changing seats on
    // the plan you have happens in Manage billing.
    const current = useCurrentPlan() === "teams";

    const planPricing = plan.pricing.find((p) => p.interval === "month");
    const addon = plan.addons.at(0);
    const addonPricing = addon?.pricing.find((p) => p.interval === "month");

    const [createLinkToCheckout, { loading: isCreatingLinkToCheckout }] =
        useAsyncAction(async () => {
            const { url } = await createCheckoutSessionAction({
                teamId,
                planId: isAddonActive ? addon!.id : plan.id,
                quantity,
            });
            window.location.assign(url);
        });

    // After the hooks, so they run in the same order on every render.
    if (!planPricing) {
        return null;
    }

    return (
        // The recommended plan: its tier's border, not a second accent.
        <Card
            className={cn(
                "relative flex flex-col overflow-hidden border-2",
                PLAN_BORDER_TONE.secondary,
            )}>
            <PlanCardHeader
                icon={UsersIcon}
                tone="secondary"
                plan={plan}
                marker={
                    <Marker tone="secondary">
                        {current ? "Current plan" : "Most popular"}
                    </Marker>
                }
            />

            <PriceBlock
                value={CurrencyHelpers.format({
                    currency: planPricing.currency,
                    amount: planPricing.amount,
                    maximumFractionDigits: 0,
                })}
                unit="/dev/month"
                note="+ AI token costs (pay-as-you-go)"
            />

            {addonPricing && (
                <Label className="bg-card-lv1 mx-5 mb-4 flex cursor-pointer items-center justify-between gap-4 rounded-lg p-4">
                    <div className="space-y-0.5">
                        <p className="text-text-primary text-sm font-medium">
                            {addon?.description}
                        </p>
                        <p className="text-text-secondary text-sm">
                            <span className="text-text-primary font-semibold tabular-nums">
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
                <FeaturesLabel>Everything in Free, plus</FeaturesLabel>
                <PlanFeatures features={plan.features} tone="secondary" />
            </CardContent>

            <CardContent className="flex flex-none flex-col gap-4 pt-0 pb-5">
                {!current && (
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
                )}

                {/* The page's one primary action. */}
                <Button
                    size="md"
                    variant="primary"
                    className="w-full"
                    leftIcon={current ? undefined : <BadgeDollarSignIcon />}
                    loading={isCreatingLinkToCheckout}
                    disabled={current}
                    onClick={() => createLinkToCheckout()}>
                    {current ? "Your current plan" : "Choose Teams"}
                </Button>
            </CardContent>
        </Card>
    );
}

function EnterprisePlan({ plan }: { plan: Plan }) {
    const { email } = useAuth();
    const cfg = useConfig();
    const current = useCurrentPlan() === "enterprise";

    return (
        <Card className="flex flex-col overflow-hidden">
            <PlanCardHeader
                icon={Building2Icon}
                tone="info"
                plan={plan}
                marker={
                    current ? <Marker tone="info">Current plan</Marker> : null
                }
            />

            <PriceBlock value="Custom" note="Tailored to your needs" />

            <CardContent className="flex-1 pb-4">
                <FeaturesLabel>Everything in Teams, plus</FeaturesLabel>
                <PlanFeatures features={plan.features} tone="info" />
            </CardContent>

            <CardContent className="flex-none pt-0 pb-5">
                <Link
                    target="_blank"
                    noHoverUnderline
                    className="block w-full"
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
                        variant="helper"
                        className="border-card-lv3 w-full border"
                        rightIcon={<ExternalLinkIcon />}>
                        Talk to sales
                    </Button>
                </Link>
            </CardContent>
        </Card>
    );
}

/** The price, in text colour: the card's tone already says which tier. */
function PriceBlock({
    value,
    unit,
    note,
}: {
    value: string;
    unit?: string;
    note: string;
}) {
    return (
        <CardContent className="flex-none pt-2 pb-4">
            <div className="bg-card-lv1 rounded-lg p-4">
                <div className="flex items-baseline gap-1">
                    <Heading variant="h2" className="tabular-nums">
                        {value}
                    </Heading>
                    {unit && (
                        <span className="text-text-secondary text-sm">
                            {unit}
                        </span>
                    )}
                </div>
                <span className="text-text-tertiary text-sm">{note}</span>
            </div>
        </CardContent>
    );
}

const FeaturesLabel = ({ children }: { children: string }) => (
    <p className="text-text-tertiary mb-3 text-xs font-medium">{children}</p>
);

function PlanFeatures({
    features,
    tone,
}: {
    features: Array<string>;
    tone: PlanTone;
}) {
    // Filter out common features that are shown in "All plans include"
    const filteredFeatures = features.filter(
        (f) =>
            !COMMON_FEATURES.some((common) =>
                f.toLowerCase().includes(common.toLowerCase()),
            ),
    );

    return (
        <ul className="flex flex-col gap-3">
            {filteredFeatures.map((f) => {
                const textWithoutComingSoon = f.split("(coming soon)")[0];

                return (
                    <li
                        key={f}
                        className="text-text-secondary flex items-start gap-2.5 text-sm">
                        <CheckIcon
                            className={cn(
                                "mt-0.5 size-4 shrink-0",
                                PLAN_TEXT_TONE[tone],
                            )}
                            aria-hidden
                        />
                        <span>
                            {textWithoutComingSoon}

                            {f !== textWithoutComingSoon && (
                                <small className="text-text-tertiary ml-1">
                                    (coming soon)
                                </small>
                            )}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}
