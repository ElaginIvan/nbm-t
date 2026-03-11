/**
 * Сервис для работы со спецификацией модели
 * Отвечает за загрузку CSV, извлечение структуры модели и подсветку деталей
 */

import { loadCSV, findInCSV, getBaseDesignation } from '../utils/csv.js';
import { store } from '../store.js';

/**
 * Очищает имя от суффиксов Three.js (например, удаляет :0, :1 и т.д.)
 * @param {string} name - Имя с суффиксом
 * @returns {string} Очищенное имя
 */
function cleanName(name) {
    if (!name) return '';
    return name.replace(/:\d+$/, '').trim();
}

/**
 * Сервис спецификации
 */
export const SpecificationService = {
    /**
     * Загружает данные спецификации из CSV файла
     * @param {string} projectId - ID проекта
     * @returns {Promise<Array<Object>>} Массив данных CSV
     */
    async loadCSVData(projectId) {
        if (!projectId) {
            console.warn('Project ID not provided for CSV loading');
            return [];
        }

        const csvPath = `models/${projectId}/spec.csv`;
        const csvData = await loadCSV(csvPath);
        
        store.setState('specification.csvData', csvData);
        return csvData;
    },

    /**
     * Находит данные для обозначения в CSV
     * @param {string} designation - Обозначение
     * @returns {Object|null} Данные из CSV или null
     */
    findCSVData(designation) {
        const csvData = store.getState('specification.csvData');
        return findInCSV(designation, csvData);
    },

    /**
     * Подсчитывает количество экземпляров в группе
     * @param {Object} group - Группа объектов
     * @returns {number} Количество экземпляров
     */
    countInstancesInGroup(group) {
        if (!group || !group.threeObjects) return 0;

        // Если это сборка (имеет детей), считаем количество уникальных объектов
        if (group.children && group.children.length > 0) {
            const uniqueObjects = new Set();
            group.threeObjects.forEach(obj => {
                uniqueObjects.add(obj.uuid);
            });
            return uniqueObjects.size;
        }

        // Для деталей считаем количество мешей
        if (group.meshObjects && group.meshObjects.length > 0) {
            return group.meshObjects.length;
        }

        return 1;
    },

    /**
     * Извлекает структуру из 3D модели
     * @param {THREE.Object3D} threeModel - 3D модель
     * @returns {Array} Структура модели
     */
    extractModelStructure(threeModel) {
        const structure = [];
        const nodeMap = new Map();
        const parentChainCache = new Map();

        const getParentChain = (obj, parentObj) => {
            if (!parentObj) return 'root';

            const cacheKey = obj.uuid + '_' + (parentObj?.uuid || 'null');
            if (parentChainCache.has(cacheKey)) {
                return parentChainCache.get(cacheKey);
            }

            const chain = [];
            let current = parentObj;
            while (current) {
                const parentName = cleanName(current.userData?.name || current.name || '');
                chain.push(parentName);
                current = nodeMap.has(current) ?
                    structure[nodeMap.get(current)]?.parentObject : null;
            }

            const chainKey = chain.reverse().join('->');
            parentChainCache.set(cacheKey, chainKey);
            return chainKey;
        };

        const processObject = (obj, level = 0, parentObj = null) => {
            if (obj.type === 'Camera' || obj.type === 'Light' || obj.isMesh) {
                return null;
            }

            let originalName = (obj.userData && obj.userData.name) ? obj.userData.name : obj.name;
            let displayName = cleanName(originalName) || `Группа ${structure.length + 1}`;

            const parentChain = getParentChain(obj, parentObj);
            const groupKey = `${displayName}_${level}_${parentChain}`;

            let group = null;
            let groupIndex = -1;

            for (let i = 0; i < structure.length; i++) {
                const existingGroup = structure[i];
                if (existingGroup.key === groupKey) {
                    group = existingGroup;
                    groupIndex = i;
                    break;
                }
            }

            if (!group) {
                group = {
                    key: groupKey,
                    name: displayName,
                    originalName: originalName,
                    level: level,
                    parentChain: parentChain,
                    children: [],
                    threeObjects: [],
                    meshObjects: [],
                    parentObject: parentObj,
                    csvData: null,
                    instanceCount: 1
                };
                groupIndex = structure.length;
                structure.push(group);
            } else {
                group.instanceCount += 1;
            }

            group.threeObjects.push(obj);
            nodeMap.set(obj, groupIndex);

            obj.traverse((child) => {
                if (child.isMesh && !group.meshObjects.includes(child)) {
                    group.meshObjects.push(child);
                }
            });

            if (obj.children?.length > 0) {
                for (const child of obj.children) {
                    const childIndex = processObject(child, level + 1, obj);
                    if (childIndex !== null && !group.children.includes(childIndex)) {
                        group.children.push(childIndex);
                    }
                }
            }

            return groupIndex;
        };

        if (threeModel && threeModel.children) {
            threeModel.children.forEach(child => {
                processObject(child, 0, null);
            });
        }

        const finalStructure = [];
        const uniqueKeys = new Set();
        // Используем Map для O(1) поиска вместо O(n) findIndex
        const structureMap = new Map();

        structure.forEach(group => {
            const parentName = group.parentObject ?
                cleanName(group.parentObject.userData?.name || group.parentObject.name || '') :
                'root';

            const uniqueKey = `${group.name}_${group.level}_${parentName}`;

            if (!uniqueKeys.has(uniqueKey)) {
                uniqueKeys.add(uniqueKey);

                // Ищем данные в CSV по очищенному имени
                const csvMatch = this.findCSVData(group.name);
                if (csvMatch) {
                    group.csvData = csvMatch;
                }

                // Вычисляем итоговое количество экземпляров
                group.instanceCount = this.countInstancesInGroup(group);

                finalStructure.push(group);
                structureMap.set(uniqueKey, group);
            } else {
                // O(1) поиск вместо O(n) findIndex
                const existingGroup = structureMap.get(uniqueKey);
                
                if (existingGroup) {
                    existingGroup.threeObjects.push(...group.threeObjects);
                    existingGroup.meshObjects.push(...group.meshObjects);
                    existingGroup.instanceCount += 1;

                    group.children.forEach(childIndex => {
                        if (!existingGroup.children.includes(childIndex)) {
                            existingGroup.children.push(childIndex);
                        }
                    });
                }
            }
        });

        // Статистика
        const total = finalStructure.length;
        const matches = finalStructure.filter(g => g.csvData).length;
        console.log(`📊 CSV matching statistics: ${matches}/${total} matches found (${Math.round(matches / total * 100)}%)`);

        return finalStructure;
    },

    /**
     * Сохраняет структуру модели в store
     * @param {THREE.Object3D} threeModel - 3D модель
     * @param {string} projectId - ID проекта
     */
    async saveModelStructure(threeModel, projectId) {
        try {
            store.setState('specification.isLoading', true);
            
            // Загружаем CSV данные
            await this.loadCSVData(projectId);
            
            // Извлекаем структуру модели
            const structure = this.extractModelStructure(threeModel);
            store.setState('specification.structure', structure);
            
            // Выводим итоговую статистику
            const totalParts = structure.reduce((sum, item) => sum + (item.instanceCount || 1), 0);
            console.log(`Итого: ${structure.length} позиций, ${totalParts} деталей в модели`);
            
        } catch (error) {
            console.error('Error in saveModelStructure:', error);
        } finally {
            store.setState('specification.isLoading', false);
        }
    },

    /**
     * Подсвечивает или скрывает детали по имени
     * @param {string} partName - Имя детали
     * @param {boolean} hideOthers - Скрывать ли остальные детали
     */
    highlightParts(partName, hideOthers = true) {
        // Сохраняем выбранную деталь в store
        store.setState('specification.lastSelectedPart', partName);
        
        const structure = store.getState('specification.structure');
        const model = store.getState('model.object');

        if (!structure || !model) {
            console.warn('Model structure not loaded');
            return;
        }

        // Сначала показываем и сбрасываем все
        structure.forEach(item => {
            if (item.threeObjects) {
                item.threeObjects.forEach(obj => {
                    obj.traverse((child) => {
                        if (child.isMesh) {
                            // Восстанавливаем оригинальный материал если есть
                            if (child.userData.originalMaterial) {
                                child.material = child.userData.originalMaterial;
                            }

                            // Убираем подсветку
                            if (child.material.emissive) {
                                child.material.emissive.setHex(0x000000);
                            }

                            // Показываем все
                            child.visible = true;
                        }
                    });
                });
            }
        });

        // Если передано пустое имя, просто показываем все
        if (!partName) {
            return;
        }

        // Ищем все группы с таким именем
        const groupsToShow = structure.filter(item =>
            item.name.toLowerCase() === partName.toLowerCase()
        );

        if (groupsToShow.length === 0) {
            console.warn(`Part "${partName}" not found in structure`);
            return;
        }

        // Собираем все меши из выбранных групп
        const meshesToShow = new Set();
        groupsToShow.forEach(group => {
            if (group.threeObjects) {
                group.threeObjects.forEach(obj => {
                    obj.traverse((child) => {
                        if (child.isMesh) {
                            meshesToShow.add(child);
                        }
                    });
                });
            }
        });

        if (hideOthers) {
            // Скрываем все меши, которые не в выбранных группах
            structure.forEach(item => {
                if (!groupsToShow.includes(item) && item.threeObjects) {
                    item.threeObjects.forEach(obj => {
                        obj.traverse((child) => {
                            if (child.isMesh && !meshesToShow.has(child)) {
                                child.visible = false;
                            }
                        });
                    });
                }
            });
        }

        console.log(`Showing ${meshesToShow.size} meshes for part "${partName}"`);
    },

    /**
     * Показывает все детали
     */
    showAllParts() {
        // Сбрасываем сохраненное выделение
        store.setState('specification.lastSelectedPart', null);
        
        const structure = store.getState('specification.structure');
        if (!structure) return;

        structure.forEach(item => {
            if (item.threeObjects) {
                item.threeObjects.forEach(obj => {
                    obj.traverse((child) => {
                        if (child.isMesh) {
                            // Восстанавливаем оригинальный материал
                            if (child.userData.originalMaterial) {
                                child.material = child.userData.originalMaterial;
                            }

                            // Убираем подсветку
                            if (child.material.emissive) {
                                child.material.emissive.setHex(0x000000);
                            }

                            // Показываем все
                            child.visible = true;
                        }
                    });
                });
            }
        });
    },

    /**
     * Рендерит таблицу спецификации
     * @param {Function} renderCallback - Callback для рендеринга (получает structure)
     */
    renderSpecificationTable(renderCallback) {
        const structure = store.getState('specification.structure');

        if (!structure || structure.length === 0) {
            renderCallback([]);
            return;
        }

        renderCallback(structure);
    },

    /**
     * Получает последнюю выбранную деталь
     * @returns {string|null} Имя детали
     */
    getLastSelectedPart() {
        return store.getState('specification.lastSelectedPart');
    },

    /**
     * Очищает данные спецификации
     */
    clear() {
        store.setState('specification.structure', []);
        store.setState('specification.csvData', []);
        store.setState('specification.lastSelectedPart', null);
        store.setState('specification.isLoading', false);
    }
};

// Экспортируем cleanName для использования в других модулях
export { cleanName };
