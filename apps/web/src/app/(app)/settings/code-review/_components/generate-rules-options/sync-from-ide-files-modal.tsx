import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { InlineCode } from "@components/ui/inline-code";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { useEffectOnce } from "@hooks/use-effect-once";
import { ClockFadingIcon, RefreshCwIcon } from "lucide-react";

export const SyncFromIDEFilesFirstTimeModal = () => {
    useEffectOnce(() => magicModal.lock());

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Sync repository rules now?</DialogTitle>

                    <DialogDescription>
                        Kody will look for rule files in this repo and import
                        them into Kody Rules.
                    </DialogDescription>
                </DialogHeader>

                <div className="text-text-secondary text-sm">
                    <span>What happens:</span>

                    <ul className="list-disc pl-5">
                        <li>
                            Scan the repo for rule files{" "}
                            <InlineCode className="bg-card-lv1">
                                (e.g. .cursorrules, CLAUDE.md)
                            </InlineCode>
                        </li>
                        <li>
                            Import any of these files found into your workspace
                        </li>
                        <li>Keep them in sync from now on</li>
                    </ul>
                </div>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        leftIcon={<ClockFadingIcon />}
                        onClick={() => magicModal.hide()}>
                        Skip initial scan
                    </Button>

                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<RefreshCwIcon />}
                        onClick={() => {
                            toast({
                                variant: "info",
                                title: "We're searching your repository for rules files",
                                description: (
                                    <>
                                        <p>This may take a few minutes.</p>
                                        <p>
                                            Generated rules will be listed in
                                            this page.
                                        </p>
                                    </>
                                ),
                            });

                            magicModal.hide(true);
                        }}>
                        Sync now
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
