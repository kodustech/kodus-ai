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
    if (!foundProvider?.acceptsBaseUrl) return null;
    const optional = !foundProvider.requiresBaseUrl;

    return (
        <Controller
            name="baseURL"
            control={form.control}
            render={({ field, fieldState }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={field.name}>
                        {optional
                            ? "Custom base URL (proxy / gateway, optional)"
                            : "Base URL"}
                    </FormControl.Label>

                    <FormControl.Input>
                        <Input
                            id={field.name}
                            size="md"
                            type="url"
                            value={field.value ?? ""}
                            error={fieldState.error}
                            // Cleared optional field means "provider default",
                            // not an invalid empty URL.
                            onChange={(e) =>
                                field.onChange(
                                    optional && !e.target.value
                                        ? null
                                        : e.target.value,
                                )
                            }
                            placeholder="https://your-endpoint.example.com/v1"
                        />
                    </FormControl.Input>

                    {optional && (
                        <FormControl.Helper>
                            Leave empty to call the provider directly. Use it
                            for a gateway in front of this provider (Cloudflare
                            AI Gateway, Helicone, Portkey); for a third-party
                            server that implements the protocol, pick the
                            Compatible provider instead.
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
