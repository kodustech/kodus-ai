const calculatePercentageDifference = (
    oldValue: number,
    newValue: number,
): { percentageDifference: string; realDifference: number } => {
    if (oldValue === 0)
        return { percentageDifference: '0%', realDifference: 0 };
    const difference = ((newValue - oldValue) / oldValue) * 100;
    return {
        percentageDifference: Math.abs(difference).toFixed(2) + '%',
        realDifference: Math.abs(difference) < 0.1 ? 0 : Math.abs(difference),
    };
};

const calculatePercentagePointDifference = (
    oldValue: number,
    newValue: number,
): string => {
    if (oldValue === 0) return '0%';
    const difference =
        oldValue > 1 ? newValue - oldValue : (newValue - oldValue) * 100;
    return Math.abs(difference) < 0.1
        ? '0%'
        : Math.abs(difference).toFixed(1) + '%';
};

export { calculatePercentageDifference, calculatePercentagePointDifference };
