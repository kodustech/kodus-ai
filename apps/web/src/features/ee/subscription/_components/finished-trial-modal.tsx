"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Link } from "@components/ui/link";
import { MagicModalContext } from "@components/ui/magic-modal";
import { useConfig } from "@providers/ConfigProvider";
import { ClientSideCookieHelpers } from "src/core/utils/cookie";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

export const FinishedTrialModal = () => {
    const router = useRouter();
    const cfg = useConfig();
    const subscription = useSubscriptionStatus();

    if (subscription.status !== "expired") return null;

    const cookie = ClientSideCookieHelpers("trial-finished-modal-closed");
    if (cookie.has()) return null;

    return (
        <MagicModalContext.Provider value={{ closeable: false }}>
            <Dialog open>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Your PRO Trial has ended...</DialogTitle>
                    </DialogHeader>

                    <div className="text-text-secondary flex flex-col gap-2 text-sm">
                        <p>
                            Your subscription will be downgraded to Basic and
                            Kody won't work at its maximum.
                        </p>

                        <p>
                            You can still Upgrade subscription or{" "}
                            <Link
                                target="_blank"
                                href={cfg.supportTalkToFounderUrl || ""}>
                                talk with our team
                            </Link>{" "}
                            to ask questions or extend trial.
                        </p>
                    </div>

                    <DialogFooter>
                        <Button
                            size="md"
                            variant="cancel"
                            onClick={() => {
                                cookie.set("true");
                                router.refresh();
                            }}>
                            Stop using Kody
                        </Button>

                        <Button
                            size="md"
                            variant="primary"
                            onClick={() => {
                                cookie.set("true");
                                router.push("/choose-plan");
                            }}>
                            Upgrade subscription
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </MagicModalContext.Provider>
    );
};
