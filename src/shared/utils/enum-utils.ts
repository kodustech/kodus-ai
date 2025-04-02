import { IntegrationCategory } from '../domain/enums/integration-category.enum';
import { PlatformType } from '../domain/enums/platform-type.enum';

function camelCaseToUpperCaseWithUnderscores(value: string): string {
    return value
        .replace(/([a-z])([A-Z])/g, '$1_$2') // Adds an underscore between lowercase and uppercase letters
        .replace(/[-_]/g, '_') // Replaces dashes or underscores with underscores
        .toUpperCase(); // Converts everything to uppercase
}

/**
 * Converts a string value to a PlatformType enum value if it exists, otherwise returns undefined.
 *
 * @param {string} value - The string value to be converted.
 * @return {PlatformType | undefined} The PlatformType enum value if the string value matches, otherwise undefined.
 */
export const toPlatformType = (value: string): PlatformType | undefined => {
    if (!value) {
        return undefined;
    }

    const formattedValue = camelCaseToUpperCaseWithUnderscores(value);
    return Object.values(PlatformType).includes(formattedValue as PlatformType)
        ? (formattedValue as PlatformType)
        : undefined;
};

/**
 * Converts a string value to an IntegrationCategory enum value if it exists, otherwise returns undefined.
 *
 * @param {string} value - The string value to be converted.
 * @return {IntegrationCategory | undefined} The IntegrationCategory enum value if the string value matches, otherwise undefined.
 */
export const toIntegrationCategory = (
    value: string,
): IntegrationCategory | undefined => {
    if (!value) {
        return undefined;
    }

    const formattedValue = camelCaseToUpperCaseWithUnderscores(value);
    return Object.values(IntegrationCategory).includes(
        formattedValue as IntegrationCategory,
    )
        ? (formattedValue as IntegrationCategory)
        : undefined;
};
