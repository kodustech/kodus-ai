"use client";

/* Hallmark · component: plan status (sidebar foot) · genre: modern-minimal · theme: system-tokens (card-lv*, text-*, primary · secondary · info)
 * redesign: a muted text link for settled plans → one panel for every state, a tier chip (tone per tier) + one fact from billing
 * states: default · hover · focus-visible · active · error (payment failed, canceled, license expired) · warning (trial/license ending) · unknown (billing unreachable) · rail glyph
 * plans: trial (active · expiring · exhausted) · free · teams · enterprise · community self-hosted · enterprise self-hosted · canceled · expired · unconfirmed · no license · payment failed
 * contrast: pass (40–41) · tokens: pass (48) · honest: pass (46 — seats, days and reviews come from billing; nothing invented)
 * pre-emit critique: P4 H5 E4 S5 R4 V4
 */
import { Link } from "@components/ui/link";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    AlertTriangleIcon,
    ArrowRightIcon,
    Building2Icon,
    CirclePauseIcon,
    CloudOffIcon,
    KeyRoundIcon,
    ServerIcon,
    SparklesIcon,
    UsersIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import { isSelfHosted } from "src/core/utils/self-hosted";
import { useHasAiKey } from "src/features/ee/subscription/_hooks/use-has-ai-key";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";
import {
    PLAN_BAR_TONE,
    PLAN_BORDER_TONE,
    PLAN_CHIP_TONE,
    type PlanTone,
} from "src/features/ee/subscription/_utils/plan-tone";

// Same keyboard ring and pressed step as the rest of the rail.
const CONTROL_STATES =
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-card-lv3 link-focused:no-underline";

const HREF = "/settings/subscription";
// Out of free trial reviews, a plan doesn't bring them back — the trial runs
// on until it ends. A key of their own does, unlimited on any plan (the same
// way out the exhausted banner offers).
const BYOK_HREF = "/byok";

// Tones are shared with the subscription page (plan-tone.ts), so the panel
// and the page it opens read as one system.
type Tone = PlanTone;

const CHIP_TONES = PLAN_CHIP_TONE;
const BAR_TONES = PLAN_BAR_TONE;
// A danger panel also fills, like the banner: reviews have stopped.
const PANEL_TONES: Record<Tone, string> = {
    ...PLAN_BORDER_TONE,
    danger: `${PLAN_BORDER_TONE.danger} bg-danger/10 hover:bg-danger/15`,
};

const daysLabel = (days: number) =>
    days <= 0 ? "Ends today" : `${days} day${days === 1 ? "" : "s"} left`;

type Seats = { used: number; total: number };

const seatsFrom = (
    total: number | undefined,
    users: Array<unknown> | undefined,
): Seats | undefined =>
    typeof total === "number" && total > 0
        ? { used: users?.length ?? 0, total }
        : undefined;

/**
 * The plan, at the foot of the sidebar: which tier the organization is on,
 * and the one fact about it worth a glance — days and free reviews left in a
 * trial, seats in use on a paid plan, the license clock on self-hosted
 * Enterprise, or what to do when nothing is active. Collapsed, a tile in the
 * tier's tone keeps it, with the rest in a tooltip.
 */
export const SidebarPlanStatus = ({ collapsed }: { collapsed: boolean }) => {
    const subscription = useSubscriptionStatus();
    const hasKey = useHasAiKey();

    switch (subscription.status) {
        case "trial-active":
        case "trial-expiring":
        case "trial-exhausted": {
            const { trialDaysLeft, byok, trialReviewCredits } = subscription;
            const remaining = trialReviewCredits?.remaining;
            const total = trialReviewCredits?.total;
            const daysLeft = Math.max(trialDaysLeft, 0);
            const expiring = subscription.status === "trial-expiring";
            const exhausted = subscription.status === "trial-exhausted";
            const reviewsLabel = byok
                ? "BYOK · unlimited reviews"
                : exhausted
                  ? "Free reviews used up"
                  : typeof remaining === "number"
                    ? `${remaining}${typeof total === "number" ? ` of ${total}` : ""} free reviews left`
                    : undefined;
            // The bar drains as reviews are spent, matching "N left": a bar
            // of what was used read as nearly full when almost none remained.
            const remainingShare =
                !byok &&
                typeof remaining === "number" &&
                typeof total === "number" &&
                total > 0
                    ? remaining / total
                    : undefined;

            if (collapsed) {
                return (
                    <RailStatus
                        tone="primary"
                        href={exhausted ? BYOK_HREF : HREF}
                        label={`Trial · ${daysLabel(daysLeft)}${reviewsLabel ? ` · ${reviewsLabel}` : ""}${exhausted ? " · connect your AI key" : ""}`}>
                        <span
                            className={cn(
                                "text-[11px] font-semibold tabular-nums",
                                exhausted
                                    ? "text-alert"
                                    : expiring && "text-warning",
                            )}>
                            {daysLeft}d
                        </span>
                    </RailStatus>
                );
            }

            return (
                <PlanPanel
                    tone="primary"
                    href={exhausted ? BYOK_HREF : HREF}
                    chip="Trial"
                    meta={daysLabel(daysLeft)}
                    metaClassName={
                        expiring ? "text-warning font-semibold" : undefined
                    }>
                    {/* Used up, the empty track only restates the line below. */}
                    {remainingShare !== undefined && !exhausted && (
                        <Meter share={remainingShare} tone="primary" />
                    )}
                    {reviewsLabel && (
                        <Note
                            className={cn(
                                byok && "text-success",
                                exhausted && "text-alert font-medium",
                            )}>
                            {reviewsLabel}
                        </Note>
                    )}
                    {exhausted ? (
                        <Action>Connect your AI key</Action>
                    ) : (
                        expiring && <Action>Choose a plan</Action>
                    )}
                </PlanPanel>
            );
        }

        // Free reviews only on a key of the org's own: without one nothing
        // runs, so connecting it comes before any plan.
        case "free":
            return collapsed ? (
                <RailStatus
                    tone="neutral"
                    href={hasKey ? HREF : BYOK_HREF}
                    label={
                        hasKey
                            ? "Free plan · upgrade"
                            : "Free plan · no AI key · connect one"
                    }>
                    {hasKey ? (
                        <SparklesIcon className="text-primary-light size-4" />
                    ) : (
                        <KeyRoundIcon className="text-alert size-4" />
                    )}
                </RailStatus>
            ) : (
                <PlanPanel
                    tone="neutral"
                    href={hasKey ? HREF : BYOK_HREF}
                    chip="Free"
                    meta="BYOK">
                    {!hasKey && (
                        <Note className="text-alert">No AI key connected.</Note>
                    )}
                    <Action>
                        {hasKey ? "Upgrade plan" : "Connect your AI key"}
                    </Action>
                </PlanPanel>
            );

        // Not Free: billing keeps a canceled license invalid (only a trial
        // that ends is moved to Free, and billing never sets "expired"), and
        // the review gate refuses an invalid license — so reviews stop.
        case "canceled":
        case "expired": {
            // Self-hosted "expired" is the license key's (the license
            // service's answer to an expired key), fixed on the license page.
            if (isSelfHosted && subscription.status === "expired") {
                return collapsed ? (
                    <RailStatus
                        tone="danger"
                        label="Enterprise · self-hosted · License expired">
                        <ServerIcon className="size-4" />
                    </RailStatus>
                ) : (
                    <PlanPanel
                        tone="danger"
                        chip="License expired"
                        meta={<SelfHostedMeta />}>
                        <Note className="text-text-secondary">
                            Paste a renewed key to keep Enterprise.
                        </Note>
                    </PlanPanel>
                );
            }

            // Same split as the subscription page: an expiry with no Stripe
            // customer behind it was a trial, not a paid plan.
            const chip =
                subscription.status === "canceled"
                    ? "Canceled"
                    : subscription.stripeCustomerId?.trim()
                      ? "Expired"
                      : "Trial ended";

            return collapsed ? (
                <RailStatus
                    tone="danger"
                    label={`${chip} · reviews paused · choose a plan`}>
                    <CirclePauseIcon className="size-4" />
                </RailStatus>
            ) : (
                <PlanPanel tone="danger" chip={chip}>
                    <Note className="text-text-secondary">
                        Reviews are paused.
                    </Note>
                    <Action>Choose a plan</Action>
                </PlanPanel>
            );
        }

        // Billing has no license for the org (its trial was never
        // provisioned): no plan, and reviews don't run without one.
        case "no-license":
            return collapsed ? (
                <RailStatus tone="neutral" label="No plan · choose a plan">
                    <SparklesIcon className="text-primary-light size-4" />
                </RailStatus>
            ) : (
                <PlanPanel tone="neutral" chip="No plan">
                    <Action>Choose a plan</Action>
                </PlanPanel>
            );

        // What the layout falls back to when billing didn't answer: the plan
        // is unknown, not gone, so no "choose a plan" (the banner says it).
        case "inactive":
            return collapsed ? (
                <RailStatus
                    tone="neutral"
                    label="Plan not confirmed · billing didn't answer">
                    <CloudOffIcon className="size-4" />
                </RailStatus>
            ) : (
                <PlanPanel tone="neutral" chip="Unconfirmed">
                    <Note>Billing didn&apos;t answer.</Note>
                </PlanPanel>
            );

        case "payment-failed":
            return collapsed ? (
                <RailStatus
                    tone="danger"
                    label="Payment failed · update billing">
                    <AlertTriangleIcon className="size-4" />
                </RailStatus>
            ) : (
                // Red like the banner: reviews stop until it's fixed.
                <PlanPanel tone="danger" chip="Payment failed">
                    <Note className="text-text-secondary">
                        Update billing to keep reviews running.
                    </Note>
                </PlanPanel>
            );

        case "active": {
            const enterprise = subscription.planType.startsWith("enterprise");
            const tier = enterprise ? "Enterprise" : "Teams";
            const tone = enterprise ? "info" : "secondary";
            const seats = seatsFrom(
                subscription.numberOfLicenses,
                subscription.usersWithAssignedLicense,
            );
            const billing = subscription.byok ? "BYOK" : "Managed";

            return collapsed ? (
                <RailStatus
                    tone={tone}
                    label={`${tier} plan · ${billing}${seats ? ` · ${seats.used} of ${seats.total} seats in use` : ""}`}>
                    {enterprise ? (
                        <Building2Icon className="size-4" />
                    ) : (
                        <UsersIcon className="size-4" />
                    )}
                </RailStatus>
            ) : (
                <PlanPanel tone={tone} chip={tier} meta={billing}>
                    {seats && <SeatsLine seats={seats} tone={tone} />}
                </PlanPanel>
            );
        }

        case "self-hosted":
            return collapsed ? (
                <RailStatus tone="neutral" label="Community · self-hosted">
                    <ServerIcon className="size-4" />
                </RailStatus>
            ) : (
                <PlanPanel
                    tone="neutral"
                    chip="Community"
                    meta={<SelfHostedMeta />}
                />
            );

        case "licensed-self-hosted": {
            const seats = seatsFrom(
                subscription.numberOfLicenses,
                subscription.usersWithAssignedLicense,
            );
            const days = subscription.daysRemaining;
            const licenseLabel =
                typeof days !== "number"
                    ? undefined
                    : days <= 0
                      ? "License expired"
                      : `License · ${days} day${days === 1 ? "" : "s"} left`;
            // A month out is when renewing needs someone's attention.
            const licenseTone =
                typeof days !== "number"
                    ? undefined
                    : days <= 0
                      ? "text-danger font-medium"
                      : days <= 30
                        ? "text-warning font-medium"
                        : undefined;

            return collapsed ? (
                <RailStatus
                    tone={
                        typeof days === "number" && days <= 0
                            ? "danger"
                            : "info"
                    }
                    label={`Enterprise · self-hosted${licenseLabel ? ` · ${licenseLabel}` : ""}`}>
                    <ServerIcon className="size-4" />
                </RailStatus>
            ) : (
                <PlanPanel
                    tone={
                        typeof days === "number" && days <= 0
                            ? "danger"
                            : "info"
                    }
                    chip={
                        typeof days === "number" && days <= 0
                            ? "License expired"
                            : "Enterprise"
                    }
                    meta={<SelfHostedMeta />}>
                    {seats && <SeatsLine seats={seats} tone="info" />}
                    {/* Expired, the chip already says so: the line says what
                        to do instead. */}
                    {licenseLabel &&
                        (typeof days === "number" && days <= 0 ? (
                            <Note className="text-text-secondary">
                                Paste a renewed key to keep Enterprise.
                            </Note>
                        ) : (
                            <Note className={licenseTone}>{licenseLabel}</Note>
                        ))}
                </PlanPanel>
            );
        }

        default:
            return null;
    }
};

const PlanPanel = ({
    tone,
    href = HREF,
    chip,
    meta,
    metaClassName,
    children,
}: React.PropsWithChildren<{
    tone: Tone;
    href?: string;
    chip: string;
    meta?: React.ReactNode;
    metaClassName?: string;
}>) => (
    <Link
        href={href}
        noHoverUnderline
        className={cn(
            "bg-card-lv2/40 hover:bg-card-lv2 text-text-primary flex w-full flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors",
            CONTROL_STATES,
            PANEL_TONES[tone],
        )}>
        <span className="flex min-w-0 items-center gap-2">
            <span
                className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap uppercase",
                    CHIP_TONES[tone],
                )}>
                {chip}
            </span>
            {meta && (
                <span
                    className={cn(
                        "text-text-secondary ml-auto flex min-w-0 items-center gap-1 truncate text-xs tabular-nums",
                        metaClassName,
                    )}>
                    {meta}
                </span>
            )}
        </span>
        {children}
    </Link>
);

const SelfHostedMeta = () => (
    <>
        <ServerIcon className="size-3.5 shrink-0" aria-hidden />
        Self-hosted
    </>
);

const Meter = ({
    share,
    tone,
    className,
}: {
    share: number;
    tone: Tone;
    className?: string;
}) => (
    <span
        className="bg-card-lv3 block h-1 overflow-hidden rounded-full"
        aria-hidden>
        <span
            className={cn(
                "block h-full rounded-full",
                BAR_TONES[tone],
                className,
            )}
            style={{ width: `${Math.min(1, Math.max(0, share)) * 100}%` }}
        />
    </span>
);

const SeatsLine = ({ seats, tone }: { seats: Seats; tone: Tone }) => (
    <>
        <Meter share={seats.used / seats.total} tone={tone} />
        <Note>
            {seats.used} of {seats.total} seats in use
        </Note>
    </>
);

const Note = ({
    className,
    children,
}: React.PropsWithChildren<{ className?: string }>) => (
    <span className={cn("text-text-tertiary text-[11px]", className)}>
        {children}
    </span>
);

// Reads as the panel's call to action; the whole panel is the link.
const Action = ({ children }: React.PropsWithChildren) => (
    <span className="text-primary-light flex items-center gap-1 text-xs font-medium">
        {children}
        <ArrowRightIcon className="size-3.5 shrink-0" aria-hidden />
    </span>
);

const RailStatus = ({
    tone,
    href = HREF,
    label,
    children,
}: React.PropsWithChildren<{ tone: Tone; href?: string; label: string }>) => (
    <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
            <Link
                href={href}
                noHoverUnderline
                aria-label={label}
                className={cn(
                    "flex size-9 items-center justify-center rounded-lg transition-[filter] hover:brightness-125",
                    CHIP_TONES[tone],
                    CONTROL_STATES,
                )}>
                {children}
            </Link>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64 text-xs">
            {label}
        </TooltipContent>
    </Tooltip>
);
