"use client";

/* Hallmark · component: plan status (sidebar foot) · genre: modern-minimal · theme: system-tokens
 * states: trial · trial-expiring · trial-exhausted · free/canceled · payment-failed · plan identity · rail glyph
 * contrast: pass (40–41) · tokens: pass (48) · honest: pass (46, values from billing only)
 */
import { Link } from "@components/ui/link";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    AlertTriangleIcon,
    CalendarClockIcon,
    CreditCardIcon,
    ServerIcon,
    SparklesIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

// Same keyboard ring and pressed step as the rest of the rail.
const CONTROL_STATES =
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-card-lv3 link-focused:no-underline";

const HREF = "/settings/subscription";

/**
 * The plan, at the foot of the sidebar navigation. The top bar squeezes it
 * into one pill with the trial detail behind a hover; the rail has the room
 * to say it outright — days left and free reviews — and a plan-identity
 * label like "Self-hosted Enterprise" no longer has to fit beside the logo.
 * Collapsed, only the states that ask for action keep a glyph.
 */
export const SidebarPlanStatus = ({ collapsed }: { collapsed: boolean }) => {
    const subscription = useSubscriptionStatus();

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
            const daysLabel = `${daysLeft}d left`;
            const reviewsLabel = byok
                ? "BYOK · unlimited reviews"
                : exhausted
                  ? "Free reviews used up"
                  : typeof remaining === "number"
                    ? `${remaining}${typeof total === "number" ? ` of ${total}` : ""} free reviews left`
                    : undefined;

            if (collapsed) {
                return (
                    <RailStatus
                        label={`Team trial · ${daysLabel}${reviewsLabel ? ` · ${reviewsLabel}` : ""}`}>
                        <span
                            className={cn(
                                "text-[11px] font-semibold tabular-nums",
                                exhausted
                                    ? "text-alert"
                                    : expiring
                                      ? "text-warning"
                                      : "text-text-primary",
                            )}>
                            {daysLeft}d
                        </span>
                    </RailStatus>
                );
            }

            // The bar drains as reviews are spent, matching "N left": a bar
            // of what was used read as nearly full when almost none remained.
            const remainingShare =
                !byok &&
                typeof remaining === "number" &&
                typeof total === "number" &&
                total > 0
                    ? Math.min(1, Math.max(0, remaining / total))
                    : undefined;

            return (
                <Card>
                    <span className="flex items-center gap-2">
                        <CalendarClockIcon className="text-text-tertiary size-3.5 shrink-0" />
                        <span className="flex-1 text-xs font-semibold">
                            Team trial
                        </span>
                        <span
                            className={cn(
                                "text-xs tabular-nums",
                                expiring
                                    ? "text-warning font-semibold"
                                    : "text-text-secondary",
                            )}>
                            {daysLabel}
                        </span>
                    </span>
                    {remainingShare !== undefined && (
                        <span
                            className="bg-card-lv3 block h-1 overflow-hidden rounded-full"
                            aria-hidden>
                            <span
                                className={cn(
                                    "block h-full rounded-full",
                                    exhausted ? "bg-alert" : "bg-primary-light",
                                )}
                                style={{ width: `${remainingShare * 100}%` }}
                            />
                        </span>
                    )}
                    {reviewsLabel && (
                        <span
                            className={cn(
                                "text-[11px]",
                                byok
                                    ? "text-success"
                                    : exhausted
                                      ? "text-alert font-medium"
                                      : "text-text-tertiary",
                            )}>
                            {reviewsLabel}
                        </span>
                    )}
                </Card>
            );
        }

        case "free":
        case "canceled":
            return collapsed ? (
                <RailStatus label="Upgrade subscription">
                    <SparklesIcon className="text-primary-light size-4" />
                </RailStatus>
            ) : (
                <Card className="border-primary-light/30 bg-primary-light/10 hover:bg-primary-light/15">
                    <span className="text-primary-light flex items-center gap-2 text-xs font-semibold">
                        <SparklesIcon className="size-3.5 shrink-0" />
                        Upgrade subscription
                    </span>
                </Card>
            );

        case "payment-failed":
            return collapsed ? (
                <RailStatus label="Payment failed · update billing">
                    <AlertTriangleIcon className="text-danger size-4" />
                </RailStatus>
            ) : (
                // Red like the top bar's badge: reviews stop until it's fixed.
                <Card className="border-danger/40 bg-danger/10 hover:bg-danger/15">
                    <span className="text-danger flex items-center gap-2 text-xs font-semibold">
                        <AlertTriangleIcon className="size-3.5 shrink-0" />
                        Payment failed
                    </span>
                    <span className="text-text-secondary text-[11px]">
                        Update billing to keep reviews running.
                    </span>
                </Card>
            );

        // Plan identity only: nothing to act on, so the rail leaves it out.
        case "active":
            return collapsed ? null : (
                <PlanIdentity
                    icon={CreditCardIcon}
                    label={
                        subscription.planType.startsWith("enterprise")
                            ? "Enterprise plan"
                            : "Teams plan"
                    }
                />
            );

        case "self-hosted":
            return collapsed ? null : (
                <PlanIdentity icon={ServerIcon} label="Self-hosted" />
            );

        case "licensed-self-hosted":
            return collapsed ? null : (
                <PlanIdentity
                    icon={ServerIcon}
                    label="Self-hosted Enterprise"
                    detail={
                        typeof subscription.daysRemaining === "number"
                            ? `${Math.max(subscription.daysRemaining, 0)}d left`
                            : undefined
                    }
                />
            );

        default:
            return null;
    }
};

const Card = ({
    className,
    children,
}: React.PropsWithChildren<{ className?: string }>) => (
    <Link
        href={HREF}
        noHoverUnderline
        className={cn(
            "border-card-lv3/60 hover:bg-card-lv2 text-text-primary flex w-full flex-col gap-1.5 rounded-lg border px-3 py-2.5 transition-colors",
            CONTROL_STATES,
            className,
        )}>
        {children}
    </Link>
);

const PlanIdentity = ({
    icon: Icon,
    label,
    detail,
}: {
    icon: React.ElementType;
    label: string;
    detail?: string;
}) => (
    <Link
        href={HREF}
        noHoverUnderline
        className={cn(
            "text-text-tertiary hover:text-text-secondary flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-xs transition-colors",
            CONTROL_STATES,
        )}>
        <Icon className="size-3.5 shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        {detail && <span className="tabular-nums">{detail}</span>}
    </Link>
);

const RailStatus = ({
    label,
    children,
}: React.PropsWithChildren<{ label: string }>) => (
    <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
            <Link
                href={HREF}
                noHoverUnderline
                aria-label={label}
                className={cn(
                    "bg-card-lv2 hover:bg-card-lv3 flex size-9 items-center justify-center rounded-lg transition-colors",
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
