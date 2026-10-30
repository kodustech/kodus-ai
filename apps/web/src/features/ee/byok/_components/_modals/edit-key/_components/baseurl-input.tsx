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
    if (!foundProvider?.requiresBaseUrl) return null;

    return (
        <Controller
            name="baseURL"
            control={form.control}
            render={({ field, fieldState }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={field.name}>
                        Base URL
                    </FormControl.Label>

                    <FormControl.Input>
                        <Input
                            id={field.name}
                            size="md"
                            type="url"
                            value={field.value ?? ""}
                            error={fieldState.error}
                            onChange={field.onChange}
                            placeholder="https://your-endpoint.example.com/v1"
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
