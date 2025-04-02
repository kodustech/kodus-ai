import { GetCheckinConfigUseCase } from './get-checkin-config.use-case';
import { GetSectionsInfoUseCase } from './get-sections-info.use-case';
import { SaveCheckinConfigUseCase } from './save-checkin-config.use-case';

export const UseCases = [
    GetSectionsInfoUseCase,
    SaveCheckinConfigUseCase,
    GetCheckinConfigUseCase,
];
