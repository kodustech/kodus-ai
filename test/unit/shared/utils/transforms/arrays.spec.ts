import {
    joinArrayValues,
    transformAndCreateDocuments,
    iterateAndTransformKeys,
} from '../../../../../src/shared/utils/transforms/arrays';

describe('Tests for the joinArrayValues function', () => {
    it('should return the array joined as a string', () => {
        const input = ['a', 'b', 'c'];
        const result = joinArrayValues(input);
        expect(result).toBe('a, b, c');
    });

    it('should return the value itself when it is not an array', () => {
        const input = 'input';
        const result = joinArrayValues(input);
        expect(result).toBe('input');
    });
});
describe('Tests for the transformAndCreateDocuments function', () => {
    it('should correctly transform objects and create documents', () => {
        const input = [
            { name: 'Alice', age: 25, hobbies: ['reading', 'painting'] },
            { name: 'Bob', age: 30, hobbies: ['sports'] },
        ];

        const expectedOutput = [
            {
                metadata: {} as Record<string, any>,
                pageContent:
                    'name: Alice, age: 25, hobbies: [reading,painting]',
            },
            {
                metadata: {} as Record<string, any>,
                pageContent: 'name: Bob, age: 30, hobbies: [sports]',
            },
        ];

        const result = transformAndCreateDocuments(input);

        expect(result).toEqual(expectedOutput);
    });

    it('should correctly format an object with nested properties', () => {
        const input = [
            {
                name: 'Alice',
                age: 25,
                info: { city: 'City', country: 'Country' },
            },
        ];

        const expectedOutput = [
            {
                metadata: {} as Record<string, any>,
                pageContent:
                    'name: Alice, age: 25, info: {"city":"City","country":"Country"}',
            },
        ];

        const result = transformAndCreateDocuments(input);

        expect(result).toEqual(expectedOutput);
    });
});

describe('Tests for the iterateAndTransformKeys function', () => {
    it('should correctly transform objects', () => {
        const input = [
            { 'Complete Name': 'João da silva', 'Number Age': 25 },
            { 'Complete Name': 'Françoá', 'Number Age': 30 },
        ];

        const expectedOutput = [
            { complete_name: 'João da silva', number_age: 25 },
            { complete_name: 'Françoá', number_age: 30 },
        ];

        const result = iterateAndTransformKeys(input);

        expect(result).toEqual(expectedOutput);
    });
});
