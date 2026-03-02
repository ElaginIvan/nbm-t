/**
 * Project Page Module
 * Отвечает за инициализацию страницы проекта и рендеринг спецификации
 */

import { DataService } from './dataService.js';
import { SpecificationService, cleanName } from './services/specificationService.js';
import { specificationStore, modelStore, uiStore, drawingStore } from './store.js';

// ============================================================
// Рендеринг спецификации
// ============================================================

/**
 * Рендерит таблицу спецификации
 * @param {Array} structure - Структура модели
 */
function renderSpecificationTable(structure) {
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
        const csvData = item.csvData;
        const name = csvData ? csvData['Наименование'] : '—';
        const quantity = item.instanceCount || 1;
        const hasData = csvData ? 'has-data' : 'no-data';

        html += `
            <tr class="part-row ${hasData}" data-part-name="${item.name}">
                <td>
                    <div class="part-item" style="padding-left: ${indent}px">
                        <svg class="part-icon">
                            <use href="assets/icons/sprite.svg#${item.children.length > 0 ? 'cubes' : 'cube'}"></use>
                        </svg>
                        ${item.name}
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

/**
 * Добавляет обработчики событий на строки таблицы
 */
function attachTableEventListeners() {
    const partRows = document.querySelectorAll('.part-row');

    partRows.forEach(row => {
        row.addEventListener('click', () => {
            const partName = row.getAttribute('data-part-name');

            // Если кликаем на уже выделенную строку - отменяем выделение
            if (row.classList.contains('active')) {
                row.classList.remove('active');
                SpecificationService.showAllParts();
            } else {
                // Снимаем выделение со всех строк и выделяем текущую
                partRows.forEach(r => r.classList.remove('active'));
                row.classList.add('active');

                // Показываем только выбранную деталь, остальные скрываем
                SpecificationService.highlightParts(partName, true);
            }

            // Если включен 2D режим, загружаем чертеж
            if (uiStore.getCurrentMode() === '2D') {
                loadDrawingForPart(partName);
            }

            // Если мы находимся на вкладке раскроя, переключаемся на спецификацию
            if (uiStore.getCurrentView() === 'cutting') {
                uiStore.setCurrentView('specification');
            }
        });
    });
}

/**
 * Загружает чертеж для детали
 * @param {string} partName - Имя детали
 */
function loadDrawingForPart(partName) {
    if (typeof window.DrawingViewer !== 'undefined' && window.DrawingViewer.loadDrawing) {
        window.DrawingViewer.loadDrawing(partName);
    }
}

/**
 * Подписывается на изменения выбранной детали и обновляет UI
 */
function subscribeToSelectedPart() {
    specificationStore.subscribeSelectedPart((partName) => {
        // Обновляем активный класс в таблице
        const rows = document.querySelectorAll('.part-row');
        rows.forEach(row => {
            const rowPartName = row.getAttribute('data-part-name');
            if (rowPartName === partName) {
                row.classList.add('active');
            } else {
                row.classList.remove('active');
            }
        });
    });
}

/**
 * Подписывается на изменения структуры и перерисовывает таблицу
 */
function subscribeToStructure() {
    specificationStore.subscribeStructure((structure) => {
        if (structure && structure.length > 0) {
            renderSpecificationTable(structure);
        }
    });
}

// ============================================================
// Модуль для обновления информации о проекте
// ============================================================

const ProjectInfo = {
    /**
     * Обновляет информацию о проекте в DOM
     * @param {Object} project - Данные проекта
     */
    update(project) {
        document.title = project.name + ' - 3D Viewer';
        const projectData = document.getElementById('project-data');

        if (projectData) {
            projectData.setAttribute('data-project-id', project.id);
            projectData.setAttribute('data-model-path', project.modelFile);
            projectData.setAttribute('data-model-name', project.name);
            projectData.setAttribute('data-model-description', project.description);
            if (project.modelColor) {
                projectData.setAttribute('data-model-color', project.modelColor);
            }
        }
    }
};

// ============================================================
// Основной модуль страницы проекта
// ============================================================

export const ProjectPage = {
    /**
     * Инициализирует страницу проекта
     */
    async init() {
        try {
            const selectedProjectId = DataService.getSelectedProject();

            if (!selectedProjectId) {
                throw new Error('No project selected');
            }

            const project = await DataService.loadProjectData(selectedProjectId);

            if (project) {
                ProjectInfo.update(project);
                
                // Подписываемся на изменения store
                subscribeToStructure();
                subscribeToSelectedPart();
            } else {
                throw new Error('Project not found');
            }

        } catch (error) {
            console.error('Error initializing project page:', error);
            this.showErrorMessage(error.message);
        }
    },

    /**
     * Показывает сообщение об ошибке
     * @param {string} message - Текст ошибки
     */
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
                        <i class="fas fa-house"></i>
                        <span>Назад</span>
                    </a>
                </div>
            `;
        }
    }
};

// ============================================================
// Экспорт для совместимости
// ============================================================

// Экспортируем SpecificationService для внешнего доступа
window.SpecificationService = SpecificationService;

// Для совместимости со старым кодом (можно удалить после полного рефакторинга)
window.Specification = {
    highlightParts: (partName, hideOthers) => SpecificationService.highlightParts(partName, hideOthers),
    showAllParts: () => SpecificationService.showAllParts(),
    getLastSelectedPart: () => specificationStore.getSelectedPart(),
    saveModelStructure: (model, projectId) => SpecificationService.saveModelStructure(model, projectId),
    get structure() {
        return specificationStore.getStructure();
    },
    get csvData() {
        return specificationStore.getCSVData();
    },
    set lastSelectedPart(value) {
        specificationStore.setSelectedPart(value);
    },
    get lastSelectedPart() {
        return specificationStore.getSelectedPart();
    }
};

// Автоматическая инициализация при загрузке документа
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ProjectPage.init());
} else {
    ProjectPage.init();
}

export default ProjectPage;
