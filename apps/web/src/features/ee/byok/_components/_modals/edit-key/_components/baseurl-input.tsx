import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { useSuspenseGetLLMProviders } from "@services/organizationParameters/hooks";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../_types";

export const ByokBaseURLInput = () => {
    const form = useFormContext<EditKeyForm>();
    const { providers } = useSuspenseGetLLMProviders();

    const provider = form.watch("provider");
    const foundProvider = providers.find((p) => p.id === provider);
    // An API that predates `acceptsBaseUrl` still sends `requiresBaseUrl`.
    if (!(foundProvider?.acceptsBaseUrl ?? foundProvider?.requiresBaseUrl))
        return null;
    const optional = !foundProvider.requiresBaseUrl;

    return (
        <Controller
            name="baseURL"
            control={form.control}
            render={({ field, fieldState }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={field.name}>
                        {optional ? "Base URL (optional)" : "Base URL"}
                    </FormControl.Label>

                    <FormControl.Input>
                        <Input
                            id={field.name}
                            size="md"
                            type="url"
                            value={field.value ?? ""}
                            error={fieldState.error}
                            // Cleared on an optional field means the provider's
                            // own endpoint, which is stored as no base URL.
                            onChange={(e) =>
                                field.onChange(
                                    optional && !e.target.value.trim()
                                        ? null
                                        : e.target.value,
                                )
                            }
                            placeholder={
                                optional
                                    ? "https://your-proxy.example.com/v1"
                                    : "https://your-endpoint.example.com/v1"
                            }
                        />
                    </FormControl.Input>

                    {optional && (
                        <FormControl.Helper>
                            {`Your own proxy or gateway for ${foundProvider.name}'s API. Leave empty to call ${foundProvider.name} directly. For another vendor's server, pick the Compatible provider instead.`}
                        </FormControl.Helper>
                    )}

                    <FormControl.Error>
                        {fieldState.error?.message}
                    </FormControl.Error>
                </FormControl.Root>
            )}
        />
    );
};
