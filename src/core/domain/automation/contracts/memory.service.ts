import { IMemoryRepository } from './memory.repository';

export const MEMORY_SERVICE_TOKEN = Symbol('MemoryService');

export interface IMemoryService extends IMemoryRepository {}
