import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";

type ConfirmModalProps = {
    open: boolean;
    title: string;
    description: string;
    confirmText: string;
    cancelText?: string;
    variant?: "primary" | "tertiary" | "primary-dark" | "secondary" | "helper";
    loading?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
};

export const ConfirmModal = ({
    open,
    title,
    description,
    confirmText,
    cancelText = "Cancel",
    variant = "tertiary",
    loading = false,
    onConfirm,
    onCancel,
}: ConfirmModalProps) => {
    return (
        <Dialog open={open} onOpenChange={onCancel}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={onCancel}
                        disabled={loading}>
                        {cancelText}
                    </Button>
                    <Button
                        size="md"
                        variant={variant}
                        loading={loading}
                        disabled={loading}
                        onClick={onConfirm}>
                        {confirmText}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
