import type { ReactNode } from "react";
import { Link } from "@components/ui/link";
import type { CentralizedPrResponse } from "@services/parameters/types";

export const getCentralizedPrToastPayload = (
    centralizedPr: CentralizedPrResponse,
    fallbackMessage: string,
): {
    title: string;
    description: ReactNode;
    variant: "success";
} => {
    const title = centralizedPr.reused
        ? "Change added to active centralized PR"
        : "Change proposed through centralized PR";

    const message =
        centralizedPr.message?.trim() ||
        "Your change was queued in the centralized configuration pull request.";

    const description = centralizedPr.prUrl ? (
        <span>
            {message}{" "}
            <Link href={centralizedPr.prUrl} target="_blank">
                Open pull request
            </Link>
            .
        </span>
    ) : (
        message || fallbackMessage
    );

    return {
        title,
        description,
        variant: "success",
    };
};
