import { equals, join, pipe, props, sortBy } from 'ramda';
import { createDocument } from '../langchainCommon/document';
import { transformObjectKeys } from './objects';

/**
 * A function that joins the values of an array into a string, separated by commas.
 *
 * @param {any} value - The value to be joined. It can be an array or any other value.
 * @return {any} - The joined string if the value is an array, otherwise the value itself.
 */
const joinArrayValues = (value: any): any => {
    return Array.isArray(value) ? value.join(', ') : value;
};

/**
 * Transforms an array of objects and creates documents based on the transformed values.
 *
 * @param {Array<Record<string, any>>} array - The array of objects to transform and create documents from.
 * @return {Array<Record<string, any>>} - The array of created documents Langchain Type.
 */
const transformAndCreateDocuments = (
    array: Array<Record<string, any>>,
): Array<Record<string, any>> => {
    return array.map((item) => {
        const formattedProps = Object.entries(item)
            .map(([key, value]) => {
                if (Array.isArray(value)) {
                    const formattedValue = value.map((v) => joinArrayValues(v));
                    return `${key}: [${formattedValue}]`;
                } else if (typeof value === 'object' && value !== null) {
                    const formattedValue = JSON.stringify(value);
                    return `${key}: ${formattedValue}`;
                } else {
                    return `${key}: ${value}`;
                }
            })
            .join(', ');

        return createDocument(formattedProps);
    });
};

/**
 * Iterates over an array of objects and transforms the keys of each object.
 *
 * @param {Array<Record<string, any>>} array - The array of objects to iterate over and transform the keys.
 * @return {Array<Record<string, any>>} - The array of objects with transformed keys.
 */
const iterateAndTransformKeys = (
    array: Array<Record<string, any>>,
): Array<Record<string, any>> => {
    return array.map(transformObjectKeys);
};

const arraysHaveSameValuesBy = (fields, arr1, arr2) => {
    const createKey = pipe(props(fields), join(''));
    const sortByFields = sortBy(createKey);

    return equals(sortByFields(arr1), sortByFields(arr2));
};

const convertArrayToJSONL = (jsonArray) => {
    if (!Array.isArray(jsonArray)) {
        throw new Error('Input is not an array');
    }

    return jsonArray.map((item) => JSON.stringify(item)).join('\n');
};

const convertJsonToJsonl = (data) => {
    if (!data || typeof data !== 'object') {
        throw new Error('Input data is not a valid JSON object');
    }

    const jsonlData = [];

    const addToJsonl = (obj, parentKey = '') => {
        for (const key in obj) {
            const currentKey = parentKey ? `${parentKey}.${key}` : key;

            if (Array.isArray(obj[key])) {
                obj[key].forEach((item, index) => {
                    addToJsonl(item, `${currentKey}[${index}]`);
                });
            } else if (obj[key] === null) {
                jsonlData.push(JSON.stringify({ [currentKey]: null }));
            } else if (typeof obj[key] === 'object') {
                addToJsonl(obj[key], currentKey);
            } else {
                jsonlData.push(JSON.stringify({ [currentKey]: obj[key] }));
            }
        }
    };

    addToJsonl(data);

    return jsonlData.join('\n');
};

export {
    iterateAndTransformKeys,
    joinArrayValues,
    transformAndCreateDocuments,
    arraysHaveSameValuesBy,
    convertArrayToJSONL,
    convertJsonToJsonl,
};
