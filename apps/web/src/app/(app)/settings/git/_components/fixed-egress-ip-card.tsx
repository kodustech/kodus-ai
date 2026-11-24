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
} from "@services/codeManagement/fixedEgressIp";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { ClipboardHelpers } from "src/core/utils/clipboard";

/** The API's refusal message (403 on a plan without it), if it sent one. */
const apiMessage = (error: unknown): string | undefined => {
    const message = (error as { response?: { data?: { message?: unknown } } })
        ?.response?.data?.message;
    return typeof message === "string" ? message : undefined;
};

/**
 * Fixed outbound IP: review sandboxes reach the team's Git host from Kodus's
 * fixed IP, for hosts behind an IP allowlist. A Teams and Enterprise feature
 * (trial included); everyone else reaches Git from a shared network.
 */
export const FixedEgressIpCard = ({
    initialSetting,
}: {
    initialSetting: FixedEgressIp;
}) => {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();
    const canEdit = usePermission(Action.Create, ResourceType.GitSettings);
    const [setting, setSetting] = useState(initialSetting);
    const [seenInitial, setSeenInitial] = useState(initialSetting);
    const [saving, setSaving] = useState(false);

    // A server refresh hands down a new setting; adopt it.
    if (seenInitial !== initialSetting) {
        setSeenInitial(initialSetting);
        setSetting(initialSetting);
    }

    if (!setting.available) return null;

    const onToggle = async (enabled: boolean) => {
        setSaving(true);
        try {
            setSetting(await setFixedEgressIp({ teamId, enabled }));
            toast({
                variant: "success",
                title: enabled
                    ? "Fixed outbound IP turned on"
                    : "Fixed outbound IP turned off",
                description: "New reviews use it within about 10 minutes.",
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
        <Card className="mb-4">
            <CardHeader className="flex flex-row items-start justify-between gap-6">
                <div className="space-y-2">
                    <CardTitle className="text-base">
                        Fixed outbound IP
                    </CardTitle>
                    <CardDescription>
                        Turn this on when your Git host only accepts connections
                        from allowlisted IPs, such as a self-managed GitLab
                        behind a firewall. Kody then clones your repositories
                        from Kodus&apos;s fixed IP. Without it, Kody reaches
                        your Git host from a shared network.
                    </CardDescription>

                    {!setting.allowedByPlan ? (
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
                </div>

                <Switch
                    role="switch"
                    aria-label="Fixed outbound IP"
                    checked={setting.enabled}
                    disabled={
                        !canEdit ||
                        saving ||
                        (!setting.allowedByPlan && !setting.enabled)
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
