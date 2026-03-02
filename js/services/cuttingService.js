/**
 * Сервис для раскроя материалов
 * Отвечает за загрузку данных, группировку и алгоритм раскроя
 */

import { loadCSV, parseCSV, decodeCSV, splitCSVLine } from '../utils/csv.js';
import { cuttingStore, specificationStore } from '../store.js';

/**
 * Парсит строку материала для получения типа и длины
 * @param {string} materialString - Строка с материалом (напр. "Труба 40х60х2 L=400")
 * @returns {Object|null} Объект с type и length или null
 */
function parseMaterialString(materialString) {
    if (!materialString) return null;

    const match = materialString.match(/^(.*?)\s*L\s*=\s*(\d+\.?\d*)\s*$/i);

    if (match) {
        return {
            type: match[1].trim(),
            length: parseFloat(match[2])
        };
    }

    return {
        type: materialString.trim(),
        length: null
    };
}

/**
 * Получает ID проекта из различных источников
 * @returns {string|null} ID проекта или null
 */
export function getProjectId() {
    const projectData = document.getElementById('project-data');
    if (projectData && projectData.getAttribute('data-project-id')) {
        return projectData.getAttribute('data-project-id');
    }

    const urlParams = new URLSearchParams(window.location.search);
    const projectIdFromUrl = urlParams.get('project');
    if (projectIdFromUrl) {
        return projectIdFromUrl;
    }

    const projectIdFromStorage = localStorage.getItem('selectedProject');
    if (projectIdFromStorage) {
        return projectIdFromStorage;
    }

    return null;
}

/**
 * Группирует материалы по типу с учетом количества из модели
 */
function groupMaterialsByType(csvData, modelStructure) {
    const materialsMap = new Map();

    // Создаем карту для быстрого поиска количества по обозначению
    const quantityMap = new Map();

    // Заполняем карту количеств из структуры модели
    modelStructure.forEach(item => {
        if (item.name) {
            const cleanName = item.name.trim();
            const quantity = item.instanceCount || 1;

            // Добавляем в карту
            quantityMap.set(cleanName, quantity);

            // Также проверяем частичные совпадения (без суффиксов)
            const parts = cleanName.split(/[-_.]/);
            if (parts.length > 1) {
                const baseName = parts[0] + '.' + parts[1];
                if (baseName !== cleanName) {
                    if (quantityMap.has(baseName)) {
                        quantityMap.set(baseName, quantityMap.get(baseName) + quantity);
                    } else {
                        quantityMap.set(baseName, quantity);
                    }
                }
            }

            // Для обозначений типа "КТ-01.001"
            const match = cleanName.match(/^([A-ZА-ЯЁ]+-\d+\.\d+)/);
            if (match && match[1] !== cleanName) {
                const baseDesignation = match[1];
                if (quantityMap.has(baseDesignation)) {
                    quantityMap.set(baseDesignation, quantityMap.get(baseDesignation) + quantity);
                } else {
                    quantityMap.set(baseDesignation, quantity);
                }
            }
        }
    });

    // Обрабатываем данные из CSV
    csvData.forEach((row) => {
        const designation = row['Обозначение'];
        const material = row['Описание'];

        if (!designation || !material) return;

        // Парсим материал
        const parsedMaterial = parseMaterialString(material);
        if (!parsedMaterial || !parsedMaterial.type || parsedMaterial.length === null) {
            return;
        }

        // Находим количество из модели
        let quantity = 1;

        const searchKeys = [
            designation,
            designation.replace(/-\d+$/, ''),
            designation.match(/^([A-ZА-ЯЁ]+-\d+\.\d+)/)?.[1],
            designation.split('-')[0] + '.' + designation.split('-')[1]?.split('.')[0]
        ].filter(Boolean);

        for (const key of searchKeys) {
            if (quantityMap.has(key)) {
                quantity = quantityMap.get(key);
                break;
            }
        }

        // Если не нашли в модели, используем количество из CSV
        if (quantity === 1) {
            const csvQuantity = parseInt(row['КОЛ.']) || parseInt(row['Кол.']) || parseInt(row['Количество']) || 1;
            quantity = csvQuantity;
        }

        if (quantity <= 0) return;

        const key = parsedMaterial.type;
        const length = parsedMaterial.length;

        if (!materialsMap.has(key)) {
            materialsMap.set(key, []);
        }

        // Добавляем деталь с нужным количеством
        for (let i = 0; i < quantity; i++) {
            materialsMap.get(key).push({ length });
        }
    });

    // Преобразуем Map в объект с группировкой по длинам
    const result = {};
    materialsMap.forEach((parts, materialType) => {
        const groupedParts = {};
        parts.forEach(part => {
            const lengthKey = part.length.toString();
            if (!groupedParts[lengthKey]) {
                groupedParts[lengthKey] = { length: part.length, quantity: 0 };
            }
            groupedParts[lengthKey].quantity++;
        });

        result[materialType] = Object.values(groupedParts);
    });

    return result;
}

/**
 * Сервис раскроя
 */
export const CuttingService = {
    /**
     * Загружает данные для раскроя из CSV файла и структуры модели
     * @returns {Promise<Object>} Данные для раскроя
     */
    async loadCuttingData() {
        try {
            cuttingStore.setLoading(true);

            const projectId = getProjectId();
            if (!projectId) {
                console.warn('Project ID not found for cutting data');
                return {};
            }

            const csvPath = `models/${projectId}/spec.csv`;
            const response = await fetch(csvPath);
            
            if (!response.ok) {
                console.warn(`CSV file not found: ${csvPath}`);
                return {};
            }

            const buffer = await response.arrayBuffer();
            const csvText = decodeCSV(buffer);
            const csvData = parseCSV(csvText);

            const modelStructure = specificationStore.getStructure() || [];
            const materialsData = groupMaterialsByType(csvData, modelStructure);

            cuttingStore.setMaterialsData(materialsData);
            return materialsData;

        } catch (error) {
            console.error('Error loading cutting data:', error);
            return {};
        } finally {
            cuttingStore.setLoading(false);
        }
    },

    /**
     * Выполняет раскрой материалов по алгоритму First Fit Decreasing
     * @param {Object} options - Опции раскроя
     * @returns {Promise<Map>} Результаты раскроя
     */
    async performCutting(options = {}) {
        const {
            stockLength = 6000,
            kerf = 0,
            multiplicity = 1
        } = options;

        let materialsData = cuttingStore.getMaterialsData();
        
        // Если данные не загружены, загружаем их
        if (Object.keys(materialsData).length === 0) {
            materialsData = await this.loadCuttingData();
        }

        if (Object.keys(materialsData).length === 0) {
            return new Map();
        }

        const allResults = new Map();

        // Итерируемся по каждому материалу
        for (const [materialName, parts] of Object.entries(materialsData)) {
            const partsToCut = [];

            // Подготавливаем детали с учетом кратности
            for (const item of parts) {
                if (item.length > stockLength) {
                    console.warn(`Part ${item.length}mm exceeds stock length ${stockLength}mm`);
                    continue;
                }

                const totalQuantity = item.quantity * multiplicity;
                for (let i = 0; i < totalQuantity; i++) {
                    partsToCut.push({ length: item.length });
                }
            }

            if (partsToCut.length === 0) continue;

            // Алгоритм FFD (First Fit Decreasing)
            partsToCut.sort((a, b) => b.length - a.length);
            const cuttingPlan = [];

            for (const part of partsToCut) {
                let placed = false;

                for (const stock of cuttingPlan) {
                    let usedLength = 0;
                    if (stock.length > 0) {
                        usedLength = stock.reduce((sum, p) => sum + p.length, 0);
                        usedLength += stock.length * kerf;
                    }

                    const requiredLength = part.length + kerf;
                    if (stockLength - usedLength >= requiredLength) {
                        stock.push(part);
                        placed = true;
                        break;
                    }
                }

                if (!placed) {
                    cuttingPlan.push([part]);
                }
            }

            // Группировка одинаковых раскроев
            const groupedPlan = new Map();
            for (const stock of cuttingPlan) {
                const key = stock.map(p => p.length).sort((a, b) => a - b).join(',');
                if (groupedPlan.has(key)) {
                    groupedPlan.get(key).count++;
                } else {
                    groupedPlan.set(key, { parts: stock, count: 1 });
                }
            }

            allResults.set(materialName, { plan: groupedPlan });
        }

        cuttingStore.setResults(allResults);
        return allResults;
    },

    /**
     * Получает текущие настройки раскроя
     * @returns {Object} Настройки
     */
    getSettings() {
        return cuttingStore.getSettings();
    },

    /**
     * Обновляет настройку раскроя
     * @param {string} key - Ключ настройки
     * @param {*} value - Значение
     */
    updateSetting(key, value) {
        cuttingStore.updateSetting(key, value);
    },

    /**
     * Очищает данные раскроя
     */
    clear() {
        cuttingStore.setMaterialsData({});
        cuttingStore.setResults(null);
        cuttingStore.setLoading(false);
    }
};

export { parseMaterialString };
