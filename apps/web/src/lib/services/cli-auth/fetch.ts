import { pathToApiUrl } from "src/core/utils/helpers";

export const CLI_AUTH_API = {
    LOGIN_INFO: (params: { state?: string; userCode?: string }) => {
        const search = new URLSearchParams();
        if (params.state) search.append("state", params.state);
        if (params.userCode) search.append("user_code", params.userCode);
        return pathToApiUrl(`/cli/auth/login-info?${search.toString()}`);
    },
    LOGIN_COMPLETE: () => pathToApiUrl(`/cli/auth/login-complete`),
};

export interface CliLoginInfo {
    found: boolean;
    state?: string;
    mode?: "loopback" | "device";
    status?: string;
    userAgent?: string | null;
    expiresAt?: string;
}

export interface CompleteCliLoginResult {
    redirectUri?: string | null;
    state: string;
    mode: "loopback" | "device";
}
