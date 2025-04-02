/**
 * Creates nested conditions based on a prefix and a filter object.
 *
 * @param {string} prefix - The prefix to use for creating the nested conditions.
 * @param {Partial<T>} filterObject - The filter object used to create the conditions.
 * @return {Record<string, any>} The nested conditions created based on the prefix and filter object.
 */
const createNestedConditions = <T>(
    prefix: string,
    filterObject?: Partial<T>,
): Record<string, any> => {
    if (!filterObject) {
        return {};
    }

    return Object.keys(filterObject).reduce((conditions, key) => {
        conditions[`${prefix}.${key}`] = filterObject[key];
        return conditions;
    }, {});
};

export { createNestedConditions };
