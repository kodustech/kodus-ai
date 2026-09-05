"use client";

import { Suspense, useState } from "react";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import {
    testBYOK,
    testBYOKModel,
    type TestBYOKResult,
} from "@services/organizationParameters/fetch";
import { CheckCircle2Icon, PlugIcon, SaveIcon } from "lucide-react";
import { FormProvider, useForm } from "react-hook-form";

import { PROVIDER_LABELS } from "../_data/provider-labels";
import type { BYOKConnectInput, BYOKCredential } from "../_types";
import { maskKey } from "../_utils";
import { ByokBaseURLInput } from "./_modals/edit-key/_components/baseurl-input";
import { ADVANCED_FIELDS } from "./_modals/edit-key/_components/credential-forms";
import { ByokCredentialsInput } from "./_modals/edit-key/_components/credentials-input";
import type { EditKeyForm } from "./_modals/edit-key/_types";
import {
    providerSettingDefaults,
    unownedStoredSettings,
} from "./_modals/edit-key/credential-config";
import { credentialSettingsFromConfig } from "./byok-write";

/**
 * Credential-edit body for a connected provider. Renders the SAME provider-aware
 * inputs as the add/manual flow (`ByokCredentialsInput` → the provider's OWN
 * fields, driven by CREDENTIAL_FORMS: a single key for key-based providers, the
 * aws* form for Bedrock, service-account for Vertex; `ByokBaseURLInput` shows only
 * where the provider needs a base URL). So editing a provider shows the fields it
 * actually authenticates with — not a generic "API key" + "Base URL".
 *
 * Header-less by design: the routed provider editor (`/byok/provider`) supplies
 * the big page title + back arrow, exactly like the model editor — this component
 * only owns the form body so both edit screens share one page shell.
 *
 * Keep-on-blank: every SECRET (top-level apiKey + the aws* in BYOK_SECRET_SETTINGS)
 * is seeded BLANK and, left blank, keeps the stored ciphertext — the server's
 * per-field encryptOrKeep contract (an omitted/blank secret keeps the prior value,
 * a real value is encrypted; the `••••` mask is never sent). Non-secret settings
 * (region, base URL) are seeded from the stored config so they show and round-trip.
 * A newly typed secret is probed with testBYOK before save.
 */
export function RotatePanel({
    credential,
    probeModelId,
    onSave,
    onCancel,
}: {
    credential: BYOKCredential;
    probeModelId?: string;
    onSave: (
        apiKey: string,
        settings?: Record<string, unknown>,
    ) => Promise<void>;
    onCancel: () => void;
}) {
    const settings = (credential.settings ?? {}) as Record<string, unknown>;
    // The provider's own advanced fields (e.g. OpenRouter's upstream pinning).
    // They are stored ON the credential, so the panel that rewrites a
    // credential's settings has to render them — a field it cannot show is a
    // field it silently drops on save.
    const ProviderAdvancedFields = ADVANCED_FIELDS[credential.provider];
    const providerLabel =
        PROVIDER_LABELS[credential.provider] ?? credential.provider;
    const str = (v: unknown): string | null =>
        typeof v === "string" && v ? v : null;

    // Non-secret settings are seeded from the stored config (the backend strips the
    // aws* secrets before they ever reach the client, so those stay blank = keep).
    const form = useForm<EditKeyForm>({
        defaultValues: {
            provider: credential.provider,
            model: probeModelId ?? "",
            apiKey: "",
            baseURL: str(settings.baseURL),
            awsRegion: null,
            vertexLocation: null,
            // Provider-owned non-secret settings, seeded off the registry so a
            // field this panel does not hand-list still survives the save. The
            // secrets stay null above/below: blank means "keep the ciphertext".
            ...providerSettingDefaults(credential.provider, settings),
            awsBearerToken: null,
            awsAccessKeyId: null,
            awsSecretAccessKey: null,
            awsSessionToken: null,
        } as EditKeyForm,
    });

    const [isSaving, setIsSaving] = useState(false);
    const [testState, setTestState] = useState<
        | { status: "idle" }
        | { status: "testing" }
        | {
            status: "success";
            latencyMs: number;
            verifiedBy?: "catalog" | "probe";
        }
        | { status: "error"; result: TestBYOKResult }
    >({ status: "idle" });

    const hasApiKeyStored =
        typeof credential.apiKey === "string" && !!credential.apiKey;

    // A NEW secret typed this session (bearer token, API key, or full IAM pair) —
    // a blank secret keeps the stored ciphertext, which we can't re-probe without
    // the plaintext, so we probe the STORED credential instead (testBYOKModel).
    const typedNewSecret = (values: EditKeyForm): boolean =>
        !!values.apiKey?.trim() ||
        !!values.awsBearerToken?.trim() ||
        (!!values.awsAccessKeyId?.trim() &&
            !!values.awsSecretAccessKey?.trim());

    // Changing the endpoint must NOT reuse the stored secret: the server would
    // otherwise send the org's key to a caller-supplied host. So a baseURL edit
    // requires re-entering the key (probed with the new key via testBYOK). Gates
    // BOTH the probe and the save, so it holds even when there is no probe model.
    const baseUrlChangeNeedsKey = (values: EditKeyForm): boolean =>
        (values.baseURL?.trim() || null) !== str(settings.baseURL) &&
        !typedNewSecret(values);
    const baseUrlKeyError: TestBYOKResult = {
        ok: false,
        code: "bad_request",
        latencyMs: 0,
        message: "Re-enter your API key to change the base URL.",
    };

    // Probe the credential — the just-typed one if a new secret was entered,
    // otherwise the STORED one via testBYOKModel (server resolves the ciphertext).
    // The stored-credential probe is what surfaces a lapsed key (e.g. an expired
    // Bedrock bearer token) here, on demand, instead of only at review time.
    const runTest = async (): Promise<TestBYOKResult | null> => {
        if (!probeModelId) return null;
        const valid = await form.trigger();
        if (!valid) return null;
        const values = form.getValues();

        if (baseUrlChangeNeedsKey(values)) {
            setTestState({ status: "error", result: baseUrlKeyError });
            return baseUrlKeyError;
        }

        setTestState({ status: "testing" });
        try {
            const result = typedNewSecret(values)
                ? await testBYOK({
                    provider: credential.provider,
                    model: probeModelId,
                    apiKey: values.apiKey?.trim() || undefined,
                    baseURL: values.baseURL?.trim() || undefined,
                    vertexLocation:
                        values.vertexLocation?.trim() || undefined,
                    awsBearerToken:
                        values.awsBearerToken?.trim() || undefined,
                    awsAccessKeyId:
                        values.awsAccessKeyId?.trim() || undefined,
                    awsSecretAccessKey:
                        values.awsSecretAccessKey?.trim() || undefined,
                    awsRegion: values.awsRegion?.trim() || undefined,
                    awsSessionToken:
                        values.awsSessionToken?.trim() || undefined,
                })
                : await testBYOKModel({
                    provider: credential.provider,
                    model: probeModelId,
                    // No new secret was typed, so the stored ciphertext is
                    // re-used server-side. Only the SAFE region/location edits
                    // ride along (a baseURL change is gated above to require the
                    // key, so the stored secret never reaches a new host).
                    awsRegion: values.awsRegion?.trim() || undefined,
                    vertexLocation:
                        values.vertexLocation?.trim() || undefined,
                });
            setTestState(
                result.ok
                    ? {
                        status: "success",
                        latencyMs: result.latencyMs,
                        verifiedBy: result.verifiedBy,
                    }
                    : { status: "error", result },
            );
            return result;
        } catch {
            const result: TestBYOKResult = {
                ok: false,
                code: "unknown",
                latencyMs: 0,
                message: "Couldn't reach Kodus. Try again in a moment.",
            };
            setTestState({ status: "error", result });
            return result;
        }
    };

    const handleTestAndSave = form.handleSubmit(async (values) => {
        // Gate the SAVE on a baseURL change independently of probeModelId: the
        // probe guard below is skipped when there is no probe model, so without
        // this a blank-secret endpoint edit would persist unauthenticated.
        if (baseUrlChangeNeedsKey(values)) {
            setTestState({ status: "error", result: baseUrlKeyError });
            return;
        }
        setIsSaving(true);
        try {
            // Always probe before persisting — a new secret is validated, and an
            // unchanged stored credential is re-checked so a save can't silently
            // keep a credential that no longer authenticates.
            if (probeModelId) {
                const result = await runTest();
                if (result && !result.ok) return;
            }
            // Non-secrets ride the form; blank secrets are OMITTED here so the
            // server's encryptOrKeep keeps the stored ciphertext (never the mask).
            const nextSettings = {
                // Keys no credential form owns are carried through untouched —
                // the server REPLACES this object, so anything not re-sent is
                // deleted.
                ...unownedStoredSettings(settings),
                ...(credentialSettingsFromConfig(
                    values as unknown as BYOKConnectInput,
                ) ?? {}),
            };
            await onSave(values.apiKey?.trim() ?? "", nextSettings);
        } finally {
            setIsSaving(false);
        }
    });

    const testing = testState.status === "testing";

    return (
        <FormProvider {...form}>
            <div className="flex flex-col gap-4">
                <Alert variant="info">
                    <AlertDescription className="text-pretty">
                        {hasApiKeyStored ? (
                            <>
                                A key for <strong>{providerLabel}</strong> is
                                stored (
                                <span className="font-mono">
                                    {maskKey(credential.apiKey)}
                                </span>
                                ). Paste a new one to replace it — or leave it
                                blank to keep the current key.
                            </>
                        ) : (
                            <>
                                Credentials for <strong>{providerLabel}</strong>{" "}
                                are stored. Enter new values to replace them —
                                or leave the secret fields blank to keep the
                                current ones.
                            </>
                        )}
                    </AlertDescription>
                </Alert>

                {/* Provider-aware credential fields — the SAME inputs the
                    add/manual flow renders (key for key-based providers, the aws*
                    form for Bedrock, service-account for Vertex). Suspense because
                    they read the provider list via a suspense query. */}
                <Suspense
                    fallback={
                        <div className="text-text-tertiary text-sm">
                            Loading credential fields…
                        </div>
                    }>
                    <ByokCredentialsInput />
                    {ProviderAdvancedFields ? <ProviderAdvancedFields /> : null}
                    <ByokBaseURLInput />
                </Suspense>

                {testState.status === "success" && (
                    <Alert variant="success">
                        <CheckCircle2Icon />
                        <AlertDescription className="text-pretty">
                            {/* Two different claims, and the weaker one used to
                                borrow the stronger one's words. A catalog hit
                                proves the key authenticates and the id is
                                listed; it never called the model, so it cannot
                                say the model runs. Saying so is the difference
                                between a useful check and false reassurance. */}
                            {testState.verifiedBy === "catalog" ? (
                                <>
                                    Key works and your provider lists this model
                                    ({testState.latencyMs} ms). This check
                                    doesn&apos;t call the model, so it
                                    can&apos;t confirm it will run.
                                </>
                            ) : (
                                <>
                                    Connected — the credential authenticates (
                                    {testState.latencyMs} ms).
                                </>
                            )}
                        </AlertDescription>
                    </Alert>
                )}

                {testState.status === "error" && (
                    <Alert variant="danger">
                        <AlertDescription className="text-pretty">
                            {testState.result.message ??
                                "The credentials failed to connect. Check them and try again."}
                            {/* What the PROVIDER said, verbatim. Our own line is a
                                guess keyed on the HTTP status; the provider's is
                                the actual reason, and it is frequently the only
                                one that names the fix. A customer once spent a
                                day regenerating a perfectly good key because we
                                showed "the base URL is wrong or the API path
                                isn't on your plan" while OpenRouter had replied,
                                in this very field, that their account's
                                allowed-providers setting had no upstream serving
                                the model — and said where to change it. */}
                            {testState.result.providerMessage && (
                                <span className="text-text-secondary mt-2 block text-xs break-words">
                                    Provider said:{" "}
                                    {testState.result.providerMessage}
                                </span>
                            )}
                        </AlertDescription>
                    </Alert>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                        type="button"
                        size="md"
                        variant="cancel"
                        onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        size="md"
                        variant="helper"
                        leftIcon={<PlugIcon />}
                        loading={testing}
                        // Probing needs a model to send the test request to; a
                        // connected provider always has one, but guard anyway.
                        disabled={!probeModelId || isSaving}
                        onClick={() => void runTest()}>
                        Test
                    </Button>
                    <Button
                        type="button"
                        size="md"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        loading={isSaving}
                        disabled={testing}
                        onClick={() => void handleTestAndSave()}>
                        Test &amp; save
                    </Button>
                </div>
            </div>
        </FormProvider>
    );
}
