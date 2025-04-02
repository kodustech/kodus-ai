import { transformKey } from './strings';

/**
 * Transforms the keys of an object recursively to a new format.
 *
 * @param {object} obj - The object whose keys will be transformed.
 * @return {object} - The object with transformed keys.
 */
const transformObjectKeys = (obj: {
    [key: string]: any;
}): { [key: string]: any } => {
    return Object.keys(obj).reduce((transformedObj, key) => {
        const transformedKey = transformKey(key);
        const value = obj[key];

        if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
        ) {
            transformedObj[transformedKey] = transformObjectKeys(value);
        } else {
            transformedObj[transformedKey] = value;
        }

        return transformedObj;
    }, {});
};

export { transformObjectKeys };
