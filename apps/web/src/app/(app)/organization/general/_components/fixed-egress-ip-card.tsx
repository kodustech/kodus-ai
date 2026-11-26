"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    availabilityLine,
    planCtaTarget,
} from "@components/system/plan-cta-target";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import {
    setFixedEgressIp,
    type FixedEgressIp,
} from "@services/organizationParameters/fixedEgressIp";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { CopyIcon, InfoIcon, LockIcon } from "lucide-react";
import { ClipboardHelpers } from "src/core/utils/clipboard";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { SettingsGroup, SettingsRow } from "./settings-group";

const GROUP_TITLE = "Git host access";

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
            <SettingsGroup title={GROUP_TITLE}>
                <SettingsRow
                    title="Fixed outbound IP"
                    description="Kodus could not load this setting. Refresh the page to try again."
                />
            </SettingsGroup>
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
    // Not handed out while the plan cannot be confirmed: the switch cannot
    // be turned on, so "allowlist it, then turn it on" would be a dead end.
    const showIp =
        setting.allowedByPlan &&
        !unusedOnPlan &&
        !(setting.planUnconfirmed && !on) &&
        setting.fixedIp;
    // Off and never turned off by an owner: a clone the shared network gets
    // refused turns it on (the clone fallback). An owner's "off" stays off.
    const fallbackCanTurnOn = !setting.enabled && !setting.turnedOff;

    const notice = unusedOnPlan ? (
        <>
            Your plan does not include the fixed outbound IP, so Kody reaches
            your Git host from the shared network even though this is on. Turn
            it off to clear it.
        </>
    ) : setting.planUnconfirmed && !on ? (
        <>
            Kodus could not confirm your plan right now, so this cannot be
            turned on yet. Try again in a few minutes.
        </>
    ) : !setting.allowedByPlan ? (
        <>
            {availabilityLine()}{" "}
            <Link href={cta.href} className="underline">
                {cta.label}
            </Link>
        </>
    ) : setting.enabled && setting.source === "clone_fallback" ? (
        <>
            Kody turned this on after your Git host refused a clone from the
            shared network.
        </>
    ) : null;

    return (
        <SettingsGroup
            title={GROUP_TITLE}
            description="Saved as soon as you change it, without the Save button.">
            <SettingsRow
                title="Fixed outbound IP"
                description={
                    <>
                        Off by default: Kody reaches your Git host from a shared
                        network whose IPs change. Turn it on when your Git host
                        only accepts allowlisted IPs, such as a self-managed
                        GitLab behind a firewall. Only then does Kody clone, for
                        every team, from the fixed IP below.
                    </>
                }
                control={
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
                }
            />

            {showIp && (
                <SettingsRow
                    title={
                        <span className="flex items-center gap-2">
                            IP to allowlist
                            <span
                                className={
                                    setting.enabled
                                        ? "bg-success/10 text-success rounded-full px-2 py-0.5 text-xs font-medium"
                                        : "bg-card-lv3 text-text-secondary rounded-full px-2 py-0.5 text-xs font-medium"
                                }>
                                {setting.enabled ? "In use" : "Not in use"}
                            </span>
                        </span>
                    }
                    description={
                        setting.enabled
                            ? "Kody clones from this IP. Keep it on your Git host's allowlist."
                            : fallbackCanTurnOn
                              ? "Kody uses this IP only while Fixed outbound IP is on. Allowlist it on your Git host, then turn it on. If your Git host refuses a clone from the shared network first, Kody turns it on for you."
                              : "Kody uses this IP only while Fixed outbound IP is on. Allowlist it on your Git host, then turn it on."
                    }
                    control={
                        <div className="bg-card-lv1 flex items-center gap-1 rounded-lg py-1 pr-1 pl-3">
                            <code className="text-text-primary font-mono text-sm">
                                {setting.fixedIp}
                            </code>
                            <Button
                                type="button"
                                size="xs"
                                variant="helper"
                                leftIcon={<CopyIcon />}
                                onClick={copyIp}>
                                Copy
                            </Button>
                        </div>
                    }
                />
            )}

            {(notice || !canEdit) && (
                <div className="text-text-secondary flex flex-col gap-1 px-5 py-3 text-sm">
                    {notice && (
                        <p className="flex items-start gap-2">
                            <InfoIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                            <span>{notice}</span>
                        </p>
                    )}
                    {!canEdit && (
                        <p className="flex items-start gap-2">
                            <LockIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                            <span>
                                Only an organization owner can change this.
                            </span>
                        </p>
                    )}
                </div>
            )}
        </SettingsGroup>
    );
};
