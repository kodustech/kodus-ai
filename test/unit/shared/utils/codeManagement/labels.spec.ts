import { getLabelShield } from '@/shared/utils/codeManagement/labels';

describe('labels', () => {
    it('should return the appropiate shield for the label', () => {
        let label = 'performance_and_optimization';
        let shield = getLabelShield(label);
        expect(shield).toBe(
            '![Performance and Optimization](https://img.shields.io/badge/Performance_and_Optimization-00C853)',
        );

        label = 'security';
        shield = getLabelShield(label);
        expect(shield).toBe(
            '![Security](https://img.shields.io/badge/Security-D50000)',
        );

        label = 'error_handling';
        shield = getLabelShield(label);
        expect(shield).toBe(
            '![Error Handling](https://img.shields.io/badge/Error_Handling-FF6D00)',
        );

        label = 'refactoring';
        shield = getLabelShield(label);
        expect(shield).toBe(
            '![Refactoring](https://img.shields.io/badge/Refactoring-304FFE)',
        );

        label = 'maintainability';
        shield = getLabelShield(label);
        expect(shield).toBe(
            '![Maintainability](https://img.shields.io/badge/Maintainability-0091EA)',
        );

        label = 'potential_issues';
        shield = getLabelShield(label);
        expect(shield).toBe(
            '![Potential Issues](https://img.shields.io/badge/Potential_Issues-B71C1C)',
        );

        label = 'code_style';
        shield = getLabelShield(label);
        expect(shield).toBe(
            '![Code Style](https://img.shields.io/badge/Code_Style-6A1B9A)',
        );

        label = 'documentation_and_comments';
        shield = getLabelShield(label);
        expect(shield).toBe(
            '![Documentation and Comments](https://img.shields.io/badge/Documentation_and_Comments-D81B60)',
        );

        label = 'kody_rules';
        shield = getLabelShield(label);
        expect(shield).toBe(
            '![Kody Rules](https://img.shields.io/badge/Kody_Rules-4527A0)',
        );
    });

    it('should return empty string for invalid or missing label', () => {
        let label = 'invalid_label';
        let shield = getLabelShield(label);
        expect(shield).toBe('');

        label = '';
        shield = getLabelShield(label);
        expect(shield).toBe('');
    });
});
