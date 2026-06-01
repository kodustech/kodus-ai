import { pathToApiUrl } from "src/core/utils/helpers";

export const SSO_CONFIG_PATHS = {
    GET: pathToApiUrl("/sso-config"),
    CREATE_OR_UPDATE: pathToApiUrl("/sso-config"),
    TEST_START: pathToApiUrl("/sso-config/test/start"),
    TEST_RESULT: pathToApiUrl("/sso-config/test/result"),
    DOMAIN_VERIFICATION_REQUEST: pathToApiUrl(
        "/sso-config/domain-verification/request",
    ),
    DOMAIN_VERIFICATION_CONFIRM: pathToApiUrl(
        "/sso-config/domain-verification/confirm",
    ),
    DOMAIN_VERIFICATION_STATUS: pathToApiUrl(
        "/sso-config/domain-verification/status",
    ),
};
