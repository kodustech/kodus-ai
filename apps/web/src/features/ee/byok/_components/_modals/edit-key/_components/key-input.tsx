import { FormControl } from "@components/ui/form-control";
import { useSuspenseGetLLMProviders } from "@services/organizationParameters/hooks";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../_types";
import { SecretInput } from "./secret-input";

export const ByokKeyInput = () => {
    const form = useFormContext<EditKeyForm>();
    const { providers } = useSuspenseGetLLMProviders();

    const provider = form.watch("provider");
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
                </FormControl.Root>
            )}
        />
    );
};
