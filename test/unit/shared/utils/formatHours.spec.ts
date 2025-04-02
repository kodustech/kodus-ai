import { convertToUTC, convertToBRT } from '@/shared/utils/formatHours';

describe('Time conversion functions', () => {
    describe('convertToUTC', () => {
        it('should correctly convert from BRT to UTC', () => {
            expect(convertToUTC('00:00')).toBe('03:00');
            expect(convertToUTC('12:00')).toBe('15:00');
            expect(convertToUTC('23:59')).toBe('02:59');
        });

        it('should throw an error for invalid format', () => {
            expect(() => convertToUTC('25:00')).toThrow(
                'Invalid time format. Use HH:MM',
            );
            expect(() => convertToUTC('12:60')).toThrow(
                'Invalid time format. Use HH:MM',
            );
            expect(() => convertToUTC('1200')).toThrow(
                'Invalid time format. Use HH:MM',
            );
        });
    });

    describe('convertToBRT', () => {
        it('should correctly convert from UTC to BRT', () => {
            expect(convertToBRT('03:00')).toBe('00:00');
            expect(convertToBRT('15:00')).toBe('12:00');
            expect(convertToBRT('02:59')).toBe('23:59');
        });

        it('should throw an error for invalid format', () => {
            expect(() => convertToBRT('25:00')).toThrow(
                'Invalid time format. Use HH:MM',
            );
            expect(() => convertToBRT('12:60')).toThrow(
                'Invalid time format. Use HH:MM',
            );
            expect(() => convertToBRT('1200')).toThrow(
                'Invalid time format. Use HH:MM',
            );
        });
    });
});
