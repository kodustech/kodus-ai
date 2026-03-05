import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

export type FeedbackType = "positive" | "negative";

export const sendRuleFeedback = async (
    ruleId: string,
    feedback: FeedbackType,
) => {
    const url = pathToApiUrl(`/rule-like/${ruleId}/feedback`);
    return authorizedFetch(url, {
        method: "POST",
        body: JSON.stringify({ feedback }),
    });
};

export const removeRuleFeedback = async (ruleId: string) => {
    const url = pathToApiUrl(`/rule-like/${ruleId}/feedback`);
    return authorizedFetch(url, {
        method: "DELETE",
    });
};
