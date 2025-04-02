import { Changelog } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import * as moment from 'moment';

export function formatAndFilterChangelog(
    histories,
    movementFilter,
): Changelog[] {
    return histories
        ?.map((history) => ({
            id: history.id,
            createdAt: moment(history.created).format('YYYY-MM-DD'),
            movements: history.items.filter(movementFilter).map((item) => ({
                field: item.field,
                fromColumnId: item.from,
                fromColumnName: item.fromString,
                toColumnId: item.to,
                toColumnName: item.toString,
            })),
        }))
        .filter(
            (changelog) =>
                changelog.movements.length > 0 &&
                changelog.field !== 'description',
        );
}
