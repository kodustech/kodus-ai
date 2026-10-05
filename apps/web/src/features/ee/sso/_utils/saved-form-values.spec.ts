import { buildSSOConfigFingerprint } from "src/lib/auth/sso-fingerprint";
import { SSOConfig, SSOProtocol } from "src/lib/auth/types";

import {
    SAML_EMAIL_IDENTIFIER_FORMAT,
    savedSsoFormValues,
    toSamlProviderConfig,
} from "./saved-form-values";

const neverSaved = {
    protocol: SSOProtocol.SAML,
    active: false,
    providerConfig: {},
    domains: [],
} as unknown as SSOConfig<SSOProtocol.SAML>;

const fingerprint = (values: ReturnType<typeof savedSsoFormValues>) =>
    buildSSOConfigFingerprint({
        protocol: SSOProtocol.SAML,
        providerConfig: toSamlProviderConfig(values.providerConfig),
        domains: values.domains,
    });

describe("savedSsoFormValues", () => {
    it("fills in what the form shows for an org that never saved SSO", () => {
        expect(savedSsoFormValues(neverSaved, "acme.com")).toEqual({
            active: false,
            providerConfig: {
                idpIssuer: "",
                entryPoint: "",
                cert: "",
                identifierFormat: SAML_EMAIL_IDENTIFIER_FORMAT,
                issuer: "kodus-orchestrator",
            },
            domains: ["acme.com"],
        });
    });

    it("identifies users by email address", () => {
        expect(SAML_EMAIL_IDENTIFIER_FORMAT).toBe(
            "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        );
    });

    it("keeps every value the org saved", () => {
        const saved = {
            protocol: SSOProtocol.SAML,
            active: true,
            providerConfig: {
                idpIssuer: "https://idp.acme.com",
                entryPoint: "https://idp.acme.com/sso",
                cert: "MIIC",
                identifierFormat: "urn:custom",
                issuer: "acme-sp",
            },
            domains: ["acme.com", "acme.io"],
        } as unknown as SSOConfig<SSOProtocol.SAML>;

        expect(savedSsoFormValues(saved, "other.com")).toEqual({
            active: true,
            providerConfig: saved.providerConfig,
            domains: ["acme.com", "acme.io"],
        });
    });

    it("matches an untouched form, so nothing reads as unsaved", () => {
        // What the page's form starts from for an org with no SSO saved. The
        // raw config (no identifier format, issuer or domain) differed from
        // it, and the page opened as "Unsaved changes".
        const untouchedForm = {
            active: false,
            providerConfig: {
                idpIssuer: "",
                entryPoint: "",
                cert: "",
                identifierFormat: SAML_EMAIL_IDENTIFIER_FORMAT,
                issuer: "kodus-orchestrator",
            },
            domains: ["acme.com"],
        };
        const saved = savedSsoFormValues(neverSaved, "acme.com");

        expect(fingerprint(saved)).toBe(fingerprint(untouchedForm));
        expect(
            fingerprint({
                ...untouchedForm,
                providerConfig: {
                    ...untouchedForm.providerConfig,
                    entryPoint: "https://idp.acme.com/sso",
                },
            }),
        ).not.toBe(fingerprint(saved));
    });

    it("treats a missing provider config like an empty one", () => {
        const noProvider = {
            ...neverSaved,
            providerConfig: undefined,
        } as unknown as SSOConfig<SSOProtocol.SAML>;

        expect(savedSsoFormValues(noProvider, "acme.com")).toEqual(
            savedSsoFormValues(neverSaved, "acme.com"),
        );
    });
});

describe("toSamlProviderConfig", () => {
    it("blanks the IdP fields and leaves the SP ones unset with no config", () => {
        expect(toSamlProviderConfig(undefined)).toEqual({
            idpIssuer: "",
            entryPoint: "",
            cert: "",
            identifierFormat: undefined,
            issuer: undefined,
        });
    });

    it("passes every field through as given", () => {
        const config = {
            idpIssuer: "https://idp.acme.com",
            entryPoint: "https://idp.acme.com/sso",
            cert: "MIIC",
            identifierFormat: "urn:custom",
            issuer: "acme-sp",
        };

        expect(toSamlProviderConfig(config)).toEqual(config);
    });
});
