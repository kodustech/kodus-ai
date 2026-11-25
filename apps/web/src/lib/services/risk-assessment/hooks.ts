import { useFetch } from "src/core/utils/reactQuery";

import { RISK_ASSESSMENT_API_PATHS, type DefaultRiskCriterion } from "./types";

/** The rules Kodus applies unless a team turns them off or edits them. */
export const useDefaultRiskCriteria = () =>
    useFetch<DefaultRiskCriterion[]>(
        RISK_ASSESSMENT_API_PATHS.DEFAULT_CRITERIA,
        undefined,
        undefined,
        { staleTime: Infinity },
    );
