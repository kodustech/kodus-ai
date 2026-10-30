import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { UserMinusIcon } from "lucide-react";

import { pruneRemovedSeats } from "../../_services/billing/fetch";

type PruneCandidate = {
    id: string;
    name: string;
};

export const PruneSeatsModal = ({
    teamId,
    candidates,
    onPruned,
}: {
    teamId: string;
    candidates: PruneCandidate[];
    onPruned: () => void;
}) => {
    const [prune, { loading: isPruning }] = useAsyncAction(async () => {
        try {
            const result = await pruneRemovedSeats({
                teamId,
                gitIds: candidates.map((candidate) => candidate.id),
            });

            if (result.status === "members_unavailable") {
                toast({
                    variant: "danger",
                    title: "Could not reach the code platform",
                    description:
                        "No seat was changed. Try again once the connection is back.",
                });
                return;
            }

            if (result.failed.length > 0) {
                toast({
                    variant: "warning",
                    title: `Released ${result.revoked.length} of ${result.candidates.length} seats`,
                    description: `${result.failed.length} could not be released.`,
                });
            } else {
                toast({
                    variant: "success",
                    title: `Released ${result.revoked.length} ${
                        result.revoked.length === 1 ? "seat" : "seats"
                    }`,
                });
            }

            magicModal.hide();
            onPruned();
        } catch {
            toast({
                variant: "danger",
                title: "Failed to release seats",
            });
        }
    });

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        Release {candidates.length}{" "}
                        {candidates.length === 1 ? "seat" : "seats"}?
                    </DialogTitle>
                </DialogHeader>

                <div className="text-text-secondary flex flex-col gap-4 text-sm">
                    <p>
                        These users still hold a license but are no longer in
                        your git organization. Releasing their seats frees them
                        for other members.
                    </p>

                    <ul className="border-card-lv2 max-h-56 overflow-y-auto rounded-lg border">
                        {candidates.map((candidate) => (
                            <li
                                key={candidate.id}
                                className="border-card-lv2 truncate border-b px-3 py-2 last:border-b-0">
                                {candidate.name}
                            </li>
                        ))}
                    </ul>
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
                        leftIcon={<UserMinusIcon />}
                        loading={isPruning}
                        onClick={() => prune()}>
                        Release seats
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
