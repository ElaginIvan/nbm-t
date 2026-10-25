/**
 * Specification Module — спецификация модели и страница проекта.
 * SpecificationService: извлечение структуры, подсветка деталей (single/multi), CSV.
 * ProjectPage: инициализация страницы проекта.
 *
 * Мульти-выбор: long-press (500 мс) или Ctrl/Cmd+click переводит таблицу
 * в мульти-режим: клики toggle строк, остальные детали скрываются.
 * Выход — Esc или клик мимо таблицы.
 */

import { store, loadCSV, findInCSV, escapeHtml, DataService } from './app.js';

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
// Окно подавления «призрачного» клика после жеста мульти-активации
// (long-press / Ctrl+клик): клик от mouseup успевает попасть в новую строку
// после перестройки tbody и toggle её назад.
const CLICK_SUPPRESS_MS = 350;

// Клики по строкам игнорируются до этой метки времени.
let _rowClickSuppressedUntil = 0;

// ============================================================
// SPECIFICATION SERVICE
// ============================================================

function cleanName(name) {
    return name ? name.replace(/:\d+$/, '').trim() : '';
}

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

function _visibilityChanged() {
    window.dispatchEvent(new Event('model-visibility-changed'));
}

const SpecificationService = {
    async loadCSVData(projectId) {
        if (!projectId) return [];
        const project = store.getState('project.data');
        if (!project?.specFile) return [];
        const csvData = await loadCSV(project.specFile);
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
            await this.loadCSVData(projectId);
            const structure = this.extractModelStructure(threeModel);
            store.setState('specification.structure', structure);
        } catch (error) {
            console.error('Error in saveModelStructure:', error);
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
        }
    },

    highlightParts(partName, hideOthers = true) {
        store.setState('specification.lastSelectedPart', partName);
        store.setState('specification.selectedParts', []);
        store.setState('specification.multiSelectMode', false);
        const structure = store.getState('specification.structure');
        if (!structure) return;
        _resetAllMeshes(structure);
        if (!partName) { _visibilityChanged(); return; }
        const groupsToShow = structure.filter(item => item.name.toLowerCase() === partName.toLowerCase());
        if (!groupsToShow.length) { _visibilityChanged(); return; }
        const meshesToShow = new Set();
        groupsToShow.forEach(g => g.threeObjects?.forEach(o => o.traverse(c => { if (c.isMesh) meshesToShow.add(c); })));
        if (hideOthers) {
            structure.forEach(item => {
                if (!groupsToShow.includes(item) && item.threeObjects) item.threeObjects.forEach(o => o.traverse(c => {
                    if (c.isMesh && !meshesToShow.has(c)) c.visible = false;
                }));
            });
        }
        _visibilityChanged();
    },

    /** Подсвечивает несколько деталей одновременно (мульти-режим). */
    highlightMultipleParts(partNames) {
        const names = Array.isArray(partNames) ? partNames.filter(Boolean) : [];
        store.setState('specification.selectedParts', names);
        store.setState('specification.multiSelectMode', names.length > 0);
        if (names.length === 0) store.setState('specification.lastSelectedPart', null);

        const structure = store.getState('specification.structure');
        if (!structure) return;
        _resetAllMeshes(structure);
        if (names.length === 0) { _visibilityChanged(); return; }

        const lowerNames = new Set(names.map(n => n.toLowerCase()));
        const groupsToShow = structure.filter(item => lowerNames.has(item.name.toLowerCase()));
        const meshesToShow = new Set();
        groupsToShow.forEach(g => g.threeObjects?.forEach(o => o.traverse(c => { if (c.isMesh) meshesToShow.add(c); })));
        structure.forEach(item => {
            if (!groupsToShow.includes(item) && item.threeObjects) item.threeObjects.forEach(o => o.traverse(c => {
                if (c.isMesh && !meshesToShow.has(c)) c.visible = false;
            }));
        });
        _visibilityChanged();
    },

    showAllParts() {
        store.setState('specification.lastSelectedPart', null);
        store.setState('specification.selectedParts', []);
        store.setState('specification.multiSelectMode', false);
        const structure = store.getState('specification.structure');
        if (structure) _resetAllMeshes(structure);
        _visibilityChanged();
    },

    /** Toggle одной детали в мульти-режиме. */
    togglePartInMultiSelection(partName) {
        if (!partName) return;
        const current = store.getState('specification.selectedParts') || [];
        const lower = partName.toLowerCase();
        const isIn = current.some(n => n.toLowerCase() === lower);
        const next = isIn
            ? current.filter(n => n.toLowerCase() !== lower)
            : [...current, partName];
        this.highlightMultipleParts(next);
    },

    clear() {
        store.setState('specification.structure', []);
        store.setState('specification.csvData', []);
        store.setState('specification.lastSelectedPart', null);
        store.setState('specification.selectedParts', []);
        store.setState('specification.multiSelectMode', false);
    }
};

window.SpecificationService = SpecificationService;

// ============================================================
// ТАБЛИЦА СПЕЦИФИКАЦИИ
// ============================================================

function renderSpecificationTable(structure) {
    const tbody = document.getElementById('specification-body');
    if (!tbody) return;

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

    const selectedParts = store.getState('specification.selectedParts') || [];
    const lastSelectedPart = store.getState('specification.lastSelectedPart');
    const multiMode = store.getState('specification.multiSelectMode') || selectedParts.length > 0;

    const lowerSelected = new Set(selectedParts.map(n => n.toLowerCase()));
    const lowerLast = lastSelectedPart ? lastSelectedPart.toLowerCase() : null;

    let html = '';
    structure.forEach((item) => {
        const indent = item.level * 15;
        const csvData = item.csvData;
        const name = csvData ? escapeHtml(csvData['Наименование']) : '—';
        const quantity = item.instanceCount || 1;
        const hasData = csvData ? 'has-data' : 'no-data';
        const iconName = item.children.length > 0 ? 'cubes' : 'cube';
        const lowerItem = item.name.toLowerCase();

        // В мульти-режиме — multi-active для выбранных; в single-режиме — active для lastSelectedPart.
        let activeClass = '';
        if (multiMode) {
            if (lowerSelected.has(lowerItem)) activeClass = 'multi-active';
        } else if (lowerLast && lowerItem === lowerLast) {
            activeClass = 'active';
        }

        html += `
            <tr class="part-row ${hasData} ${activeClass}" data-part-name="${escapeHtml(item.name)}">
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
        let pressTimer = null;
        let pressStartPos = null;
        let longPressFired = false;

        const startPress = (clientX, clientY) => {
            pressStartPos = { x: clientX, y: clientY };
            longPressFired = false;
            if (pressTimer) clearTimeout(pressTimer);
            pressTimer = setTimeout(() => {
                longPressFired = true;
                _handleRowActivate(row, true);
            }, LONG_PRESS_MS);
        };

        const cancelPress = (clientX, clientY) => {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            if (pressStartPos && (clientX !== undefined)) {
                const dx = clientX - pressStartPos.x;
                const dy = clientY - pressStartPos.y;
                if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) {
                    longPressFired = true;
                }
            }
            // Жест завершён, мульти-активация уже выполнена (long-press,
            // Ctrl+клик или drag) — гасим призрачный click от этого mouseup.
            if (longPressFired) {
                _rowClickSuppressedUntil = Date.now() + CLICK_SUPPRESS_MS;
            }
            pressStartPos = null;
        };

        row.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.ctrlKey || e.metaKey) {
                longPressFired = true;
                e.preventDefault();
                _handleRowActivate(row, true);
                return;
            }
            startPress(e.clientX, e.clientY);
        });
        row.addEventListener('mouseup', (e) => cancelPress(e.clientX, e.clientY));
        row.addEventListener('mouseleave', () => cancelPress());

        row.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            startPress(t.clientX, t.clientY);
        }, { passive: true });
        row.addEventListener('touchend', (e) => {
            const t = e.changedTouches[0];
            cancelPress(t?.clientX, t?.clientY);
        });
        row.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1) {
                const t = e.touches[0];
                if (pressStartPos) {
                    const dx = t.clientX - pressStartPos.x;
                    const dy = t.clientY - pressStartPos.y;
                    if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) {
                        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                        longPressFired = true;
                    }
                }
            }
        }, { passive: true });

        row.addEventListener('click', () => {
            if (longPressFired) {
                longPressFired = false;
                return;
            }
            // Призрачный клик после жеста мульти-активации: исходная строка
            // отсоединена, click достался новой строке без флага longPressFired.
            if (Date.now() < _rowClickSuppressedUntil) return;
            _handleRowActivate(row, store.getState('specification.multiSelectMode'));
        });
    });

    const specTable = document.querySelector('.spec-table');
    if (specTable && !specTable._multiSelectOutsideHandler) {
        specTable._multiSelectOutsideHandler = (e) => {
            if (!store.getState('specification.multiSelectMode')) return;
            // В полноэкранном режиме таблица скрыта — работаем с моделью.
            if (document.body.classList.contains('fullscreen-active')) return;
            // Клик по элементам управления (кнопки, настройки, панели плагинов)
            // мультивыбор не сбрасывает.
            const target = e.target;
            if (target instanceof Element) {
                // Отсоединённая от DOM цель (перерисовка поддерева при всплытии)
                // ошибочно выглядела бы «кликом мимо таблицы».
                if (!target.isConnected) return;
                if (target.closest('.control-buttons')) return;
                if (target.closest('#settings-modal')) return;
                if (target.closest('.plugin-dock')) return;
                if (target.closest('.plugin-panels')) return;
                if (target.closest('#resize-handle')) return;
                if (target.closest('.drawing-controls')) return;
                // Клик по вьюверу (3D/2D) и плавающим кнопкам плагинов —
                // работа с моделью, а не «клик мимо таблицы». Выход из
                // мульти-режима — Esc или клик по строке.
                if (target.closest('#model-container')) return;
                if (target.closest('[data-plugin-overlay]')) return;
            }
            if (!specTable.contains(e.target)) {
                SpecificationService.showAllParts();
            }
        };
        document.addEventListener('click', specTable._multiSelectOutsideHandler);
    }

    if (!_escMultiSelectHandlerInstalled) {
        _escMultiSelectHandlerInstalled = true;
        // Capture-фаза: иначе bubble-обработчик FullscreenManager успеет выйти
        // из полноэкранного режима раньше, и Esc сбросит мультивыбор.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !store.getState('specification.multiSelectMode')) return;
            // Сначала закрываются полноэкранный режим / окно настроек.
            if (window.FullscreenManager?.isFullscreen) return;
            const settingsModal = document.getElementById('settings-modal');
            if (settingsModal?.classList.contains('active')) return;
            SpecificationService.showAllParts();
        }, true);
    }
}

let _escMultiSelectHandlerInstalled = false;

function _handleRowActivate(row, isMulti) {
    const partName = row.getAttribute('data-part-name');
    if (!partName) return;

    if (isMulti) {
        SpecificationService.togglePartInMultiSelection(partName);
    } else {
        if (row.classList.contains('active')) {
            SpecificationService.showAllParts();
        } else {
            document.querySelectorAll('.part-row').forEach(r => r.classList.remove('active'));
            row.classList.add('active');
            SpecificationService.highlightParts(partName, true);
        }
    }

    if (store.getState('ui.currentMode') === '2D' && !isMulti) {
        loadDrawingForPart(partName);
    }

    if (store.getState('ui.currentView') === 'cutting') {
        store.setState('ui.currentView', 'specification');
    }
}

function loadDrawingForPart(partName, attempt = 0) {
    const MAX_ATTEMPTS = 30;
    if (window.DrawingViewer?.loadDrawing) {
        window.DrawingViewer.loadDrawing(partName);
    } else if (attempt < MAX_ATTEMPTS) {
        setTimeout(() => loadDrawingForPart(partName, attempt + 1), 100);
    } else {
        console.warn(`loadDrawingForPart: DrawingViewer не стал доступен после ${MAX_ATTEMPTS} попыток.`);
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
    store.subscribe('specification.selectedParts', () => {
        const structure = store.getState('specification.structure');
        if (structure?.length > 0) renderSpecificationTable(structure);
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
            // Приоритет источника проекта: параметр URL (?project=ID), затем
            // сохранённый выбор в localStorage.
            const urlProjectId = new URLSearchParams(window.location.search).get('project');
            const selectedProjectId = urlProjectId || DataService.getSelectedProject();
            if (!selectedProjectId) throw new Error('No project selected');

            const project = await DataService.loadProjectData(selectedProjectId);
            if (!project) throw new Error('Project not found');

            // Синхронизируем сохранённый выбор с реально открытым проектом,
            // чтобы возврат в галерею и перезагрузка страницы показывали его же.
            if (urlProjectId) {
                DataService.setSelectedProject(project.id);
            }

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

export { SpecificationService };