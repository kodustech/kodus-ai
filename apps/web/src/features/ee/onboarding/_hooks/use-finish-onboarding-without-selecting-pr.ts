import { useAsyncAction } from "@hooks/use-async-action";
import { finishOnboarding } from "@services/codeManagement/fetch";
import { useSuspenseGetBYOK } from "@services/organizationParameters/hooks";
import { waitFor } from "src/core/utils/helpers";
import { revalidateServerSideTag } from "src/core/utils/revalidate-server-side";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { startTeamTrial } from "../../subscription/_services/billing/fetch";

export const useFinishOnboardingWithoutSelectingPR = ({
    teamId,
    userId,
    organizationId,
}: {
    teamId: string;
    userId: string;
    organizationId: string;
}) => {
    const byokConfig = useSuspenseGetBYOK();
    const choseBYOK = !!byokConfig?.configValue?.main;

    const [
        finishOnboardingWithoutSelectingPR,
        { loading: isFinishingOnboardingWithoutSelectingPR },
    ] = useAsyncAction(async () => {
        try {
            const result = await finishOnboarding({ teamId, reviewPR: false });
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

            await waitFor(5000);

            window.location.href = "/settings/code-review";
        } catch (error) {
            console.error(
                "Error in finishOnboardingWithoutSelectingPR:",
                error,
            );
        }
    });

    return {
        finishOnboardingWithoutSelectingPR,
        isFinishingOnboardingWithoutSelectingPR,
    };
};
