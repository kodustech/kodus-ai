"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    cancelSecurityScan,
    securityScansPath,
} from "@services/security-scans/fetch";
import {
    isSecurityScanActive,
    type SecurityScan,
} from "@services/security-scans/types";
import { useQueryClient } from "@tanstack/react-query";
import { extractRejectionMessage } from "src/core/utils/extract-error-message";

export const CancelScanButton = ({
    scan,
    size = "sm",
}: {
    scan: SecurityScan;
    size?: "xs" | "sm";
}) => {
    const queryClient = useQueryClient();
    const canCancel = usePermission(
        Action.Create,
        ResourceType.SecurityScan,
        scan.repository.id,
    );
    const [cancelling, setCancelling] = useState(false);

    if (!canCancel || !isSecurityScanActive(scan)) return null;

    const cancel = async () => {
        if (cancelling) return;
        setCancelling(true);
        try {
            await cancelSecurityScan(scan.uuid);
            await queryClient.invalidateQueries({
                queryKey: [securityScansPath()],
            });
            toast({
                variant: "success",
                title: "Scan cancelled",
                description: "You can start another scan of this repository.",
            });
        } catch (error) {
            toast({
                variant: "danger",
                title: "Could not cancel the scan",
                description:
                    extractRejectionMessage(error) ?? "Try again in a moment.",
            });
        } finally {
            setCancelling(false);
        }
    };

    return (
        <Button
            type="button"
            size={size}
            variant="cancel"
            loading={cancelling}
            onClick={cancel}>
            Cancel
        </Button>
    );
};
