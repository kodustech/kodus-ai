import * as fs from 'fs';
import * as path from 'path';
import { convertArrayToJSONL, convertJsonToJsonl } from './arrays';

/**
 * Returns the absolute file path by joining the given filePath with the current directory.
 *
 * @param {string} filePath - The relative file path.
 * @return {string} The absolute file path.
 */
const getFilePath = (filePath: string): string => {
    return path.join(__dirname, filePath);
};

/**
 * Reads and parses a JSON file.
 *
 * @param {string} file_path - The path to the JSON file.
 * @return {any} The parsed JSON data.
 */
const loadJsonFile = (file_path: string): any => {
    const data = fs.readFileSync(file_path, 'utf-8');
    return JSON.parse(data);
};

const createTempFileFromData = async (data, name, extension = 'json') => {
    try {
        let jsonlData: any;

        if (Array.isArray(data)) {
            jsonlData = convertArrayToJSONL(data);
        } else if (data && typeof data === 'object') {
            jsonlData = convertJsonToJsonl(data);
        }

        // Create a temporary file
        const tempFilePath = `/tmp/${name}.${extension}`;
        fs.writeFileSync(tempFilePath, jsonlData);

        // Create a read stream for the temporary file
        const fileStream = fs.createReadStream(tempFilePath);

        return fileStream;
    } catch (error) {
        console.error('Error creating file from data:', error);
    }
};

export { getFilePath, loadJsonFile, createTempFileFromData };
