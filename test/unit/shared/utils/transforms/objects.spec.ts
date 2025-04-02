import { transformObjectKeys } from '../../../../../src/shared/utils/transforms/objects';

describe('Tests for the transformObjectKeys function', () => {
    it('should correctly transform simple keys', () => {
        const input = { 'First Name': 'John', 'Last Name': 'Doe' };
        const expectedOutput = { first_name: 'John', last_name: 'Doe' };

        const result = transformObjectKeys(input);

        expect(result).toStrictEqual(expectedOutput);
    });

    it('should correctly transform nested keys', () => {
        const input = {
            'Person Info': {
                'Full Name': 'Jane Smith',
                'Age': 30,
            },
        };

        const expectedOutput = {
            person_info: {
                full_name: 'Jane Smith',
                age: 30,
            },
        };

        const result = transformObjectKeys(input);

        expect(result).toStrictEqual(expectedOutput);
    });

    it('should preserve unaffected properties', () => {
        const input = {
            name: 'Alice',
            age: 25,
            hobbies: ['reading', 'painting'],
            details: {
                city: 'Anytown',
            },
        };

        const result = transformObjectKeys(input);

        expect(result).toStrictEqual(input);
    });
});
