// StandardDeviationCalculator.test.ts

import { StandardDeviationCalculator } from '@/shared/utils/standardDeviationCalculator';

describe('StandardDeviationCalculator', () => {
    it('should calculate the population standard deviation correctly', () => {
        const values = [2, 4, 4, 4, 5, 5, 7, 9];
        const calculator = new StandardDeviationCalculator(values);
        const result = calculator.calculate();
        expect(result).toBeCloseTo(2);
    });

    it('should calculate the sample standard deviation correctly', () => {
        const values = [2, 4, 4, 4, 5, 5, 7, 9];
        const calculator = new StandardDeviationCalculator(values, true);
        const result = calculator.calculate();
        expect(result).toBeCloseTo(2.138089935299395);
    });

    it('should return 0 for a single value', () => {
        const values = [5];
        const calculator = new StandardDeviationCalculator(values);
        const result = calculator.calculate();
        expect(result).toBe(0);
    });

    it('should return NaN for an empty array', () => {
        const values: number[] = [];
        const calculator = new StandardDeviationCalculator(values);
        const result = calculator.calculate();
        expect(result).toBeNaN();
    });

    it('should handle negative numbers correctly', () => {
        const values = [-5, -3, -1, 1, 3, 5];
        const calculator = new StandardDeviationCalculator(values);
        const result = calculator.calculate();
        expect(result).toBeCloseTo(3.415650255319866, 4);
    });

    it('should handle floating point numbers correctly', () => {
        const values = [2.5, 3.6, 3.6, 3.6, 4.7, 4.7, 6.8, 8.9];
        const calculator = new StandardDeviationCalculator(values);
        const result = calculator.calculate();
        expect(result).toBeCloseTo(1.95, 2);
    });

    it('should handle large ranges of numbers', () => {
        const values = [100, 200, 300, 400, 500];
        const calculator = new StandardDeviationCalculator(values);
        const result = calculator.calculate();
        expect(result).toBeCloseTo(141.42, 2);
    });
});
