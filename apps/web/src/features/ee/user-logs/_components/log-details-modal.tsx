"use client";

import { useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@components/ui/dialog";
import { Separator } from "@components/ui/separator";
import type { UserLog } from "@services/userLogs/types";
import { format } from "date-fns";
import { enUS } from "date-fns/locale";

interface LogDetailsModalProps {
    log: UserLog;
    children: React.ReactNode;
}

export const LogDetailsModal = ({ log, children }: LogDetailsModalProps) => {
    const [open, setOpen] = useState(false);

    const getActionColor = (action: string) => {
        switch (action) {
            case "add":
            case "create":
                return "bg-success/10 text-success ring-success/64 [--button-foreground:var(--color-success)]";
            case "edit":
                return "bg-info/10 text-info ring-info/64 [--button-foreground:var(--color-info)]";
            case "delete":
                return "bg-danger/10 text-danger ring-danger/64 [--button-foreground:var(--color-danger)]";
            case "clone":
                return "bg-warning/10 text-warning ring-warning/64 [--button-foreground:var(--color-warning)]";
            default:
                return "bg-alert/10 text-alert ring-alert/64 [--button-foreground:var(--color-alert)]";
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>{children}</DialogTrigger>
            <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Badge
                            className={`h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 ${getActionColor(log._action)}`}>
                            {log._action}
                        </Badge>
                        Log Details
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-6">
                    <div>
                        <h4 className="mt-5 mb-4 font-bold">
                            Basic Information
                        </h4>
                        <div className="flex flex-col gap-2 space-y-2 text-sm">
                            <div className="border-b-card-lv2 flex justify-between border-b-1 pb-2">
                                <span className="text-muted-foreground font-semibold">
                                    User
                                </span>
                                <span className="font-medium">
                                    {log._userInfo.userEmail}
                                </span>
                            </div>
                            <div className="border-b-card-lv2 flex justify-between border-b-1 pb-2 align-middle">
                                <span className="text-muted-foreground font-semibold">
                                    Level
                                </span>
                                <Badge variant="helper" className="capitalize">
                                    {log._configLevel}
                                </Badge>
                            </div>
                            <div className="border-b-card-lv2 flex justify-between border-b-1 pb-2">
                                <span className="text-muted-foreground font-semibold">
                                    Created
                                </span>
                                <span>
                                    {format(
                                        new Date(log._createdAt),
                                        "PPP 'at' p",
                                        { locale: enUS },
                                    )}
                                </span>
                            </div>
                            <div className="border-b-card-lv2 flex justify-between border-b-1 pb-2">
                                <span className="text-muted-foreground font-semibold">
                                    Updated
                                </span>
                                <span>
                                    {format(
                                        new Date(log._updatedAt),
                                        "PPP 'at' p",
                                        { locale: enUS },
                                    )}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div>
                        <h4 className="mb-3 font-bold">Changes</h4>
                        <div className="space-y-4">
                            {log._changedData.map((change, index) => (
                                <div
                                    key={index}
                                    className="space-y-3 rounded-lg border p-4">
                                    <div className="helper-center flex gap-2">
                                        <Badge variant="helper">
                                            {change.actionDescription}
                                        </Badge>
                                    </div>

                                    <div>
                                        <p className="text-muted-foreground mb-2 text-sm font-semibold">
                                            Description
                                        </p>
                                        <p className="text-sm">
                                            {change.description}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="flex justify-end">
                        <Button
                            variant="helper"
                            size="md"
                            onClick={() => setOpen(false)}>
                            Close
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};
