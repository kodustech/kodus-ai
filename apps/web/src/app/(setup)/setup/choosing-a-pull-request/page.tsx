"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { redirect } from "next/navigation";
import { SelectPullRequest } from "@components/system/select-pull-requests";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Link } from "@components/ui/link";
import { MagicModalContext } from "@components/ui/magic-modal";
import { Page } from "@components/ui/page";
import { useSuspenseGetOnboardingPullRequests } from "@services/codeManagement/hooks";
import { useSuspenseGetBYOK } from "@services/organizationParameters/hooks";
import { useSuspenseGetParameterPlatformConfigs } from "@services/parameters/hooks";
import { useSuspenseGetOrganizationId } from "@services/setup/hooks";
import { InfoIcon, PartyPopperIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useFinishOnboardingReviewingPR } from "src/features/ee/onboarding/_hooks/use-finish-onboarding-reviewing-pr";
import { useFinishOnboardingWithoutSelectingPR } from "src/features/ee/onboarding/_hooks/use-finish-onboarding-without-selecting-pr";
import {
    TRIAL_DAYS,
    TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED,
} from "src/features/ee/subscription/_constants/trial";

type PullRequestOption = ComponentProps<typeof SelectPullRequest>["value"];

export default function App() {
    const { userId } = useAuth();

    const { teamId } = useSelectedTeamId();

    const { configValue } = useSuspenseGetParameterPlatformConfigs(teamId);
    if (configValue?.finishOnboard) redirect("/");

    const pullRequests = useSuspenseGetOnboardingPullRequests(teamId);
    const organizationId = useSuspenseGetOrganizationId();
    const byokConfig = useSuspenseGetBYOK();
    const hasBYOK = !!byokConfig?.configValue?.main;

    const [open, setOpen] = useState(false);
    const [selectedPR, setSelectedPR] = useState<PullRequestOption>(
        pullRequests.length === 1 ? pullRequests[0] : undefined,
    );

    const [requestedPullRequestReview, setRequestedPullRequestReview] =
        useState(false);

    const {
        finishOnboardingWithoutSelectingPR,
        isFinishingOnboardingWithoutSelectingPR,
    } = useFinishOnboardingWithoutSelectingPR({
        organizationId,
        teamId,
        userId: userId!,
    });

    const { finishOnboardingReviewingPR, isFinishingOnboardingReviewingPR } =
        useFinishOnboardingReviewingPR({
            organizationId,
            teamId,
            userId: userId!,
            onSuccess: () => {
                setRequestedPullRequestReview(true);
            },
        });

    const shouldSkipPullRequestSelection = pullRequests.length === 0;
    const autoFinishRequestedRef = useRef(false);

    useEffect(() => {
        if (!shouldSkipPullRequestSelection || autoFinishRequestedRef.current) {
            return;
        }

        autoFinishRequestedRef.current = true;
        finishOnboardingWithoutSelectingPR();
    }, [shouldSkipPullRequestSelection, finishOnboardingWithoutSelectingPR]);

    if (shouldSkipPullRequestSelection) return null;

    return (
        <Page.Root className="flex min-h-full w-full flex-col items-center py-20">
            <MagicModalContext.Provider value={{ closeable: false }}>
                <Dialog open>
                    <DialogContent className="gap-0 p-10">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <PartyPopperIcon className="text-primary-light size-6" />
                                Kody is ready for your first PR review
                            </DialogTitle>

                            <DialogDescription className="mt-4">
                                From now on, I’ll automatically review every PR
                                you open in your selected repositories.
                            </DialogDescription>
                            <DialogDescription className="mb-4">
                                <strong className="text-white">
                                    Want to see it in action?
                                </strong>{" "}
                                Pick a PR for an instant review—or skip and let
                                automation handle the next ones.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="flex flex-1 flex-col gap-4">
                            {requestedPullRequestReview ? (
                                <>
                                    <Alert variant="success">
                                        <AlertTitle>
                                            Review requested
                                        </AlertTitle>
                                        <AlertDescription className="mb-4">
                                            Soon it will be ready in your PR:
                                        </AlertDescription>

                                        <Link
                                            href={selectedPR?.url ?? ""}
                                            className="wrap-anywhere">
                                            {selectedPR?.url}
                                        </Link>
                                    </Alert>

                                    <p className="text-center text-sm">
                                        Redirecting to dashboard...
                                    </p>
                                </>
                            ) : (
                                <>
                                    <Alert variant="info" className="mb-1">
                                        <InfoIcon />
                                        <AlertTitle>
                                            {hasBYOK
                                                ? "This review uses your AI key"
                                                : `Your first ${TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED} PR reviews are on us`}
                                        </AlertTitle>
                                        <AlertDescription>
                                            {hasBYOK ? (
                                                <p>
                                                    Your AI key is connected, so
                                                    this review runs on your key
                                                    — unlimited, and it doesn't
                                                    use your trial reviews.
                                                </p>
                                            ) : (
                                                <p>
                                                    During your {TRIAL_DAYS}-day
                                                    trial, this review uses 1 of
                                                    the{" "}
                                                    {
                                                        TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED
                                                    }{" "}
                                                    we cover for you. After
                                                    that, connect your AI key
                                                    for unlimited reviews (free,
                                                    on any plan).
                                                </p>
                                            )}
                                        </AlertDescription>
                                    </Alert>

                                    <FormControl.Root>
                                        <FormControl.Label htmlFor="select-pull-request">
                                            Select a PR to review
                                        </FormControl.Label>

                                        <FormControl.Input>
                                            <SelectPullRequest
                                                pullRequests={pullRequests}
                                                disabled={
                                                    requestedPullRequestReview ||
                                                    isFinishingOnboardingWithoutSelectingPR ||
                                                    isFinishingOnboardingReviewingPR
                                                }
                                                open={open}
                                                onOpenChange={setOpen}
                                                value={selectedPR}
                                                onChange={(v) => {
                                                    setSelectedPR(v);
                                                    setOpen(false);
                                                }}
                                            />
                                        </FormControl.Input>
                                    </FormControl.Root>

                                    <div className="mt-1 -mb-3 flex flex-row items-center justify-between gap-3">
                                        <Button
                                            size="lg"
                                            variant="tertiary"
                                            disabled={
                                                isFinishingOnboardingWithoutSelectingPR
                                            }
                                            loading={
                                                isFinishingOnboardingWithoutSelectingPR
                                            }
                                            onClick={() =>
                                                finishOnboardingWithoutSelectingPR()
                                            }>
                                            Skip for now
                                        </Button>

                                        <Button
                                            size="lg"
                                            variant="primary"
                                            disabled={
                                                !selectedPR ||
                                                requestedPullRequestReview ||
                                                isFinishingOnboardingWithoutSelectingPR
                                            }
                                            onClick={() =>
                                                finishOnboardingReviewingPR(
                                                    selectedPR,
                                                )
                                            }
                                            loading={
                                                isFinishingOnboardingReviewingPR
                                            }>
                                            Review now
                                        </Button>
                                    </div>
                                </>
                            )}
                        </div>
                    </DialogContent>
                </Dialog>
            </MagicModalContext.Provider>
        </Page.Root>
    );
}
