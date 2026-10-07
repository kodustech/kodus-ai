import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

import type {
    BusinessLogicSettingsValue,
    BusinessLogicStatus,
    IntentCockpit,
    ReadTool,
    TaskSourceOption,
    TryReadResult,
} from "./types";

export const BUSINESS_LOGIC_PATHS = {
    STATUS: pathToApiUrl("/business-logic/status"),
    TASK_SOURCES: pathToApiUrl("/business-logic/task-sources"),
    READ_TOOLS: (integrationId: string) =>
        pathToApiUrl(
            `/business-logic/task-sources/${encodeURIComponent(integrationId)}/tools`,
        ),
    TRY: pathToApiUrl("/business-logic/try"),
    INTENT: pathToApiUrl("/business-logic/intent"),
};

export const getBusinessLogicStatus = (params: {
    teamId: string;
    repositoryId?: string;
}) =>
    authorizedFetch<BusinessLogicStatus>(BUSINESS_LOGIC_PATHS.STATUS, {
        params,
    });

export const getTaskSources = (teamId: string) =>
    authorizedFetch<TaskSourceOption[]>(BUSINESS_LOGIC_PATHS.TASK_SOURCES, {
        params: { teamId },
    });

export const getReadTools = (teamId: string, integrationId: string) =>
    authorizedFetch<ReadTool[]>(
        BUSINESS_LOGIC_PATHS.READ_TOOLS(integrationId),
        {
            params: { teamId },
        },
    );

export const tryReadTask = (body: {
    teamId: string;
    task: string;
    settings?: BusinessLogicSettingsValue;
}) =>
    authorizedFetch<TryReadResult>(BUSINESS_LOGIC_PATHS.TRY, {
        method: "POST",
        body: JSON.stringify(body),
    });

export const getIntentCockpit = (params: {
    startDate: string;
    endDate: string;
    teamId?: string;
}) => authorizedFetch<IntentCockpit>(BUSINESS_LOGIC_PATHS.INTENT, { params });
