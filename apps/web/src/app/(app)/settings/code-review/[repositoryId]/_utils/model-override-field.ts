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
