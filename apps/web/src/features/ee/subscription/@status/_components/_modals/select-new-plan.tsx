"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { Label } from "@components/ui/label";
import { Link } from "@components/ui/link";
import { magicModal } from "@components/ui/magic-modal";
import { NumberInput } from "@components/ui/number-input";
import { Separator } from "@components/ui/separator";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { BadgeDollarSignIcon, CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useConfig } from "@providers/ConfigProvider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import type { AwaitedReturnType } from "src/core/types";
import { cn } from "src/core/utils/components";
import { CurrencyHelpers } from "src/core/utils/currency";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { createCheckoutSessionAction } from "../../../_actions/create-checkout-session";
import { migrateToFree, type getPlans } from "../../../_services/billing/fetch";
import type { Plan } from "../../../_services/billing/types";

export const NewPlanSelectionModal = ({
    plans,
}: {
    plans: AwaitedReturnType<typeof getPlans>;
}) => {
    const plansObject = plans.plans.reduce(
        (acc, current) => {
            if (current.type === "contact") {
                acc.enterprise = current;
                return acc;
            }

            if (current.id === "free_byok") {
                acc.free = current;
                return acc;
            }

            if (current.id === "teams_byok") {
                acc.teams_byok = current;
                return acc;
            }

            return acc;
        },
        {} as Record<"free" | "teams_byok" | "enterprise", Plan | undefined>,
    );

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="max-w-5xl pb-0">
                <DialogHeader>
                    <DialogTitle>Selecting subscription plan</DialogTitle>
                </DialogHeader>

                <div className="-mx-6 flex flex-col gap-6 overflow-y-auto px-6 pb-6">
                    <div className="flex gap-4">
                        {plansObject.free && (
                            <FreePlan plan={plansObject.free} />
                        )}

                        {plansObject.teams_byok && (
                            <TeamsPlan plan={plansObject.teams_byok} />
                        )}

                        {plansObject.enterprise && (
                            <EnterprisePlan plan={plansObject.enterprise} />
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

const FreePlan = ({ plan }: { plan: Plan }) => {
    const { teamId } = useSelectedTeamId();
    const { organizationId } = useAuth();
    const router = useRouter();
    const [migrateToFreeAction, { loading }] = useAsyncAction(migrateToFree);

    const handleMigrateToFree = async () => {
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
        } finally {
            magicModal.hide();
        }
    };

    return (
        <Card className="flex-1">
            <CardHeader>
                <CardTitle className="text-balance">{plan.label}</CardTitle>
                <CardDescription className="min-h-20 text-pretty">
                    {plan.description}
                </CardDescription>
            </CardHeader>

            <CardContent className="flex-none pt-0 pb-4">
                <div>
                    <Heading variant="h2" className="text-primary-light">
                        Free
                    </Heading>
                    <span className="text-text-secondary text-sm">&nbsp;</span>
                </div>
            </CardContent>

            <CardContent className="space-y-3">
                <PlanFeatures features={plan.features} />
            </CardContent>

            <Separator />

            <CardContent className="flex-none py-4">
                <Button
                    size="md"
                    variant="primary"
                    className="w-full"
                    leftIcon={<BadgeDollarSignIcon />}
                    loading={loading}
                    onClick={handleMigrateToFree}>
                    Choose this plan
                </Button>
            </CardContent>
        </Card>
    );
};

const TeamsPlan = ({ plan }: { plan: Plan }) => {
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
        <Card className="flex-1">
            <CardHeader>
                <CardTitle className="text-balance">{plan.label}</CardTitle>
                <CardDescription className="min-h-20 text-pretty">
                    {plan.description}
                </CardDescription>
            </CardHeader>

            <CardContent className="flex-none pt-0 pb-4">
                <div>
                    <Heading
                        variant="h2"
                        className="text-primary-light tabular-nums">
                        {CurrencyHelpers.format({
                            currency: planPricing.currency,
                            amount: planPricing.amount,
                            maximumFractionDigits: 0,
                        })}
                        <span className="text-text-secondary">
                            {" "}
                            + AI tokens
                        </span>
                    </Heading>
                    <span className="text-text-secondary text-sm">
                        /dev/month
                    </span>
                </div>
            </CardContent>

            {addonPricing && (
                <Label className="bg-card-lv1 mb-5 flex gap-6 px-6 py-4">
                    <div className="space-y-1">
                        <Heading variant="h3">{addon?.description}</Heading>

                        <Heading variant="h3" className="text-text-secondary">
                            <span className="text-primary-light">
                                +{" "}
                                {CurrencyHelpers.format({
                                    maximumFractionDigits: 0,
                                    currency: addonPricing.currency,
                                    amount:
                                        addonPricing.amount -
                                        planPricing.amount,
                                })}
                            </span>
                            <span>/dev/month</span>
                        </Heading>
                    </div>

                    <Switch
                        checked={isAddonActive}
                        onCheckedChange={setIsAddonActive}
                    />
                </Label>
            )}

            <CardContent className="space-y-3">
                <PlanFeatures features={plan.features} />
            </CardContent>

            <Separator />

            <CardContent className="flex flex-none flex-col gap-4 py-4">
                <FormControl.Root>
                    <FormControl.Label htmlFor="teams-quantity">
                        Quantity of licenses
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
};

const EnterprisePlan = ({ plan }: { plan: Plan }) => {
    const { email } = useAuth();
    const cfg = useConfig();

    return (
        <Card className="flex-1">
            <CardHeader>
                <CardTitle className="text-balance">{plan.label}</CardTitle>
                <CardDescription className="min-h-20 text-pretty">
                    {plan.description}
                </CardDescription>
            </CardHeader>

            <CardContent className="flex-none pt-0 pb-4">
                <div>
                    <Heading variant="h2" className="text-primary-light">
                        Custom
                    </Heading>
                    <span className="text-text-secondary text-sm">&nbsp;</span>
                </div>
            </CardContent>

            <CardContent className="space-y-3">
                <PlanFeatures features={plan.features} />
            </CardContent>

            <Separator />

            <CardContent className="flex-none py-4">
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
                        variant="primary"
                        className="w-full"
                        leftIcon={<ExternalLinkIcon />}>
                        Talk to sales
                    </Button>
                </Link>
            </CardContent>
        </Card>
    );
};

const PlanFeatures = ({ features }: { features: Array<string> }) => {
    return features.map((f, i) => {
        const textWithoutComingSoon = f.split("(coming soon)")[0];

        return (
            <div key={f} className="text-text-secondary flex gap-2 text-sm">
                <CheckIcon className="text-success size-4 shrink-0" />
                <div
                    className={cn(
                        i === 0 && "text-primary-light font-semibold",
                    )}>
                    {textWithoutComingSoon}

                    {f !== textWithoutComingSoon && (
                        <small className="text-text-tertiary">
                            (coming soon)
                        </small>
                    )}
                </div>
            </div>
        );
    });
};
