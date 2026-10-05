import { FormattedConfigLevel, type CodeReviewFormType } from "../../_types";

/**
 * The model selector writes `byokModelId.value`, but a config that never set
 * an id-based override carries no `byokModelId` at all. Registered on mount,
 * the field then differed from the form's defaults and the page opened as
 * "Unsaved changes". Seed it with what the selector shows: the id, else the
 * legacy model name, else inherit ("").
 */
export function withModelOverrideField<T extends Partial<CodeReviewFormType>>(
    values: T,
): T {
    if (values.byokModelId) return values;

    return {
        ...values,
        byokModelId: {
            value: values.byokModel?.value ?? "",
            level: values.byokModel?.level ?? FormattedConfigLevel.DEFAULT,
        },
    };
}

/**
 * The seed above is for the selector to show; it is not a choice. Saving it
 * as is would turn an inherited (or legacy-name) model into an override owned
 * by this scope, which then stops following its parent. Send `byokModelId`
 * only when the user changed it; the backend merges, so leaving it out keeps
 * whatever override is already stored.
 */
export function withoutUntouchedModelOverride<
    T extends { byokModelId?: unknown },
>(
    payload: T,
    formValue: string | undefined,
    defaultValue: string | undefined,
): T {
    if ((formValue ?? "") !== (defaultValue ?? "")) return payload;

    const { byokModelId: _untouched, ...rest } = payload;
    return rest as T;
}
