import { authorizedFetch } from "@services/fetch";

import { CLI_KEYS_PATHS } from ".";
import type { CLIKey, CLIKeyConfig, CreateCLIKeyResponse } from "./types";

export const listCLIKeys = async (teamId: string): Promise<CLIKey[]> => {
    const response = await authorizedFetch<CLIKey[]>(
        CLI_KEYS_PATHS.BASE(teamId),
    );

    return response ?? [];
};

export const createCLIKey = async (params: {
    teamId: string;
    name: string;
    config?: CLIKeyConfig;
}): Promise<CreateCLIKeyResponse | null> => {
    const response = await authorizedFetch<CreateCLIKeyResponse>(
        CLI_KEYS_PATHS.BASE(params.teamId),
        {
            method: "POST",
            body: JSON.stringify({
                name: params.name,
                config: params.config,
            }),
        },
    );

    return response;
};

export const updateCLIKeyConfig = async (params: {
    teamId: string;
    keyId: string;
    config: CLIKeyConfig;
}): Promise<CLIKey | null> => {
    const response = await authorizedFetch<CLIKey>(
        CLI_KEYS_PATHS.CONFIG(params.teamId, params.keyId),
        {
            method: "PATCH",
            body: JSON.stringify({
                config: params.config,
            }),
        },
    );

    return response;
};

export const revokeCLIKey = async (params: {
    teamId: string;
    keyId: string;
}): Promise<{ message: string } | null> => {
    const response = await authorizedFetch<{ message: string }>(
        CLI_KEYS_PATHS.ITEM(params.teamId, params.keyId),
        {
            method: "DELETE",
        },
    );

    return response;
};
