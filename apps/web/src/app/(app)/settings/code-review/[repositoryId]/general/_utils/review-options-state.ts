import { FormattedConfigLevel } from "../../../_types";

type ReviewOptionValue = {
    value: boolean;
    level: FormattedConfigLevel;
};

type ReviewOptionsState = Record<string, ReviewOptionValue>;

type ReviewLabel = {
    type: string;
    name: string;
    description: string;
};

export const mergeMissingReviewOptions = (
    currentOptions: ReviewOptionsState,
    labelTypes: string[],
): ReviewOptionsState => {
    let nextOptions = currentOptions;

    labelTypes.forEach((labelType) => {
        if (nextOptions[labelType]) {
            return;
        }

        if (nextOptions === currentOptions) {
            nextOptions = { ...currentOptions };
        }

        nextOptions[labelType] = {
            value: false,
            level: FormattedConfigLevel.DEFAULT,
        };
    });

    return nextOptions;
};

export const filterVisibleReviewLabels = (
    labels: ReviewLabel[],
    isBusinessLogicEnabled: boolean,
): ReviewLabel[] =>
    labels.filter(
        (label) => isBusinessLogicEnabled || label.type !== "business_logic",
    );
