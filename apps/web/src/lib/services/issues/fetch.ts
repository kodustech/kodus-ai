import type { SeverityLevel } from "src/core/types";
import { axiosAuthorized } from "src/core/utils/axios";
import { pathToApiUrl } from "src/core/utils/helpers";

import type { IssueStatus } from "./types";

export const changeIssueParameter = async ({
    id,
    field,
    value,
}: { id: string } & (
    | {
          field: "label";
          value: "security";
      }
    | {
          field: "severity";
          value: SeverityLevel;
      }
    | {
          field: "status";
          value: IssueStatus;
      }
)) => {
    return axiosAuthorized.patch(pathToApiUrl(`/issues/${id}`), {
        field,
        value,
    });
};

export type IssuesFixPrompt = {
    /** Empty when none of the issues could be included. */
    prompt: string;
    included: string[];
    /** Unknown, or in a repository the caller cannot read. */
    skipped: string[];
};

/** At most this many issues go into one prompt (the API refuses more). */
export const FIX_PROMPT_MAX_ISSUES = 25;

export const getIssuesFixPrompt = async (
    ids: string[],
): Promise<IssuesFixPrompt> => {
    const response = await axiosAuthorized.post<{ data: IssuesFixPrompt }>(
        pathToApiUrl("/issues/fix-prompt"),
        { ids: ids.slice(0, FIX_PROMPT_MAX_ISSUES) },
    );

    return response.data;
};
