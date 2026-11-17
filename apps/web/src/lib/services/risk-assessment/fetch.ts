import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

import type { RiskCriterion, RiskPreview } from "./types";

export const previewPrRisk = (body: {
    teamId: string;
    repositoryId: string;
    prNumber: number;
    criteria: RiskCriterion[];
}) =>
    authorizedFetch<RiskPreview>(pathToApiUrl("/code-review/risk/preview"), {
        method: "POST",
        body: JSON.stringify(body),
    });
