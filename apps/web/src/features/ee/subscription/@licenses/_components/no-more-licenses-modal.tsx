import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { magicModal } from "@components/ui/magic-modal";
import { useAsyncAction } from "@hooks/use-async-action";
import { CircleDollarSign } from "lucide-react";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { createManageBillingLinkAction } from "../../_actions/create-manage-billing-link";

export const NoMoreLicensesModal = ({
    teamId,
    seats,
}: {
    teamId: string;
    seats: number;
}) => {
    const [
        createLinkToManageBilling,
        { loading: isCreatingLinkToManageBilling },
    ] = useAsyncAction(async () => {
        const { url } = await createManageBillingLinkAction({ teamId });
        window.location.href = url;
    });

    // Self-hosted has no billing portal to send anyone to: its seats come
    // with the license key.
    if (isSelfHosted) {
        return (
            <Dialog open onOpenChange={() => magicModal.hide()}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>No seats left</DialogTitle>
                    </DialogHeader>

                    <div className="text-text-secondary flex flex-col gap-6 text-sm">
                        Your license covers {seats}{" "}
                        {seats === 1 ? "seat" : "seats"}, and every one is
                        assigned. Turn off someone&apos;s seat to free it, or
                        ask Kodus for a key with more seats and paste it under
                        &quot;Update the license key&quot;.
                    </div>

                    <DialogFooter>
                        <Button
                            size="md"
                            variant="primary"
                            onClick={() => magicModal.hide()}>
                            Got it
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>You need more licenses</DialogTitle>
                </DialogHeader>

                <div className="text-text-secondary flex flex-col gap-6 text-sm">
                    Update your plan licences to assign more devs.
                </div>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => magicModal.hide()}>
                        Cancel
                    </Button>

                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<CircleDollarSign />}
                        loading={isCreatingLinkToManageBilling}
                        onClick={() => createLinkToManageBilling()}>
                        Manage licenses
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
