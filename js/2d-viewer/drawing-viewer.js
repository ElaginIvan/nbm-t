/**
 * Основной модуль 2D просмотрщика
 */

import { InputHandlers } from './input-handlers.js';
import { DrawingLoader } from './drawing-loader.js';
import { ZoomManager } from './zoom-manager.js';
import { UIManager } from './ui-manager.js';
import { uiStore, drawingStore } from '../store.js';

export const DrawingViewer = {
    currentMode: '3D',
    currentProjectId: null,

    /**
     * Инициализация
     */
    init() {
        this.currentProjectId = this.getProjectId();
        this.setupCursors();
        this.bindEvents();
        UIManager.updateToggleButton(this.currentMode);
        
        // Подписываемся на изменения режима из store
        uiStore.subscribeCurrentMode((mode) => {
            if (mode && mode !== this.currentMode) {
                this.currentMode = mode;
                ZoomManager.currentMode = mode;
            }
        });
        
        console.log('2D Viewer initialized for project:', this.currentProjectId);
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
        if (newId !== this.currentProjectId) {
            console.log('Project ID changed:', this.currentProjectId, '->', newId);
            this.currentProjectId = newId;
        }
        return this.currentProjectId;
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

        // Клики по строкам таблицы
        document.addEventListener('click', (e) => {
            const partRow = e.target.closest('.part-row');
            if (partRow) {
                const partName = partRow.getAttribute('data-part-name');
                if (partName && this.currentMode === '2D') {
                    console.log('📋 Table row clicked in 2D mode:', partName);
                    this.loadDrawing(partName);
                }
            }
        });
    },

    /**
     * Переключает режим просмотра
     */
    toggleMode() {
        const oldMode = this.currentMode;
        this.currentMode = this.currentMode === '3D' ? '2D' : '3D';

        // Обновляем currentMode в ZoomManager и store
        ZoomManager.currentMode = this.currentMode;
        uiStore.setCurrentMode(this.currentMode);

        UIManager.updateView(this.currentMode);
        UIManager.updateToggleButton(this.currentMode);

        this.setupCursors();

        // Уведомляем другие модули
        if (window.PanelManager) {
            window.PanelManager.currentViewMode = this.currentMode;
            window.PanelManager.updateToggleButton();
        }

        // Отправляем событие
        document.dispatchEvent(new CustomEvent('viewModeChanged', {
            detail: { mode: this.currentMode, oldMode: oldMode }
        }));

        // Если переключились в 2D, загружаем активный чертеж
        if (this.currentMode === '2D') {
            const activeRow = document.querySelector('.part-row.active');
            if (activeRow) {
                const partName = activeRow.getAttribute('data-part-name');
                this.loadDrawing(partName);
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
        this.refreshProjectId();

        // Сохраняем текущую деталь в store
        drawingStore.setCurrentPart(designation);

        const success = await DrawingLoader.loadDrawing(designation, this.currentProjectId);

        // Используем DrawingLoader.currentDrawings вместо window.currentDrawings
        if (success && DrawingLoader.currentDrawings?.files.length > 1) {
            UIManager.createMultiDrawingControls(DrawingLoader);
        } else {
            UIManager.removeMultiDrawingControls();
        }

        ZoomManager.resetZoom();
    },

    /**
     * Получает текущий режим
     */
    getCurrentMode() {
        return this.currentMode;
    },

    /**
     * Получает текущую деталь
     */
    getCurrentPart() {
        return drawingStore.getCurrentPart();
    }
};

// Автоматическая инициализация
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => DrawingViewer.init());
} else {
    DrawingViewer.init();
}

// Экспортируем для глобального использования
window.DrawingViewer = DrawingViewer;
window.ZoomManager = ZoomManager;
window.DrawingLoader = DrawingLoader;
window.InputHandlers = InputHandlers;
window.UIManager = UIManager;

export default DrawingViewer;
