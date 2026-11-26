"use client";

import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { InfoIcon } from "lucide-react";
import { pluralize } from "src/core/utils/string";

import { useTrialTerms } from "../_hooks/use-trial-terms";

/**
 * The onboarding promise of Kodus-paid trial reviews, with the numbers
 * billing configures for a trial started now (GET /trial-terms).
 *
 * Renders nothing while the terms load, when there are none (self-hosted,
 * an older billing, billing unreachable after retries) and when the trial
 * includes no Kodus-paid reviews: there is nothing true to promise then.
 */
export const TrialTermsAlert = ({
    variant,
    className,
}: {
    /** "repositories": the setup step before any review. "pull-request":
     *  the step that starts the first review. */
    variant: "repositories" | "pull-request";
    className?: string;
}) => {
    const terms = useTrialTerms();
    if (!terms || terms.trialReviewCreditsIncluded <= 0) return null;

    const { trialDays, trialReviewCreditsIncluded: reviews } = terms;
    const covered =
        reviews === 1 ? "first PR review" : `first ${reviews} PR reviews`;
    const during =
        variant === "pull-request"
            ? reviews === 1
                ? `During your ${trialDays}-day trial, this review is the one we cover for you.`
                : `During your ${trialDays}-day trial, this review uses 1 of the ${reviews} we cover for you.`
            : `During your ${trialDays}-day trial we cover your ${covered} — no AI key needed.`;

    return (
        <Alert variant="info" className={className}>
            <InfoIcon />
            <AlertTitle>
                Your {covered}{" "}
                {pluralize(reviews, { singular: "is", plural: "are" })} on us
            </AlertTitle>
            <AlertDescription>
                <p>
                    {during} After that, connect your AI key for unlimited
                    reviews (free, on any plan).
                </p>
            </AlertDescription>
        </Alert>
    );
};
