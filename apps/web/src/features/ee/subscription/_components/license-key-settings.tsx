"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { useToast } from "@components/ui/toaster/use-toast";
import { authorizedFetch } from "@services/fetch";
import { CheckCircleIcon, KeyIcon, XCircleIcon } from "lucide-react";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { cn } from "src/core/utils/components";

import { useSubscriptionStatus } from "../_hooks/use-subscription-status";
import { PlanFact, PlanSheet, SeatsFact } from "./plan-sheet";
import { RequestTrialCta } from "./request-trial-cta";

type LicenseActivationResult = {
    valid: boolean;
    subscriptionStatus?: string;
    plan?: string;
    seats?: number;
    features?: string[];
    customer?: string;
    expiresAt?: string;
};

export const LicenseKeySettings = () => {
    const subscription = useSubscriptionStatus();
    const { toast } = useToast();
    const [licenseKey, setLicenseKey] = useState("");
    const [loading, setLoading] = useState(false);
    const [activationResult, setActivationResult] =
        useState<LicenseActivationResult | null>(null);

    const isLicensed = subscription.status === "licensed-self-hosted";
    // The self-hosted license service answers an expired key with
    // { valid: false, subscriptionStatus: "expired" }, not a licensed status
    // with days below zero.
    const isExpired = subscription.status === "expired";

    const handleActivate = async () => {
        if (!licenseKey.trim()) return;

        setLoading(true);
        setActivationResult(null);
        try {
            const result = await authorizedFetch<LicenseActivationResult>(
                apiProxyPath("/license/activate"),
                {
                    method: "POST",
                    body: JSON.stringify({ licenseKey: licenseKey.trim() }),
                },
            );

            setActivationResult(result);

            if (result.valid) {
                toast({
                    title: "License activated",
                    description:
                        "Enterprise features are now unlocked. Reload the page to see changes.",
                    variant: "success",
                });
                setLicenseKey("");
            } else {
                toast({
                    title: "Invalid license key",
                    description:
                        "The provided key is invalid or expired. Please check and try again.",
                    variant: "danger",
                });
            }
        } catch {
            toast({
                title: "Activation failed",
                description:
                    "Could not activate the license key. Please try again.",
                variant: "danger",
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-4">
            {isLicensed ? (
                <ActiveLicenseCard subscription={subscription} />
            ) : isExpired ? (
                <ExpiredLicenseCard />
            ) : (
                <CommunityCard />
            )}
            <ActivateKeyCard
                isLicensed={isLicensed || isExpired}
                licenseKey={licenseKey}
                loading={loading}
                activationResult={activationResult}
                onLicenseKeyChange={setLicenseKey}
                onActivate={handleActivate}
            />
        </div>
    );
};

function ActiveLicenseCard({
    subscription,
}: {
    subscription: ReturnType<typeof useSubscriptionStatus>;
}) {
    if (subscription.status !== "licensed-self-hosted") return null;

    const days = subscription.daysRemaining;
    const expired = days != null && days <= 0;
    // A month out is when renewing needs someone's attention.
    const ending = days != null && !expired && days <= 30;
    const tone = expired ? "danger" : "info";

    return (
        <PlanSheet
            tone={tone}
            chip={expired ? "License expired" : "Enterprise"}
            title="Enterprise"
            summary={
                expired
                    ? "Self-hosted. The license expired, so the Enterprise features are off until you paste a renewed key below."
                    : "Self-hosted. Enterprise features are enabled for this instance."
            }
            facts={
                <>
                    <SeatsFact
                        used={subscription.usersWithAssignedLicense.length}
                        total={subscription.numberOfLicenses}
                        tone={tone}
                    />
                    {days != null && (
                        <PlanFact
                            label="License"
                            value={
                                expired
                                    ? "Expired"
                                    : `${days} day${days === 1 ? "" : "s"} left`
                            }
                            detail={
                                expired || ending
                                    ? "Paste a renewed key below to keep the Enterprise features."
                                    : "Replace the key below when you renew."
                            }
                            detailClassName={cn(
                                expired && "text-danger",
                                ending && "text-warning",
                            )}
                        />
                    )}
                </>
            }
        />
    );
}

function ExpiredLicenseCard() {
    return (
        <PlanSheet
            tone="danger"
            chip="License expired"
            title="Enterprise"
            summary="Self-hosted. The license expired, so the Enterprise features are off until you paste a renewed key below."
        />
    );
}

function CommunityCard() {
    return (
        <PlanSheet
            tone="neutral"
            chip="Community"
            title="Community Edition"
            summary="You're running Kodus in self-hosted mode without a license. Don't have a key yet? Request a trial and we'll send you one to activate below.">
            <RequestTrialCta />
        </PlanSheet>
    );
}

function ActivateKeyCard({
    isLicensed,
    licenseKey,
    loading,
    activationResult,
    onLicenseKeyChange,
    onActivate,
}: {
    isLicensed: boolean;
    licenseKey: string;
    loading: boolean;
    activationResult: LicenseActivationResult | null;
    onLicenseKeyChange: (v: string) => void;
    onActivate: () => void;
}) {
    // Same surface as the plan sheet above it: one system on the page.
    return (
        <section
            aria-labelledby="license-key-heading"
            className="bg-card-lv1 border-card-lv3/60 flex flex-col gap-4 rounded-2xl border p-6">
            <div className="flex flex-col gap-1">
                <h3
                    id="license-key-heading"
                    className="text-text-primary flex items-center gap-2 text-base font-semibold">
                    <KeyIcon
                        className="text-text-tertiary size-4"
                        aria-hidden
                    />
                    {isLicensed
                        ? "Update the license key"
                        : "Activate a license key"}
                </h3>
                <p className="text-text-secondary text-sm">
                    {isLicensed
                        ? "Replace your current key with a new one."
                        : "Paste the license key you received from Kodus."}
                </p>
            </div>

            <div className="flex flex-col gap-3">
                <div className="flex gap-2">
                    <Input
                        size="md"
                        type="password"
                        value={licenseKey}
                        placeholder="Paste your license key here"
                        className="flex-1 font-mono"
                        onChange={(e) => onLicenseKeyChange(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") onActivate();
                        }}
                    />
                    <Button
                        size="md"
                        variant="primary"
                        disabled={!licenseKey.trim() || loading}
                        loading={loading}
                        onClick={onActivate}>
                        Activate
                    </Button>
                </div>

                {activationResult?.valid && (
                    <div className="bg-success/10 flex items-start gap-2 rounded-lg p-3 text-sm">
                        <CheckCircleIcon className="text-success mt-0.5 size-4 shrink-0" />
                        <div className="flex flex-col gap-0.5">
                            <span className="font-medium">
                                License activated successfully
                            </span>
                            <span className="text-text-secondary text-xs tabular-nums">
                                {activationResult.plan} plan
                                {activationResult.seats != null &&
                                    ` \u00B7 ${activationResult.seats} seats`}
                                {activationResult.expiresAt &&
                                    ` \u00B7 expires ${new Date(activationResult.expiresAt).toLocaleDateString()}`}
                            </span>
                        </div>
                    </div>
                )}

                {activationResult && !activationResult.valid && (
                    <div className="bg-danger/10 flex items-start gap-2 rounded-lg p-3 text-sm">
                        <XCircleIcon className="text-danger mt-0.5 size-4 shrink-0" />
                        <span className="font-medium">
                            Invalid or expired license key. Please check and try
                            again.
                        </span>
                    </div>
                )}
            </div>
        </section>
    );
}
