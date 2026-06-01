export interface SSORedirectErrorInfo {
    reasonCode: string;
    failureCode: string;
    message: string;
}

const extractErrorMessage = (error: unknown): string => {
    const candidate =
        (error as { message?: string })?.message ||
        (error as { response?: { message?: string } })?.response?.message ||
        (error as { cause?: { message?: string } })?.cause?.message ||
        (error as { originalError?: { message?: string } })?.originalError
            ?.message ||
        '';

    return String(candidate || '').trim();
};

const withDetail = (prefix: string, detail: string): string => {
    if (!detail) {
        return prefix;
    }

    const truncatedDetail = detail.slice(0, 180);
    return `${prefix} Details: ${truncatedDetail}`;
};

const DEFAULT_SSO_ERROR: SSORedirectErrorInfo = {
    reasonCode: 'sso-auth-failed',
    failureCode: 'SSO_AUTH_FAILED',
    message:
        'Unable to validate the SSO response. Verify your SSO settings and try again.',
};

export const mapSSOError = (error: unknown): SSORedirectErrorInfo => {
    const rawMessage = extractErrorMessage(error);

    const message = String(rawMessage).toLowerCase();

    if (message.includes('invalid email')) {
        return {
            reasonCode: 'sso-invalid-email-assertion',
            failureCode: 'SSO_INVALID_EMAIL_ASSERTION',
            message: 'The SSO assertion does not contain a valid email.',
        };
    }

    if (message.includes('sso config not found')) {
        return {
            reasonCode: 'sso-config-not-found',
            failureCode: 'SSO_CONFIG_NOT_FOUND',
            message: 'SSO is not configured for this organization.',
        };
    }

    if (
        message.includes('signature') ||
        message.includes('assertion') ||
        message.includes('response')
    ) {
        return {
            reasonCode: 'sso-invalid-assertion',
            failureCode: 'SSO_INVALID_ASSERTION',
            message: withDetail(
                'The identity provider response could not be validated.',
                rawMessage,
            ),
        };
    }

    if (message.includes('inresponseto')) {
        return {
            reasonCode: 'sso-expired-request',
            failureCode: 'SSO_EXPIRED_REQUEST',
            message: 'The SSO request expired. Start the login flow again.',
        };
    }

    return {
        ...DEFAULT_SSO_ERROR,
        message: withDetail(DEFAULT_SSO_ERROR.message, rawMessage),
    };
};
