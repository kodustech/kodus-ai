import { useQuery } from "@tanstack/react-query";

import { getTrialTerms } from "../_services/billing/fetch";

/**
 * Terms a trial started now gets, read from billing. `undefined` while
 * loading and `null` when there is no billing to ask (self-hosted) or it did
 * not answer: callers leave the trial copy out rather than show a guess.
 */
export const useTrialTerms = () =>
    useQuery({
        queryKey: ["billing", "trial-terms"],
        queryFn: getTrialTerms,
        staleTime: 5 * 60 * 1000,
    }).data;
