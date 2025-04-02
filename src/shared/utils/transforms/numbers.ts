/**
 * Rounds a number to two decimal places.
 *
 * @param {number} num - the number to round
 * @return {number} the rounded number
 */
const roundToTwoDecimalPlaces = (num: number): number => {
    return num ? parseFloat(num.toFixed(2)) : 0;
};

/**
 * Check if the given value is a strictly formatted number.
 *
 * @param {string} value - The value to be checked.
 * @return {boolean} Whether the value is a strictly formatted number or not.
 */
const isStrictlyNumber = (value: string): boolean => {
    return /^[+-]?\d+(\.\d+)?$/.test(value);
};

/**
 * Extracts a number from the given string.
 *
 * @param {string} s - the input string
 * @return {number | null} the extracted number, or null if no number is found
 */
const extractNumberFromString = (s: string): number | null => {
    const match = s.match(/\d+/);
    if (match) {
        return parseInt(match[0], 10);
    }
    return null;
};

export { roundToTwoDecimalPlaces, extractNumberFromString, isStrictlyNumber };
