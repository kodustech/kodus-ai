/**
 * Extracts data from a model object.
 *
 * @param {any} model - The model object to extract data from.
 * @return {any} The extracted data from the model object.
 */
const extractDataFromModel = (model: any): any => {
    const source = model['_doc'] ? model['_doc'] : model;

    const cleanedData: any = {};

    for (const key in source) {
        if (source.hasOwnProperty(key) && key !== '$__' && key !== '$isNew') {
            if (key === '_id') {
                cleanedData['uuid'] = source[key].toString();
            } else {
                cleanedData[key] = source[key];
            }
        }
    }

    return cleanedData;
};

/**
 * Maps a simple model to an entity.
 *
 * @param {T} model - The model to be mapped.
 * @param {any} entityClass - The entity class.
 * @return {U} The mapped entity.
 */
const mapSimpleModelToEntity = <T, U>(model: T, entityClass): U => {
    try {
        if (!model) {
            return null;
        }

        const entityData = extractDataFromModel(model);
        return entityClass.create(entityData);
    } catch (error) {
        console.log(error);
    }
};

/**
 * Maps an array of simple models to an array of entities.
 *
 * @param {T[]} models - The array of simple models to be mapped.
 * @param {any} entityClass - The entity class used for mapping.
 * @return {U[]} The array of mapped entities.
 */
const mapSimpleModelsToEntities = <T, U>(models: T[], entityClass): U[] => {
    try {
        if (!models || models.length === 0) {
            return null;
        }

        return models.map((model) =>
            entityClass.create(extractDataFromModel(model)),
        );
    } catch (error) {
        console.log(error);
        return [];
    }
};

/**
 * Maps a simple entity to a model.
 *
 * @param {E} entity - The entity to be mapped.
 * @param {new () => M} ModelClass - The class of the model.
 * @return {M} - The mapped model.
 */
const mapSimpleEntityToModel = <E, M>(
    entity: E,
    ModelClass: new () => M,
): M => {
    try {
        const model: any = new ModelClass();

        for (const key in entity) {
            if (entity.hasOwnProperty(key) && key.startsWith('_')) {
                // Remova o prefixo '_' e atribua o valor ao modelo
                model[key.substring(1)] = entity[key];
            } else {
                model[key] = entity[key];
            }
        }

        return model as M;
    } catch (error) {
        console.log(error);
    }
};

export {
    mapSimpleEntityToModel,
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
};
