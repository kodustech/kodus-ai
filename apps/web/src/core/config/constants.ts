export const API_ROUTES = {
    login: "/auth/login",
    register: "/auth/signup",
    logout: "/auth/logout",
    forgotPassword: "/auth/forgot-password",
    confirmEmail: "/auth/confirm-email",
    resendEmail: "/auth/resend-email",
    resetPassword: "/auth/reset-password",
    createNewPassword: "/auth/create-new-password",
    refreshToken: "/auth/refresh",
    getInviteData: "/user/invite",
    completeUserInvitation: "/user/invite/complete-invitation",
    posthogTrack: "/posthog/track",
    loginOAuth: "/auth/oauth",
    checkForEmailExistence: "/user/email",
    getOrganizationsByDomain: "/organization/domain",
    ssoCallback: "/auth/saml/callback",
    ssoLogin: "/auth/sso/login",
    ssoCheck: "/auth/sso/check",
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
