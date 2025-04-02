import {
    join,
    map,
    pipe,
    replace,
    split,
    toLower,
    lensIndex,
    toUpper,
    over,
    splitAt,
} from 'ramda';

type StringMap = Record<string, string>;

/**
 * Removes accents from a given string.
 *
 * @param {string} str - The string from which to remove accents.
 * @return {string} The string without accents.
 */
const removeAccents = (str: string): string => {
    const accentMap: StringMap = {
        á: 'a',
        é: 'e',
        í: 'i',
        ó: 'o',
        ú: 'u',
        â: 'a',
        ê: 'e',
        î: 'i',
        ô: 'o',
        û: 'u',
        ã: 'a',
        õ: 'o',
        ç: 'c',
        à: 'a',
        ä: 'a',
        è: 'e',
        ë: 'e',
        ì: 'i',
        ï: 'i',
        ò: 'o',
        ö: 'o',
        ù: 'u',
        ü: 'u',
    };

    const replaceAccents = (char: string): string => accentMap[char] || char;

    return pipe(split(''), map(replaceAccents), join(''))(str);
};

/**
 * Removes special characters from a string.
 *
 * @param {any} str - The string to remove special characters from.
 * @return {string} The string with special characters removed.
 */
const removeSpecialChars = (str: any): string => {
    const specialCharsRegex = /[^\w\s]|[_]/gi;
    return str.replace(specialCharsRegex, '');
};

/**
 * Converts a given string to snake case.
 *
 * @param {string} str - The string to convert.
 * @return {string} The converted string in snake case.
 */
const toSnakeCase = (str: string): string => {
    return pipe(
        replace(/([A-Z]+)/, '_$1'),
        replace(/\s+/g, '_'),
        toLower,
        replace(/^_/, ''),
        split(' '),
        join('_'),
    )(str);
};

/**
 * Transforms a given key by removing accents, special characters,
 * and converting it to snake case.
 *
 * @param {string} key - The key to be transformed.
 * @return {string} The transformed key.
 */
const transformKey = (key: string): string => {
    return pipe(removeAccents, removeSpecialChars, toSnakeCase)(key);
};

/**
 * Transforms the given key by removing accents and special characters.
 *
 * @param {string} key - The key to be transformed.
 * @return {string} The transformed key.
 */
const transformValue = (key: string): string => {
    return pipe(removeAccents, removeSpecialChars)(key);
};

const stringToSeconds = (str: string) => {
    const regex = /(?:(\d+)d )?(?:(\d+)h )?(?:(\d+)m )?(?:(\d+)s)?/;
    const matches = str.match(regex);

    const days = parseInt(matches[1] || '0');
    const hours = parseInt(matches[2] || '0');
    const minutes = parseInt(matches[3] || '0');
    const seconds = parseInt(matches[4] || '0');

    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
};

function secondsToFormattedString(seconds: number) {
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;

    const result = [];
    if (days) result.push(`${days}d`);
    if (hours) result.push(`${hours}h`);
    if (minutes) result.push(`${minutes}m`);
    if (seconds || (!days && !hours && !minutes)) result.push(`${seconds}s`);

    return result.join(' ');
}

const formatString = (str: string): string =>
    pipe(splitAt(1), over(lensIndex(0), toUpper), join(''))(str);

const formatStringWithXX = (desc: string, value: string) => {
    return desc.replace('XX', Number(value)?.toFixed(2)?.replace('.', ','));
};

export {
    removeAccents,
    removeSpecialChars,
    secondsToFormattedString,
    stringToSeconds,
    toSnakeCase,
    transformKey,
    transformValue,
    formatString,
    formatStringWithXX,
};
