import type { SSOConfig, SSOProtocol } from "src/lib/auth/types";

export const SAML_EMAIL_IDENTIFIER_FORMAT =
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

const DEFAULT_SP_ISSUER = "kodus-orchestrator";

export type SamlProviderFormValues = {
    idpIssuer: string;
    entryPoint: string;
    cert: string;
    identifierFormat?: string;
    issuer?: string;
};

/**
 * The saved config as the form shows it: an org that never saved SSO has no
 * identifier format, SP issuer or domains, and the form fills them in. The
 * "unsaved changes" check compares against this, not the raw config, or a
 * page nobody touched reads as edited.
 */
export const savedSsoFormValues = (
    ssoConfig: SSOConfig<SSOProtocol.SAML>,
    userDomain: string,
) => ({
    active: ssoConfig.active,
    providerConfig: {
        idpIssuer: ssoConfig.providerConfig?.idpIssuer || "",
        entryPoint: ssoConfig.providerConfig?.entryPoint || "",
        cert: ssoConfig.providerConfig?.cert || "",
        identifierFormat:
            ssoConfig.providerConfig?.identifierFormat ||
            SAML_EMAIL_IDENTIFIER_FORMAT,
        issuer: ssoConfig.providerConfig?.issuer || DEFAULT_SP_ISSUER,
    } satisfies SamlProviderFormValues,
    domains: ssoConfig.domains.length > 0 ? ssoConfig.domains : [userDomain],
});

export const toSamlProviderConfig = (
    config?: Partial<SamlProviderFormValues>,
) => ({
    idpIssuer: config?.idpIssuer || "",
    entryPoint: config?.entryPoint || "",
    cert: config?.cert || "",
    identifierFormat: config?.identifierFormat,
    issuer: config?.issuer,
});
