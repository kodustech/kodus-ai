import { pathToApiUrl } from "src/core/utils/helpers";

export const SPEND_LIMIT_PATHS = {
    GET: pathToApiUrl("/spend-limit"),
    UPDATE: pathToApiUrl("/spend-limit"),
    STATUS: pathToApiUrl("/spend-limit/status"),
};
