type ParamsResult = {
    [key: string]: any;
};

/**
 * Retrieves and combines the specified dependencies from the input object.
 *
 * @param {any} input - the input object
 * @param {string[]} dependencies - an array of strings specifying the dependencies to retrieve
 * @return {any} the combined parameters retrieved from the input dependencies
 */
const getDependenciesParams = (input: any, dependencies: string[]): any => {
    let combinedParams = {};

    dependencies.forEach((dependency) => {
        if (input[dependency]) {
            combinedParams = { ...combinedParams, ...input[dependency] };
        }
    });

    return combinedParams;
};

/**
 * Finds and returns specified keys and values from a nested object.
 *
 * @param {object} obj - The object to search for keys and values.
 * @param {string[]} keysToFind - The keys to search for in the object.
 * @return {ParamsResult} An object containing the found keys and values.
 */
const findToolParamsRecursively = (
    obj: object,
    keysToFind: string[],
): ParamsResult => {
    const result: ParamsResult = {};

    const search = (currentObj: object): void => {
        Object.entries(currentObj).forEach(([key, value]) => {
            if (keysToFind.includes(key)) {
                result[key] = value;
            }

            if (value !== null && typeof value === 'object') {
                search(value);
            }
        });
    };

    search(obj);
    return result;
};

/**
 * Finds all parameters for specified keys in an object.
 *
 * @param {Record<string, any>} obj - The object to search for keys in.
 * @param {string[]} keysToFind - An array of keys to find in the object.
 * @return {ParamsResult} An object containing the found key-value pairs.
 */
const findTopLevelToolParams = (
    obj: Record<string, any>,
    keysToFind: string[],
): ParamsResult => {
    const result: ParamsResult = {};

    keysToFind.forEach((key) => {
        if (obj.hasOwnProperty(key)) {
            result[key] = obj[key];
        }
    });

    return result;
};

export {
    getDependenciesParams,
    findToolParamsRecursively,
    findTopLevelToolParams,
};
