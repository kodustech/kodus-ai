import { useAsyncAction } from "@hooks/use-async-action";
import { finishOnboarding } from "@services/codeManagement/fetch";
import { useSuspenseGetBYOK } from "@services/organizationParameters/hooks";
import { waitFor } from "src/core/utils/helpers";
import { revalidateServerSideTag } from "src/core/utils/revalidate-server-side";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { startTeamTrial } from "../../subscription/_services/billing/fetch";

type SelectedPR = {
    id: string;
    pull_number: number;
    repository: string;
    repositoryId: string;
    title: string;
    url: string;
};

export const useFinishOnboardingReviewingPR = ({
    teamId,
    userId,
    organizationId,
    onSuccess,
}: {
    teamId: string;
    userId: string;
    organizationId: string;
    onSuccess: () => void;
}) => {
    const byokConfig = useSuspenseGetBYOK();
    const choseBYOK = !!byokConfig?.configValue?.main;

    const [
        finishOnboardingReviewingPR,
        { loading: isFinishingOnboardingReviewingPR },
    ] = useAsyncAction(async (selectedPR: SelectedPR | undefined) => {
        if (!selectedPR) {
            return;
        }

        try {
            const result = await finishOnboarding({
                teamId,
                reviewPR: true,
                repositoryId: selectedPR.repositoryId,
                repositoryName: selectedPR.repository,
                pullNumber: selectedPR.pull_number,
            });
            await revalidateServerSideTag("team-dependent");

            if (!isSelfHosted) {
                // Trial creation is best-effort — backend onboarding is
                // already committed at this point. A billing hiccup must
                // not strand the user on the onboarding screen.
                try {
                    await startTeamTrial({
                        teamId,
                        organizationId,
                        byok: choseBYOK,
                    });
                } catch (trialError) {
                    console.error(
                        "startTeamTrial failed (non-fatal, continuing):",
                        trialError,
                    );
                }
            }

            onSuccess();

            await waitFor(5000);

            // using this because next.js router is causing an error, probably related to https://github.com/vercel/next.js/issues/63121
            window.location.href = "/settings/code-review";
        } catch (error) {
            console.error("Error in finishOnboardingReviewingPR:", error);
        }
    });

    return {
        finishOnboardingReviewingPR,
        isFinishingOnboardingReviewingPR,
    };
};
