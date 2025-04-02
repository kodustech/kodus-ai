import { loadJsonFile } from '../../../../../src/shared/utils/transforms/file';

const dirname = require('path').resolve('./');

describe('Tests for the loadJsonFile function', () => {
    const inputFilePath =
        dirname + '/test/unit/shared/utils/transforms/example.json';

    it('should read and parse a JSON file', () => {
        const result = loadJsonFile(inputFilePath);
        const expectedOutput = {
            address: {
                city: 'New York',
                state: 'NY',
                street: '123 Main St',
                zip: '10001',
            },
            age: 30,
            email: 'johndoe@example.com',
            hobbies: ['reading', 'traveling', 'cooking'],
            name: 'John Doe',
        };

        expect(result).toStrictEqual(expectedOutput);
    });

    it('should throw an error if the file does not exist', () => {
        const result = () => loadJsonFile('invalid/path/' + inputFilePath);

        expect(result).toThrow('ENOENT: no such file or directory');
    });
});
