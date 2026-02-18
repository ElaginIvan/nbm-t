// js/project.js

import { DataService } from './dataService.js';

// Добавляем глобальную переменную для хранения данных CSV
window.Specification = {
    structure: [],
    csvData: [], // Хранилище для данных CSV
    lastSelectedPart: null,

    /**
     * Очищает имя от суффиксов Three.js (например, удаляет :0, :1 и т.д.)
     * @param {string} name - Имя с суффиксом
     * @returns {string} Очищенное имя
     */
    cleanName(name) {
        if (!name) return '';
        // Удаляем суффиксы типа :0, :1, :2 и т.д.
        return name.replace(/:\d+$/, '').trim();
    },

    /**
     * Загружает данные из CSV файла с правильной кодировкой
     * @returns {Promise<Array>} Массив объектов с данными CSV
     */
    async loadCSVData() {
        try {
            const projectData = document.getElementById('project-data');
            const projectId = projectData?.getAttribute('data-project-id');

            if (!projectId) {
                console.warn('Project ID not found');
                return [];
            }

            // Формируем путь к CSV файлу
            const csvPath = `models/${projectId}/spec.csv`;

            const response = await fetch(csvPath);
            if (!response.ok) {
                console.warn(`CSV file not found: ${csvPath}`);
                return [];
            }

            // Получаем данные как ArrayBuffer для правильной обработки кодировки
            const buffer = await response.arrayBuffer();

            // Пробуем разные кодировки
            let csvText;

            // Пробуем UTF-8
            csvText = new TextDecoder('utf-8').decode(buffer);
            if (!this.hasCyrillic(csvText)) {
                // Пробуем Windows-1251
                csvText = new TextDecoder('windows-1251').decode(buffer);
                console.log('CSV loaded as Windows-1251');
            } else {
                console.log('CSV loaded as UTF-8');
            }

            return this.parseCSV(csvText);
        } catch (error) {
            console.error('Error loading CSV data:', error);
            return [];
        }
    },

    /**
     * Проверяет, содержит ли текст кириллические символы
     * @param {string} text - Текст для проверки
     * @returns {boolean} true если содержит кириллицу
     */
    hasCyrillic(text) {
        return /[а-яА-ЯЁё]/.test(text);
    },

    /**
     * Парсит CSV текст в массив объектов с правильной обработкой кириллицы
     * @param {string} csvText - CSV текст
     * @returns {Array} Массив объектов
     */
    parseCSV(csvText) {
        // Нормализуем переносы строк
        csvText = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        const lines = csvText.split('\n');
        const result = [];

        if (lines.length === 0) {
            console.warn('CSV file is empty');
            return result;
        }

        // Находим заголовки (первая непустая строка)
        let headerLineIndex = 0;
        while (headerLineIndex < lines.length && lines[headerLineIndex].trim() === '') {
            headerLineIndex++;
        }

        if (headerLineIndex >= lines.length) {
            console.warn('No headers found in CSV');
            return result;
        }

        const headers = lines[headerLineIndex].split(';').map(h => h.trim());

        // Создаем карту для быстрого поиска по обозначениям
        const designationMap = new Map();

        // Обрабатываем остальные строки
        for (let i = headerLineIndex + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Разделяем строку с учетом того, что значения могут содержать точку с запятой
            const values = this.splitCSVLine(line);
            const obj = {};

            headers.forEach((header, index) => {
                obj[header] = values[index] !== undefined ? values[index].trim() : '';
            });

            // Очищаем обозначение от лишних пробелов
            if (obj['Обозначение']) {
                const designation = obj['Обозначение'].trim();
                obj['Обозначение'] = designation;

                // Сохраняем в карту для быстрого поиска
                if (!designationMap.has(designation)) {
                    designationMap.set(designation, obj);
                }
            }
        }

        // Преобразуем карту обратно в массив
        result.push(...designationMap.values());

        console.log(`Parsed ${result.length} unique rows from CSV`);
        return result;
    },

    /**
     * Разделяет строку CSV с учетом возможных кавычек
     * @param {string} line - Строка CSV
     * @returns {Array} Массив значений
     */
    splitCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ';' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }

        // Добавляем последнее значение
        result.push(current);
        return result;
    },

    /**
     * Находит данные для обозначения в CSV
     * @param {string} designation - Обозначение (уже очищенное от суффиксов)
     * @returns {Object|null} Данные из CSV или null
     */
    findCSVDataForDesignation(designation) {
        if (!this.csvData || this.csvData.length === 0) {
            return null;
        }

        // Ищем точное совпадение
        const exactMatch = this.csvData.find(item => {
            const csvDesignation = item['Обозначение'];
            return csvDesignation && csvDesignation.trim() === designation.trim();
        });

        if (exactMatch) {
            return exactMatch;
        }

        // Если точного совпадения нет, ищем частичное совпадение
        const partialMatch = this.csvData.find(item => {
            const csvDesignation = item['Обозначение'];
            if (!csvDesignation) return false;

            const csvClean = csvDesignation.trim();
            const searchClean = designation.trim();

            return csvClean.startsWith(searchClean) ||
                searchClean.startsWith(csvClean);
        });

        return partialMatch || null;
    },

    /**
     * Подсчитывает количество экземпляров в группе
     * @param {Object} group - Группа объектов
     * @returns {number} Количество экземпляров
     */
    countInstancesInGroup(group) {
        if (!group || !group.threeObjects) return 0;

        // Если это сборка (имеет детей), считаем количество уникальных объектов в ней
        if (group.children && group.children.length > 0) {
            // Для сборок считаем количество уникальных трехмерных объектов
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

        // По умолчанию возвращаем 1
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
                const parentName = current.userData?.name || current.name || '';
                chain.push(this.cleanName(parentName));
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
            // Используем cleanName для получения отображаемого имени
            let displayName = this.cleanName(originalName) || `Группа ${structure.length + 1}`;

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
                    name: displayName, // Сохраняем очищенное имя
                    originalName: originalName, // Сохраняем оригинальное имя для отладки
                    level: level,
                    parentChain: parentChain,
                    children: [],
                    threeObjects: [],
                    meshObjects: [],
                    parentObject: parentObj,
                    csvData: null,
                    instanceCount: 1 // Начальное значение
                };
                groupIndex = structure.length;
                structure.push(group);
            } else {
                // Если группа уже существует, увеличиваем счетчик экземпляров
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

        structure.forEach(group => {
            const parentName = group.parentObject ?
                this.cleanName(group.parentObject.userData?.name || group.parentObject.name || '') :
                'root';

            const uniqueKey = `${group.name}_${group.level}_${parentName}`;

            if (!uniqueKeys.has(uniqueKey)) {
                uniqueKeys.add(uniqueKey);

                // Ищем данные в CSV по очищенному имени
                const csvMatch = this.findCSVDataForDesignation(group.name);
                if (csvMatch) {
                    group.csvData = csvMatch;
                }

                // Вычисляем итоговое количество экземпляров
                group.instanceCount = this.countInstancesInGroup(group);

                finalStructure.push(group);
            } else {
                const existingIndex = finalStructure.findIndex(g =>
                    `${g.name}_${g.level}_${g.parentObject ?
                        this.cleanName(g.parentObject.userData?.name || g.parentObject.name || '') :
                        'root'}` === uniqueKey
                );

                if (existingIndex >= 0) {
                    const existingGroup = finalStructure[existingIndex];
                    existingGroup.threeObjects.push(...group.threeObjects);
                    existingGroup.meshObjects.push(...group.meshObjects);

                    // Увеличиваем счетчик экземпляров
                    existingGroup.instanceCount += 1;

                    group.children.forEach(childIndex => {
                        if (!existingGroup.children.includes(childIndex)) {
                            existingGroup.children.push(childIndex);
                        }
                    });
                }
            }
        });

        this.structure = finalStructure;

        // Статистика
        const total = finalStructure.length;
        const matches = finalStructure.filter(g => g.csvData).length;
        console.log(`📊 CSV matching statistics: ${matches}/${total} matches found (${Math.round(matches / total * 100)}%)`);
        console.log('Structure with instance counts:', finalStructure.map(g => ({
            name: g.name,
            instanceCount: g.instanceCount,
            fromCSV: g.csvData ? g.csvData['Наименование'] : 'no match'
        })));

        return finalStructure;
    },

/**
 * Находит все меши в объекте (рекурсивно)
 * @param {THREE.Object3D} object - Объект Three.js
 * @returns {Array<THREE.Mesh>} Массив всех мешей
 */
collectAllMeshes(object) {
    const meshes = [];
    
    object.traverse((child) => {
        if (child.isMesh) {
            meshes.push(child);
        }
    });
    
    return meshes;
},

/**
 * Подсвечивает или скрывает детали по имени
 * @param {string} partName - Имя детали
 * @param {boolean} hideOthers - Скрывать ли остальные детали (true) или только подсвечивать (false)
 */
highlightParts(partName, hideOthers = true) {
     // Сохраняем выбранную деталь
     this.lastSelectedPart = partName;
    // Если нет структуры или модели, ничего не делаем
    if (!this.structure || !window.model) {
        console.warn('Model structure not loaded');
        return;
    }

    // Сначала показываем и сбрасываем все
    this.structure.forEach(item => {
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
    const groupsToShow = this.structure.filter(item => 
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
        this.structure.forEach(item => {
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
    this.lastSelectedPart = null;
    
    if (!this.structure) return;
    
    this.structure.forEach(item => {
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
    
    // Обновляем контролы камеры
    if (window.controls) {
        window.controls.update();
    }
},

    /**
     * Рендерит таблицу спецификации
     * @param {Array} structure - Структура модели
     */
    renderSpecificationTable(structure) {
        const tbody = document.getElementById('specification-body');
    
        if (!structure || structure.length === 0) {
            tbody.innerHTML = `
            <tr>
                <td colspan="3">
                    <div class="empty-state empty-state--compact">
                        <i class="fas fa-exclamation-triangle"></i>
                        <p>Спецификация не найдена</p>
                    </div>
                </td>
            </tr>
        `;
            return;
        }
    
        let html = '';
        structure.forEach((item, index) => {
            const indent = item.level * 15;
    
            // Получаем данные из CSV (только наименование и описание)
            const csvData = item.csvData;
            const name = csvData ? csvData['Наименование'] : '—';
            const quantity = item.instanceCount || 1;
    
            const hasData = csvData ? 'has-data' : 'no-data';
    
            html += `
            <tr class="part-row ${hasData}" data-part-name="${item.name}">
                <td>
                    <div class="part-item" style="padding-left: ${indent}px">
                        <i class="fas ${item.children.length > 0 ? 'fa-cubes' : 'fa-cube'} part-icon"></i>
                        ${item.name}
                    </div>
                </td>
                <td>${name}</td>
                <td>${quantity}</td>
            </tr>
        `;
        });
    
        tbody.innerHTML = html;
    
        const partRows = document.querySelectorAll('.part-row');
        let lastSelectedRow = null;
    
        partRows.forEach(row => {
            row.addEventListener('click', () => {
                const partName = row.getAttribute('data-part-name');
    
                // Если кликаем на уже выделенную строку - отменяем выделение
                if (row.classList.contains('active')) {
                    row.classList.remove('active');
                    this.showAllParts();
                    lastSelectedRow = null;
                } else {
                    // Снимаем выделение со всех строк и выделяем текущую
                    partRows.forEach(r => r.classList.remove('active'));
                    row.classList.add('active');
                    
                    // Показываем только выбранную деталь, остальные скрываем
                    this.highlightParts(partName, true);
                    lastSelectedRow = row;
                }
    
                // Если включен 2D режим, загружаем чертеж
                if (window.DrawingViewer && window.DrawingViewer.getCurrentMode() === '2D') {
                    window.DrawingViewer.loadDrawing(partName);
                }
    
                // Если мы находимся на вкладке раскроя, переключаемся на спецификацию при клике
                // Теперь доступ к состоянию через resizeHandler
                if (window.resizeHandler && window.resizeHandler.currentView === 'cutting') {
                    window.resizeHandler.toggleView(); // или window.resizeHandler.setView('specification');
                }
            });
        });

    },

    /**
     * Сохраняет структуру модели
     * @param {THREE.Object3D} threeModel - 3D модель
     */
    async saveModelStructure(threeModel) {
        try {
            // Сначала загружаем данные CSV (только для наименований)
            this.csvData = await this.loadCSVData();
            console.log('CSV data loaded for names only:', this.csvData.length, 'rows');

            // Затем извлекаем структуру модели с подсчетом экземпляров
            const structure = this.extractModelStructure(threeModel);
            this.renderSpecificationTable(structure);
            console.log('Model structure extracted with instance counts');

            // Выводим итоговую статистику
            const totalParts = structure.reduce((sum, item) => sum + (item.instanceCount || 1), 0);
            console.log(`Итого: ${structure.length} позиций, ${totalParts} деталей в модели`);
        } catch (error) {
            console.error('Error in saveModelStructure:', error);
        }
    }
};



/**
 * Модуль для обновления информации о проекте
 */
const ProjectInfo = {
    update(project) {
        document.title = project.name + ' - 3D Viewer';
        const projectData = document.getElementById('project-data');

        if (projectData) {
            projectData.setAttribute('data-project-id', project.id);
            projectData.setAttribute('data-model-path', project.modelFile);
            projectData.setAttribute('data-model-name', project.name);
            projectData.setAttribute('data-model-description', project.description);
        }
    }
};

/**
 * Основной модуль страницы проекта
 */
export const ProjectPage = {
    async init() {
        try {
            const selectedProjectId = DataService.getSelectedProject();

            if (!selectedProjectId) {
                throw new Error('No project selected');
            }

            const project = await DataService.loadProjectData(selectedProjectId);

            if (project) {
                ProjectInfo.update(project);
            } else {
                throw new Error('Project not found');
            }

        } catch (error) {
            console.error('Error initializing project page:', error);
            this.showErrorMessage(error.message);
        }
    },

    showErrorMessage(message) {
        const container = document.querySelector('.project-container');
        if (container) {
            container.innerHTML = `
                <div class="error-state" style="
                    text-align: center; 
                    padding: 50px 20px;
                    color: #666;
                ">
                    <i class="fas fa-exclamation-triangle" style="font-size: 48px; margin-bottom: 20px;"></i>
                    <h3>Ошибка загрузки проекта</h3>
                    <p>${message}</p>
                    <a href="index.html" class="back-button" style="
                        display: inline-flex;
                        margin-top: 20px;
                        text-decoration: none;
                    ">
                        <i class="fas fa-arrow-left"></i>
                        <span>Назад</span>
                    </a>
                </div>
            `;
        }
    }
};

// Экспортируем Specification для использования в model.js
window.Specification = Specification;

// Автоматическая инициализация при загрузке документа
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ProjectPage.init());
} else {
    ProjectPage.init();
}

