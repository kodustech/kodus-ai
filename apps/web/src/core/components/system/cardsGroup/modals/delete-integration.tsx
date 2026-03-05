import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";

type DeleteIntegrationModalProps = {
    title: string;
    onConfirm: () => void;
    onCancel: () => void;
};

export const DeleteIntegrationModal = ({
    title,
    onConfirm,
    onCancel,
}: DeleteIntegrationModalProps) => {
    return (
        <Dialog open onOpenChange={onCancel}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Delete {title} integration</DialogTitle>
                    <DialogDescription>
                        Are you sure you want to delete this integration? This
                        action cannot be undone.
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter>
                    <Button size="md" variant="cancel" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button size="md" variant="tertiary" onClick={onConfirm}>
                        Delete
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
