/**
 * Specification Module
 * Спецификация модели и страница проекта
 *
 * Содержит:
 * - SpecificationService (извлечение структуры, подсветка деталей, CSV)
 * - ProjectPage (инициализация страницы проекта)
 * - Таблица спецификации (рендер, события, подписки)
 */

import { store, loadCSV, findInCSV, escapeHtml, DataService } from './app.js';

// ============================================================
// SPECIFICATION SERVICE
// ============================================================

function cleanName(name) {
    return name ? name.replace(/:\d+$/, '').trim() : '';
}

/** Сбрасывает все меши модели */
function _resetAllMeshes(structure) {
    structure.forEach(item => {
        if (!item.threeObjects) return;
        item.threeObjects.forEach(obj => {
            obj.traverse(child => {
                if (!child.isMesh) return;
                if (child.userData.originalMaterial) child.material = child.userData.originalMaterial;
                if (child.material.emissive) child.material.emissive.setHex(0x000000);
                child.material.dithering = true;
                child.visible = true;
            });
        });
    });
}

const SpecificationService = {
    async loadCSVData(projectId) {
        if (!projectId) return [];
        const project = store.getState('project.data');
        const csvPath = project.specFile;
        const csvData = await loadCSV(csvPath);
        store.setState('specification.csvData', csvData);
        return csvData;
    },

    findCSVData(designation) {
        const csvData = store.getState('specification.csvData');
        return findInCSV(designation, csvData);
    },

    countInstancesInGroup(group) {
        if (!group || !group.threeObjects) return 0;
        if (group.children && group.children.length > 0) {
            return new Set(group.threeObjects.map(obj => obj.uuid)).size;
        }
        if (group.meshObjects && group.meshObjects.length > 0) return group.meshObjects.length;
        return 1;
    },

    extractModelStructure(threeModel) {
        const structure = [];
        const nodeMap = new Map();
        const parentChainCache = new Map();

        const getParentChain = (obj, parentObj) => {
            if (!parentObj) return 'root';
            const cacheKey = obj.uuid + '_' + (parentObj?.uuid || 'null');
            if (parentChainCache.has(cacheKey)) return parentChainCache.get(cacheKey);
            const chain = [];
            let current = parentObj;
            while (current) {
                const parentName = cleanName(current.userData?.name || current.name || '');
                chain.push(parentName);
                current = nodeMap.has(current) ? structure[nodeMap.get(current)]?.parentObject : null;
            }
            const chainKey = chain.reverse().join('->');
            parentChainCache.set(cacheKey, chainKey);
            return chainKey;
        };

        const processObject = (obj, level = 0, parentObj = null) => {
            if (obj.type === 'Camera' || obj.type === 'Light' || obj.isMesh) return null;
            let originalName = (obj.userData && obj.userData.name) ? obj.userData.name : obj.name;
            let displayName = cleanName(originalName) || `Группа ${structure.length + 1}`;
            const parentChain = getParentChain(obj, parentObj);
            const groupKey = `${displayName}_${level}_${parentChain}`;
            let group = null, groupIndex = -1;
            for (let i = 0; i < structure.length; i++) {
                if (structure[i].key === groupKey) { group = structure[i]; groupIndex = i; break; }
            }
            if (!group) {
                group = { key: groupKey, name: displayName, originalName, level, parentChain, children: [], threeObjects: [], meshObjects: [], parentObject: parentObj, csvData: null, instanceCount: 1 };
                groupIndex = structure.length;
                structure.push(group);
            } else {
                group.instanceCount += 1;
            }
            group.threeObjects.push(obj);
            nodeMap.set(obj, groupIndex);
            obj.traverse((child) => { if (child.isMesh && !group.meshObjects.includes(child)) group.meshObjects.push(child); });
            if (obj.children?.length > 0) {
                for (const child of obj.children) {
                    const childIndex = processObject(child, level + 1, obj);
                    if (childIndex !== null && !group.children.includes(childIndex)) group.children.push(childIndex);
                }
            }
            return groupIndex;
        };

        if (threeModel && threeModel.children) threeModel.children.forEach(child => processObject(child, 0, null));

        const finalStructure = [];
        const uniqueKeys = new Set();
        const structureMap = new Map();
        structure.forEach(group => {
            const parentName = group.parentObject ? cleanName(group.parentObject.userData?.name || group.parentObject.name || '') : 'root';
            const uniqueKey = `${group.name}_${group.level}_${parentName}`;
            if (!uniqueKeys.has(uniqueKey)) {
                uniqueKeys.add(uniqueKey);
                const csvMatch = this.findCSVData(group.name);
                if (csvMatch) group.csvData = csvMatch;
                group.instanceCount = this.countInstancesInGroup(group);
                finalStructure.push(group);
                structureMap.set(uniqueKey, group);
            } else {
                const existingGroup = structureMap.get(uniqueKey);
                if (existingGroup) {
                    existingGroup.threeObjects.push(...group.threeObjects);
                    existingGroup.meshObjects.push(...group.meshObjects);
                    existingGroup.instanceCount += 1;
                    group.children.forEach(childIndex => { if (!existingGroup.children.includes(childIndex)) existingGroup.children.push(childIndex); });
                }
            }
        });
        return finalStructure;
    },

    async saveModelStructure(threeModel, projectId) {
        try {
            store.setState('specification.isLoading', true);
            await this.loadCSVData(projectId);
            const structure = this.extractModelStructure(threeModel);
            store.setState('specification.structure', structure);
        } catch (error) {
            console.error('Error in saveModelStructure:', error);
            // Показываем пользователю, что спецификация не загрузилась
            const tbody = document.getElementById('specification-body');
            if (tbody) {
                tbody.innerHTML = `
                    <tr><td colspan="3">
                        <div class="empty-state empty-state--compact">
                            <svg class="icon icon--warning" aria-hidden="true">
                                <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
                            </svg>
                            <p>Не удалось загрузить спецификацию</p>
                            <p style="font-size: 0.8rem; opacity: 0.7;">${escapeHtml(error?.message || String(error))}</p>
                        </div>
                    </td></tr>
                `;
            }
        } finally {
            store.setState('specification.isLoading', false);
        }
    },

    highlightParts(partName, hideOthers = true) {
        store.setState('specification.lastSelectedPart', partName);
        const structure = store.getState('specification.structure');
        if (!structure) return;
        _resetAllMeshes(structure);
        if (!partName) return;
        const groupsToShow = structure.filter(item => item.name.toLowerCase() === partName.toLowerCase());
        if (!groupsToShow.length) return;
        const meshesToShow = new Set();
        groupsToShow.forEach(g => g.threeObjects?.forEach(o => o.traverse(c => { if (c.isMesh) meshesToShow.add(c); })));
        if (hideOthers) {
            structure.forEach(item => {
                if (!groupsToShow.includes(item) && item.threeObjects) item.threeObjects.forEach(o => o.traverse(c => {
                    if (c.isMesh && !meshesToShow.has(c)) c.visible = false;
                }));
            });
        }
    },

    showAllParts() {
        store.setState('specification.lastSelectedPart', null);
        const structure = store.getState('specification.structure');
        if (structure) _resetAllMeshes(structure);
    },

    clear() {
        store.setState('specification.structure', []);
        store.setState('specification.csvData', []);
        store.setState('specification.lastSelectedPart', null);
        store.setState('specification.isLoading', false);
    }
};

// Глобальный экспорт для совместимости
window.SpecificationService = SpecificationService;

// ============================================================
// ТАБЛИЦА СПЕЦИФИКАЦИИ
// ============================================================

function renderSpecificationTable(structure) {
    const tbody = document.getElementById('specification-body');

    if (!structure || structure.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="3">
                <div class="empty-state empty-state--compact">
                <svg class="icon icon--warning" aria-hidden="true">
                    <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
                </svg>
                    <p>Спецификация не найдена</p>
                </div>
            </td></tr>
        `;
        return;
    }

    let html = '';
    structure.forEach((item) => {
        const indent = item.level * 15;
        const csvData = item.csvData;
        const name = csvData ? escapeHtml(csvData['Наименование']) : '—';
        const quantity = item.instanceCount || 1;
        const hasData = csvData ? 'has-data' : 'no-data';
        const iconName = item.children.length > 0 ? 'cubes' : 'cube';

        html += `
            <tr class="part-row ${hasData}" data-part-name="${escapeHtml(item.name)}">
                <td>
                    <div class="part-item" style="padding-left: ${indent}px">
                        <svg class="part-icon" aria-hidden="true">
                            <use xlink:href="assets/icons/sprite.svg#${escapeHtml(iconName)}"></use>
                        </svg>
                        ${escapeHtml(item.name)}
                    </div>
                </td>
                <td>${name}</td>
                <td>${quantity}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
    attachTableEventListeners();
}

function attachTableEventListeners() {
    const partRows = document.querySelectorAll('.part-row');

    partRows.forEach(row => {
        row.addEventListener('click', () => {
            const partName = row.getAttribute('data-part-name');

            if (row.classList.contains('active')) {
                row.classList.remove('active');
                SpecificationService.showAllParts();
            } else {
                partRows.forEach(r => r.classList.remove('active'));
                row.classList.add('active');
                SpecificationService.highlightParts(partName, true);
            }

            if (store.getState('ui.currentMode') === '2D') {
                loadDrawingForPart(partName);
            }

            if (store.getState('ui.currentView') === 'cutting') {
                store.setState('ui.currentView', 'specification');
            }
        });
    });
}

function loadDrawingForPart(partName, attempt = 0) {
    const MAX_ATTEMPTS = 30;
    if (window.DrawingViewer?.loadDrawing) {
        window.DrawingViewer.loadDrawing(partName);
    } else if (attempt < MAX_ATTEMPTS) {
        setTimeout(() => loadDrawingForPart(partName, attempt + 1), 100);
    } else {
        console.warn(`loadDrawingForPart: DrawingViewer не стал доступен после ${MAX_ATTEMPTS} попыток.`);
        // Показываем пользователю, что модуль 2D-чертежей не загрузился
        const placeholder = document.getElementById('drawing-placeholder');
        const imageElement = document.getElementById('drawing-image');
        if (placeholder) {
            placeholder.innerHTML = `
                <svg class="icon icon--warning" aria-hidden="true">
                    <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
                </svg>
                <p>Модуль чертежей недоступен</p>
                <p style="font-size: 0.85rem; opacity: 0.7;">Пожалуйста, перезагрузите страницу</p>`;
            placeholder.style.display = 'block';
        }
        if (imageElement) imageElement.style.display = 'none';
    }
}

function subscribeToSelectedPart() {
    store.subscribe('specification.lastSelectedPart', (partName) => {
        document.querySelectorAll('.part-row').forEach(row => {
            row.classList.toggle('active', row.getAttribute('data-part-name') === partName);
        });
    });
}

function subscribeToStructure() {
    store.subscribe('specification.structure', (structure) => {
        if (structure?.length > 0) renderSpecificationTable(structure);
    });
}

// ============================================================
// PROJECT PAGE
// ============================================================

const ProjectInfo = {
    update(project) {
        document.title = project.name + ' - 3D Viewer';
        const projectData = document.getElementById('project-data');
        if (projectData) {
            projectData.setAttribute('data-project-id', project.id);
            projectData.setAttribute('data-model-path', project.modelFile);
            projectData.setAttribute('data-model-name', project.name);
            projectData.setAttribute('data-model-description', project.description);
            if (project.cuttingFile) {
                projectData.setAttribute('data-cutting-file', project.cuttingFile);
            }
        }
    }
};

export const ProjectPage = {
    async init() {
        try {
            const selectedProjectId = DataService.getSelectedProject();
            if (!selectedProjectId) throw new Error('No project selected');

            const project = await DataService.loadProjectData(selectedProjectId);
            if (!project) throw new Error('Project not found');

            ProjectInfo.update(project);
            subscribeToStructure();
            subscribeToSelectedPart();
        } catch (error) {
            console.error('Error initializing project page:', error);
            this.showErrorMessage(error.message);
        }
    },

    showErrorMessage(message) {
        const container = document.querySelector('.project-container');
        if (container) {
            container.innerHTML = `
                <div style="text-align: center; padding: 50px 20px; color: #666;">
                    <svg class="icon icon--warning icon--lg" aria-hidden="true" style="margin-bottom: 20px;">
                        <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
                    </svg>
                    <h3>Ошибка загрузки проекта</h3>
                    <p>${escapeHtml(message)}</p>
                    <a href="index.html" class="back-button" style="display: inline-flex; margin-top: 20px; text-decoration: none;">
                        <svg aria-hidden="true">
                            <use xlink:href="assets/icons/sprite.svg#house"></use>
                        </svg>
                        <span>Назад</span>
                    </a>
                </div>
            `;
        }
    }
};

// ============================================================
// ЭКСПОРТ
// ============================================================

export { SpecificationService };