"use client";

import { FormControl } from "@components/ui/form-control";
import { useSuspenseGetLLMProviders } from "@services/organizationParameters/hooks";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../_types";
import { CREDENTIAL_FORMS } from "./credential-forms";
import { ProviderDocLink } from "./provider-doc-link";
import { SecretInput } from "./secret-input";

/**
 * Renders the credential inputs for the active provider. Providers whose connect
 * form needs more than a single API key (multi-field cloud auth) register a
 * bespoke form in the CREDENTIAL_FORMS registry — one place, co-located with the
 * form — and it renders here. Everything else falls back to the single API-key
 * input (same behavior as ByokKeyInput).
 *
 * Used in the manual wizard. The curated flow's connect panel uses the simpler
 * single-field ByokKeyInput since curated cards never target Vertex/Bedrock.
 */
export const ByokCredentialsInput = () => {
    const form = useFormContext<EditKeyForm>();
    const { providers } = useSuspenseGetLLMProviders();

    const provider = form.watch("provider");

    const CustomForm = provider ? CREDENTIAL_FORMS[provider] : undefined;
    if (CustomForm) return <CustomForm />;

    const foundProvider = providers.find((p) => p.id === provider);
    if (!foundProvider?.requiresApiKey) return null;

    return (
        <Controller
            name="apiKey"
            control={form.control}
            render={({ field, fieldState }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={field.name}>
                        Key
                    </FormControl.Label>
                    <FormControl.Input>
                        <SecretInput
                            id={field.name}
                            value={field.value ?? ""}
                            onChange={field.onChange}
                            error={fieldState.error}
                            placeholder="Provide your key"
                        />
                    </FormControl.Input>
                    <FormControl.Error>
                        {fieldState.error?.message}
                    </FormControl.Error>
                    <ProviderDocLink provider={provider} />
                </FormControl.Root>
            )}
        />
    );
};
