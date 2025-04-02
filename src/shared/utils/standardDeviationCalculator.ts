export class StandardDeviationCalculator {
    constructor(
        private values: number[],
        private isSample: boolean = false,
    ) {}

    private calculateMean() {
        const sum = this.values.reduce((acc, value) => acc + value, 0);
        return sum / this.values.length;
    }

    calculate() {
        if (this.values.length === 0) {
            return NaN; // Explicitly return NaN for empty arrays
        }
        const mean = this.calculateMean();
        const squaredDiffs = this.values.map((value) =>
            Math.pow(value - mean, 2),
        );
        const avgSquaredDiff =
            squaredDiffs.reduce((acc, diff) => acc + diff, 0) /
            (this.isSample ? this.values.length - 1 : this.values.length);
        return Math.sqrt(avgSquaredDiff);
    }
}
