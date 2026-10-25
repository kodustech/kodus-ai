import type { BusinessLogicSettingsValue } from "@services/business-logic/types";
import { useFormContext } from "react-hook-form";
import { unformatConfig } from "src/core/utils/helpers";

import type { CodeReviewFormType } from "../../../_types";

/** The Business Logic settings as they are on screen, saved or not. */
export const useScreenSettings = () => {
    const form = useFormContext<CodeReviewFormType>();
    return (): BusinessLogicSettingsValue | undefined => {
        const current = form.getValues("businessLogic" as never);
        return current
            ? (unformatConfig(current as never) as BusinessLogicSettingsValue)
            : undefined;
    };
};
