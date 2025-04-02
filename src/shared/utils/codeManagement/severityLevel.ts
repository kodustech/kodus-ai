import { SeverityLevel } from '../enums/severityLevel.enum';

enum ShieldColor {
    LOW_BLUE = '1A8EBC',
    MEDIUM_BLUE = '1A7BBE',
    HIGH_PURPLE = '6B6B92',
    CRITICAL_RED = 'FF3D3D'
}

const getSeverityLevelShield = (severityLevel: SeverityLevel) => {
    const labelTitle = 'severity_level'
    const shield = `![${severityLevel}](https://img.shields.io/badge/${labelTitle}-${severityLevel.replace(/ /g, '\_')}-`;

    switch (severityLevel) {
        case SeverityLevel.LOW:
            return `${shield}${ShieldColor.LOW_BLUE})`;
        case SeverityLevel.MEDIUM:
            return `${shield}${ShieldColor.MEDIUM_BLUE})`;
        case SeverityLevel.HIGH:
            return `${shield}${ShieldColor.HIGH_PURPLE})`;
        case SeverityLevel.CRITICAL:
            return `${shield}${ShieldColor.CRITICAL_RED})`;
        default:
            return '';
    }
};

export { getSeverityLevelShield };
