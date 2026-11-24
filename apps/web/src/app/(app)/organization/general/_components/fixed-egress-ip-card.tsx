"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    availabilityLine,
    planCtaTarget,
} from "@components/system/plan-cta-target";
import { Button } from "@components/ui/button";
import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { Link } from "@components/ui/link";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import {
    setFixedEgressIp,
    type FixedEgressIp,
} from "@services/organizationParameters/fixedEgressIp";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ClipboardHelpers } from "src/core/utils/clipboard";
import { isSelfHosted } from "src/core/utils/self-hosted";

/** The API's refusal message (403 on a plan without it), if it sent one. */
const apiMessage = (error: unknown): string | undefined => {
    const message = (error as { response?: { data?: { message?: unknown } } })
        ?.response?.data?.message;
    return typeof message === "string" ? message : undefined;
};

/**
 * Fixed outbound IP: the organization's review sandboxes reach its Git host
 * from Kodus's fixed IP, for hosts behind an IP allowlist. A Teams and
 * Enterprise feature (trial included); everyone else reaches Git from a
 * shared network. Saved on its own, as soon as it is switched: it is not
 * part of the page's form.
 */
export const FixedEgressIpCard = ({
    initialSetting,
    loadFailed = false,
}: {
    initialSetting: FixedEgressIp;
    /** The setting could not be read: say so instead of hiding the card. */
    loadFailed?: boolean;
}) => {
    const router = useRouter();
    const canEdit = usePermission(
        Action.Create,
        ResourceType.OrganizationSettings,
    );
    const [setting, setSetting] = useState(initialSetting);
    const [seenInitial, setSeenInitial] = useState(initialSetting);
    const [saving, setSaving] = useState(false);
    // A change saved here is the latest known state: a refresh that fails
    // right after it does not replace the card with "could not load".
    const [savedHere, setSavedHere] = useState(false);

    // A server refresh hands down a new setting; adopt it.
    if (seenInitial !== initialSetting) {
        setSeenInitial(initialSetting);
        if (!loadFailed) setSetting(initialSetting);
    }

    // The feature does not exist on a self-hosted install (it reaches Git
    // from its own network), which the deployment itself says; that is not
    // a read result, so it comes before both the failed and the empty read.
    if (isSelfHosted) return null;
    if (loadFailed && !savedHere) {
        return (
            <Card color="lv1" className="w-md">
                <CardHeader className="space-y-2">
                    <CardTitle className="text-base">
                        Fixed outbound IP
                    </CardTitle>
                    <CardDescription>
                        Kodus could not load this setting. Refresh the page to
                        try again.
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }
    if (!setting.available) return null;

    // The organization's stored choice: on also when its plan no longer uses
    // it, so a downgraded organization can see it and turn it off.
    const on = setting.enabled || Boolean(setting.savedOn);
    const unusedOnPlan = on && !setting.enabled;

    const onToggle = async (enabled: boolean) => {
        setSaving(true);
        try {
            setSetting(await setFixedEgressIp({ enabled }));
            setSavedHere(true);
            toast({
                variant: "success",
                title: enabled
                    ? "Fixed outbound IP turned on"
                    : "Fixed outbound IP turned off",
                description: enabled
                    ? "New reviews use it within about 10 minutes."
                    : "New reviews stop using it within about 10 minutes.",
            });
            router.refresh();
        } catch (error) {
            toast({
                variant: "danger",
                title: "Could not change the fixed outbound IP",
                description: apiMessage(error) ?? "Please try again.",
            });
        } finally {
            setSaving(false);
        }
    };

    const copyIp = () => {
        if (!setting.fixedIp) return;
        const copied = ClipboardHelpers.copyTextToClipboard(setting.fixedIp);
        toast(
            copied
                ? { variant: "success", title: "IP copied" }
                : { variant: "danger", title: "Failed to copy the IP" },
        );
    };

    const cta = planCtaTarget();

    return (
        <Card color="lv1" className="w-md">
            <CardHeader className="flex flex-row items-start justify-between gap-6">
                <div className="space-y-2">
                    <CardTitle className="text-base">
                        Fixed outbound IP
                    </CardTitle>
                    <CardDescription>
                        Turn this on when your Git host only accepts connections
                        from allowlisted IPs, such as a self-managed GitLab
                        behind a firewall. Kody then clones the repositories of
                        every team in this organization from Kodus&apos;s fixed
                        IP. Without it, Kody reaches your Git host from a shared
                        network. Saved as soon as you switch it.
                    </CardDescription>

                    {unusedOnPlan ? (
                        <p className="text-text-secondary text-sm">
                            Your plan does not include the fixed outbound IP, so
                            Kody reaches your Git host from the shared network
                            even though this is on. Turn it off to clear it.
                        </p>
                    ) : setting.planUnconfirmed && !on ? (
                        <p className="text-text-secondary text-sm">
                            Kodus could not confirm your plan right now, so this
                            cannot be turned on yet. Try again in a few minutes.
                        </p>
                    ) : !setting.allowedByPlan ? (
                        <p className="text-text-secondary text-sm">
                            {availabilityLine()}{" "}
                            <Link href={cta.href} className="underline">
                                {cta.label}
                            </Link>
                        </p>
                    ) : (
                        <>
                            {setting.fixedIp && (
                                <div className="flex items-center gap-3 pt-1">
                                    <span className="text-text-secondary text-sm">
                                        Allowlist this IP on your Git host:
                                    </span>
                                    <code className="bg-card-lv3 rounded px-2 py-1 text-sm">
                                        {setting.fixedIp}
                                    </code>
                                    <Button
                                        type="button"
                                        size="xs"
                                        variant="helper"
                                        onClick={copyIp}>
                                        Copy
                                    </Button>
                                </div>
                            )}
                            {setting.enabled &&
                                setting.source === "clone_fallback" && (
                                    <p className="text-text-secondary text-sm">
                                        Kody turned this on after your Git host
                                        refused a clone from the shared network.
                                    </p>
                                )}
                        </>
                    )}

                    {!canEdit && (
                        <p className="text-text-secondary text-sm">
                            Only an organization owner can change this.
                        </p>
                    )}
                </div>

                <Switch
                    role="switch"
                    aria-label="Fixed outbound IP"
                    checked={on}
                    disabled={
                        !canEdit ||
                        saving ||
                        (!on &&
                            (!setting.allowedByPlan ||
                                Boolean(setting.planUnconfirmed)))
                    }
                    loading={saving}
                    onCheckedChange={(checked) => {
                        onToggle(checked).catch(() => undefined);
                    }}
                />
            </CardHeader>
        </Card>
    );
};
