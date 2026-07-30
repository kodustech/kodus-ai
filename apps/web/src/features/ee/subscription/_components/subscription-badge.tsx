"use client";

import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    AlertTriangle,
    CalendarClockIcon,
    GiftIcon,
    SparklesIcon,
} from "lucide-react";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

// Keep the pill label short; the full "what is this?" context lives in the
// tooltip so the navbar stays uncluttered but the meaning is one hover away.
const TrialBadge = ({
    children,
    variant,
    icon,
    tooltip,
}: {
    children: React.ReactNode;
    variant: React.ComponentProps<typeof Button>["variant"];
    icon?: React.ReactNode;
    tooltip: React.ReactNode;
}) => (
    <Tooltip>
        <TooltipTrigger asChild>
            <Button decorative size="sm" variant={variant} leftIcon={icon}>
                {children}
            </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64 text-xs">
            {tooltip}
        </TooltipContent>
    </Tooltip>
);

const TooltipRow = ({
    icon: Icon,
    label,
    value,
    iconTone,
    valueTone,
}: {
    icon: React.ElementType;
    label: string;
    value: string;
    iconTone?: string;
    valueTone?: string;
}) => (
    <div className="flex items-center gap-2">
        <Icon
            className={`size-3.5 shrink-0 ${iconTone ?? "text-text-tertiary"}`}
        />
        <span className="text-text-secondary">{label}</span>
        <span
            className={`ml-auto font-medium ${valueTone ?? "text-text-primary"}`}>
            {value}
        </span>
    </div>
);

// Plan-identity badge only ("which subscription am I on" — becomes the plan
// name after the trial). The trial detail (days left + review allowance) lives
// in the hover tooltip so the navbar stays a single, uncluttered pill.
const SubscriptionTrial = () => {
    const subscriptionStatus = useSubscriptionStatus();
    if (
        subscriptionStatus.status !== "trial-active" &&
        subscriptionStatus.status !== "trial-expiring" &&
        subscriptionStatus.status !== "trial-exhausted"
    ) {
        return null;
    }

    const { trialDaysLeft, byok, trialReviewCredits } = subscriptionStatus;
    const remaining = trialReviewCredits?.remaining;
    const total = trialReviewCredits?.total;

    // With BYOK the reviews are unlimited because the user pays their own AI
    // key — NOT because Kodus covers them. So drop the "free / on us" framing
    // and just call it "Reviews".
    const reviews = byok
        ? {
              icon: SparklesIcon,
              label: "Reviews",
              value: "BYOK · Unlimited",
              tone: "text-success",
          }
        : typeof remaining === "number"
          ? remaining === 0
              ? {
                    icon: AlertTriangle,
                    label: "Free reviews",
                    value: "Used up",
                    tone: "text-alert",
                }
              : {
                    icon: GiftIcon,
                    label: "Free reviews",
                    value: `${remaining}${
                        typeof total === "number" ? ` of ${total}` : ""
                    }`,
                    tone: "text-text-primary",
                }
          : null;

    return (
        <TrialBadge
            variant="secondary"
            tooltip={
                <div className="flex w-44 flex-col gap-2">
                    <TooltipRow
                        icon={CalendarClockIcon}
                        label="Trial"
                        value={`${trialDaysLeft}d left`}
                    />
                    {reviews && (
                        <TooltipRow
                            icon={reviews.icon}
                            iconTone={reviews.tone}
                            label={reviews.label}
                            value={reviews.value}
                            valueTone={reviews.tone}
                        />
                    )}
                    {!byok && (
                        <p className="border-card-lv3 text-text-tertiary border-t pt-2 leading-snug">
                            Connect your AI key for unlimited reviews.
                        </p>
                    )}
                </div>
            }>
            Team trial
        </TrialBadge>
    );
};

const SubscriptionUpgrade = () => {
    return (
        <Button decorative size="sm" variant="primary-dark">
            Upgrade Subscription
        </Button>
    );
};

const SubscriptionActive = () => {
    return (
        <Button decorative size="sm" variant="secondary">
            Teams Plan
        </Button>
    );
};

const SubscriptionPaymentFailed = () => {
    return (
        <Button
            decorative
            size="sm"
            leftIcon={<AlertTriangle />}
            variant="tertiary">
            Payment failed
        </Button>
    );
};

const SubscriptionSelfHosted = () => {
    return (
        <Button decorative size="sm" variant="tertiary">
            Self-hosted
        </Button>
    );
};

const SubscriptionLicensedSelfHosted = () => {
    return (
        <Button decorative size="sm" variant="secondary">
            Self-hosted Enterprise
        </Button>
    );
};

const components: Partial<
    Record<
        ReturnType<typeof useSubscriptionStatus>["status"],
        React.ComponentType
    >
> = {
    "active": SubscriptionActive,
    "trial-active": SubscriptionTrial,
    "trial-expiring": SubscriptionTrial,
    "trial-exhausted": SubscriptionTrial,
    "free": SubscriptionUpgrade,
    "canceled": SubscriptionUpgrade,
    "payment-failed": SubscriptionPaymentFailed,
    "self-hosted": SubscriptionSelfHosted,
    "licensed-self-hosted": SubscriptionLicensedSelfHosted,
};

export const SubscriptionBadge = () => {
    const { status } = useSubscriptionStatus();
    const Component = components[status];

    if (!Component) return null;
    return (
        <Link href="/settings/subscription">
            <Component />
        </Link>
    );
};
