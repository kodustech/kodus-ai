"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { Input } from "@components/ui/input";
import { useToast } from "@components/ui/toaster/use-toast";
import { authorizedFetch } from "@services/fetch";
import {
    CheckCircleIcon,
    KeyIcon,
    ServerIcon,
    ShieldCheckIcon,
    XCircleIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import { apiProxyPath } from "src/core/utils/api-proxy";

import { useSubscriptionStatus } from "../_hooks/use-subscription-status";

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
                    variant: "default",
                });
                setLicenseKey("");
            } else {
                toast({
                    title: "Invalid license key",
                    description:
                        "The provided key is invalid or expired. Please check and try again.",
                    variant: "destructive",
                });
            }
        } catch {
            toast({
                title: "Activation failed",
                description:
                    "Could not activate the license key. Please try again.",
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-4">
            {isLicensed ? (
                <ActiveLicenseCard subscription={subscription} />
            ) : (
                <CommunityCard />
            )}
            <ActivateKeyCard
                isLicensed={isLicensed}
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

    const isExpiring =
        subscription.daysRemaining != null && subscription.daysRemaining <= 30;
    const isExpired =
        subscription.daysRemaining != null && subscription.daysRemaining <= 0;

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between">
                <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                        <ShieldCheckIcon className="size-5 text-emerald-500" />
                        <CardTitle>Active License</CardTitle>
                    </div>
                    <CardDescription>
                        Enterprise features are enabled for this instance.
                    </CardDescription>
                </div>

                {subscription.daysRemaining != null && (
                    <span
                        className={cn(
                            "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium tabular-nums",
                            isExpired
                                ? "bg-red-500/10 text-red-400"
                                : isExpiring
                                  ? "bg-yellow-500/10 text-yellow-400"
                                  : "bg-emerald-500/10 text-emerald-400",
                        )}>
                        {isExpired
                            ? "Expired"
                            : `${subscription.daysRemaining} days remaining`}
                    </span>
                )}
            </CardHeader>

            <CardContent>
                <div className="flex gap-6 text-sm">
                    <div className="flex flex-col gap-0.5">
                        <span className="text-text-secondary">Plan</span>
                        <span className="font-medium capitalize">
                            {subscription.planType}
                        </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <span className="text-text-secondary">Seats</span>
                        <span className="font-medium tabular-nums">
                            {subscription.usersWithAssignedLicense.length} /{" "}
                            {subscription.numberOfLicenses}
                        </span>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function CommunityCard() {
    return (
        <Card>
            <CardHeader>
                <div className="flex items-center gap-2">
                    <ServerIcon className="text-text-secondary size-5" />
                    <CardTitle>Community Edition</CardTitle>
                </div>
                <CardDescription className="text-pretty">
                    You&apos;re running Kodus in self-hosted mode without a
                    license. Activate a key below to unlock enterprise features.
                </CardDescription>
            </CardHeader>
        </Card>
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
    return (
        <Card>
            <CardHeader>
                <div className="flex items-center gap-2">
                    <KeyIcon className="text-text-secondary size-5" />
                    <CardTitle>
                        {isLicensed
                            ? "Update License Key"
                            : "Activate License Key"}
                    </CardTitle>
                </div>
                <CardDescription>
                    {isLicensed
                        ? "Replace your current key with a new one."
                        : "Paste the license key you received from Kodus."}
                </CardDescription>
            </CardHeader>

            <CardContent className="space-y-3">
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
                    <div className="flex items-start gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm">
                        <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
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
                    <div className="flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm">
                        <XCircleIcon className="mt-0.5 size-4 shrink-0 text-red-400" />
                        <span className="font-medium">
                            Invalid or expired license key. Please check and try
                            again.
                        </span>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
