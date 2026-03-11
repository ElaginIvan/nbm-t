/**
 * Основной модуль 2D просмотрщика
 */

import { InputHandlers } from './input-handlers.js';
import { DrawingLoader } from './drawing-loader.js';
import { ZoomManager } from './zoom-manager.js';
import { UIManager } from './ui-manager.js';
import { store } from '../store.js';

// Локальное состояние (не дублирует store)
let currentProjectId = null;

/**
 * Получает текущий режим из store
 * @returns {string} '3D' или '2D'
 */
function getCurrentMode() {
    return store.getState('ui.currentMode') || '3D';
}

export const DrawingViewer = {
    currentProjectId: null,

    /**
     * Инициализация
     */
    init() {
        currentProjectId = this.getProjectId();
        this.setupCursors();
        this.bindEvents();
        UIManager.updateToggleButton(getCurrentMode());

        // Подписываемся на изменения режима из store
        store.subscribe('ui.currentMode', (mode) => {
            if (mode) {
                ZoomManager.currentMode = mode;
            }
        });

        console.log('2D Viewer initialized for project:', currentProjectId);
    },

    /**
     * Настраивает курсоры для перетаскивания
     */
    setupCursors() {
        const imageElement = document.getElementById('drawing-image');
        const drawingWrapper = document.querySelector('.drawing-wrapper');

        if (imageElement) {
            imageElement.style.cursor = 'grab';
        }

        if (drawingWrapper) {
            drawingWrapper.style.cursor = 'default';
        }
    },

    /**
     * Получает ID текущего проекта
     */
    getProjectId() {
        const projectData = document.getElementById('project-data');
        return projectData?.getAttribute('data-project-id');
    },

    /**
     * Обновляет ID проекта
     */
    refreshProjectId() {
        const newId = this.getProjectId();
        if (newId !== currentProjectId) {
            console.log('Project ID changed:', currentProjectId, '->', newId);
            currentProjectId = newId;
        }
        return currentProjectId;
    },

    /**
     * Привязывает события
     */
    bindEvents() {
        // Кнопка переключения режима
        const toggleBtn = document.getElementById('toggle-3d-2d-btn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleMode();
            });
        }

        // Обработчики ввода - передаем this (DrawingViewer) и ZoomManager
        InputHandlers.initMouseHandlers(this, ZoomManager);
        InputHandlers.initTouchHandlers(this, ZoomManager);
    },

    /**
     * Переключает режим просмотра
     */
    toggleMode() {
        const oldMode = getCurrentMode();
        const newMode = oldMode === '3D' ? '2D' : '3D';

        // Обновляем режим в store и ZoomManager
        store.setState('ui.currentMode', newMode);
        ZoomManager.currentMode = newMode;

        UIManager.updateView(newMode);
        UIManager.updateToggleButton(newMode);

        this.setupCursors();

        // Уведомляем другие модули
        if (window.PanelManager) {
            window.PanelManager.currentViewMode = newMode;
            window.PanelManager.updateToggleButton();
        }

        // Отправляем событие
        document.dispatchEvent(new CustomEvent('viewModeChanged', {
            detail: { mode: newMode, oldMode: oldMode }
        }));

        // Если переключились в 2D, загружаем активный чертеж
        if (newMode === '2D') {
            let activeRow = document.querySelector('.part-row.active');
            
            // Если нет активной строки, выбираем первую
            if (!activeRow) {
                activeRow = document.querySelector('.part-row');
                if (activeRow) {
                    // Снимаем выделение со всех строк
                    document.querySelectorAll('.part-row').forEach(row => {
                        row.classList.remove('active');
                    });
                    // Выделяем первую строку
                    activeRow.classList.add('active');
                    
                    const partName = activeRow.getAttribute('data-part-name');
                    console.log('📋 2D режим: автоматически выбрана первая деталь:', partName);
                    
                    // Показываем деталь в 3D
                    if (window.SpecificationService) {
                        window.SpecificationService.highlightParts(partName, true);
                    }
                }
            }
            
            if (activeRow) {
                const partName = activeRow.getAttribute('data-part-name');
                this.loadDrawing(partName);
            } else {
                console.warn('⚠️ 2D режим: нет доступных деталей для отображения');
            }
        }

        // Обновляем Three.js
        if (typeof window.onWindowResize === 'function') {
            setTimeout(() => {
                try {
                    window.onWindowResize();
                } catch (error) {
                    console.warn('Ошибка при обновлении Three.js:', error);
                }
            }, 50);
        }
    },

    /**
     * Загружает чертеж
     */
    async loadDrawing(designation) {
        const projectId = this.refreshProjectId();

        if (!projectId) {
            console.error('❌ Не удалось получить ID проекта для загрузки чертежа');
            return false;
        }

        console.log('📥 Загрузка чертежа для:', designation, 'проект:', projectId);

        // Сохраняем текущую деталь в store
        store.setState('drawing.currentPart', designation);

        const success = await DrawingLoader.loadDrawing(designation, projectId);

        // Используем DrawingLoader.currentDrawings вместо window.currentDrawings
        if (success && DrawingLoader.currentDrawings?.files.length > 1) {
            UIManager.createMultiDrawingControls(DrawingLoader);
        } else if (success) {
            // Чертеж загружен, но он один
            UIManager.removeMultiDrawingControls();
        } else {
            // Чертеж не найден
            UIManager.removeMultiDrawingControls();
            // Показываем placeholder с сообщением (уже показано в DrawingLoader)
        }

        ZoomManager.resetZoom();
        
        return success;
    },

    /**
     * Получает текущий режим
     * @returns {string} '3D' или '2D'
     */
    getCurrentMode() {
        return getCurrentMode();
    },

    /**
     * Получает текущую деталь
     */
    getCurrentPart() {
        return store.getState('drawing.currentPart');
    }
};

// Автоматическая инициализация
function initDrawingViewer() {
    const projectData = document.getElementById('project-data');
    const projectId = projectData?.getAttribute('data-project-id');
    
    if (projectId) {
        DrawingViewer.init();
    } else {
        // Ждём инициализации проекта
        console.log('⏳ Ожидание инициализации проекта для 2D viewer...');
        setTimeout(initDrawingViewer, 100);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDrawingViewer);
} else {
    initDrawingViewer();
}

// Экспортируем только DrawingViewer для глобального использования (совместимость)
window.DrawingViewer = DrawingViewer;

export default DrawingViewer;
