import { CodeManagementController } from '../../../../apps/api/src/controllers/codeManagement.controller';

describe('CodeManagementController.getOrganizationMemberLabels', () => {
    const call = (ids?: string | string[]) => {
        const execute = jest.fn().mockResolvedValue({});
        CodeManagementController.prototype.getOrganizationMemberLabels.call(
            { getMemberLabelsUseCase: { execute } },
            { teamId: 'team-1', ids },
        );
        return execute;
    };

    it('splits a comma-separated ids parameter', () => {
        expect(call('7,8')).toHaveBeenCalledWith('team-1', ['7', '8']);
    });

    it('accepts a repeated ids parameter', () => {
        expect(call(['7', '8,9'])).toHaveBeenCalledWith('team-1', [
            '7',
            '8',
            '9',
        ]);
    });

    it('passes no ids when the parameter is missing', () => {
        expect(call()).toHaveBeenCalledWith('team-1', ['']);
    });
});
