import {
    transformKey,
    toSnakeCase,
    removeAccents,
    removeSpecialChars,
    transformValue,
} from '../../../../../src/shared/utils/transforms/strings';

describe('Test for the removeAccents function', () => {
    it('should remove accents', () => {
        const input = 'áàãâä éèêë íìîï óòõôö úùûü ç';
        const result = removeAccents(input);

        expect(result).toBe('aaaaa eeee iiii ooooo uuuu c');
    });
});

describe('Test for the removeSpecialChars function', () => {
    it('should remove special characters', () => {
        const input = 'Special characters!_"#$%&\'()*+,-./:;<=>?@[\\]^`{|}~';
        const result = removeSpecialChars(input);

        expect(result).toBe('Special characters');
    });
});

describe('Test for the toSnakeCase function', () => {
    it('should convert to snake case', () => {
        const input = '_aString to TEST TESTED ';
        const result = toSnakeCase(input);

        expect(result).toBe('a_string_to_test_tested_');
    });
});

describe('Test for the transformKey function', () => {
    it('should convert to snake case, remove accents and special characters', () => {
        const input = 'João da Silva SANTOS%$#';
        const result = transformKey(input);

        expect(result).toBe('joao_da_silva_santos');
    });
});

describe('Test for the transformValue function', () => {
    it('should remove accents and special characters', () => {
        const input = 'João da Silva SANTOS#%$';
        const result = transformValue(input);

        expect(result).toBe('Joao da Silva SANTOS');
    });
});
