/**
 * Resize Handler Module
 * Отвечает за изменение размера панели информации и переключение вкладок
 */

import { store } from './store.js';
import { SpecificationService } from './services/specificationService.js';

// ============================================================
// Константы
// ============================================================

const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 60;
const RESIZE_THROTTLE_DELAY = 50;

// ============================================================
// Класс ResizeHandler
// ============================================================

export class ResizeHandler {
    constructor() {
        this.handle = document.getElementById('resize-handle');
        this.infoPanel = document.querySelector('.info-panel');
        this.modelContainer = document.getElementById('model-container');
        this.drawingContainer = document.getElementById('drawing-container');
        this.viewToggleBtn = document.getElementById('view-toggle-btn');

        this.isResizing = false;
        this.startY = 0;
        this.startHeight = 0;
        this.minHeight = MIN_HEIGHT;
        this.maxHeight = window.innerHeight - MIN_HEIGHT;

        // Для троттлинга
        this.lastResizeCall = 0;
        this.resizeThrottleDelay = RESIZE_THROTTLE_DELAY;
        this.resizeTimeout = null;

        // Инициализируем из store или localStorage
        this.currentView = store.getState('ui.currentView') || this.restoreViewState();
        
        this.init();
        this.initViewToggle();
        this.restoreHeight();
        this.showCurrentView();
        this.updateToggleIcon();
    }

    // ============================================================
    // Инициализация
    // ============================================================

    init() {
        // Обработчики для всей области handle (кроме кнопки)
        this.handle.addEventListener('mousedown', (e) => {
            if (!this.isToggleButton(e.target)) {
                this.startResize(e);
            }
        });

        this.handle.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;

            const touch = e.touches[0];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);

            if (!this.isToggleButton(target)) {
                e.preventDefault();
                this.startResizeTouch(e);
            }
        }, { passive: false });

        // Глобальные обработчики для ресайза
        document.addEventListener('mousemove', (e) => {
            if (this.isResizing) this.onMouseMove(e);
        });

        document.addEventListener('mouseup', () => {
            if (this.isResizing) this.stopResize();
        });

        document.addEventListener('touchmove', (e) => {
            if (this.isResizing && e.touches.length === 1) {
                e.preventDefault();
                this.onTouchMove(e);
            }
        }, { passive: false });

        document.addEventListener('touchend', () => {
            if (this.isResizing) this.stopResize();
        });

        document.addEventListener('touchcancel', () => {
            if (this.isResizing) this.stopResize();
        });

        // Подписка на изменения UI store
        store.subscribe('ui.currentView', (view) => {
            if (view && view !== this.currentView) {
                this.currentView = view;
                this.showCurrentView();
                this.updateToggleIcon();
            }
        });
    }

    // ============================================================
    // Обработчики resizing
    // ============================================================

    isToggleButton(element) {
        return element === this.viewToggleBtn ||
            element.closest('#view-toggle-btn') === this.viewToggleBtn;
    }

    startResize(e) {
        e.preventDefault();
        e.stopPropagation();

        this.isResizing = true;
        this.startY = e.clientY;
        this.startHeight = parseInt(getComputedStyle(this.infoPanel).height, 10);
        this.handle.classList.add('active');

        this.infoPanel.style.transition = 'none';
        document.body.style.cursor = 'row-resize';
    }

    startResizeTouch(e) {
        this.isResizing = true;
        this.startY = e.touches[0].clientY;
        this.startHeight = parseInt(getComputedStyle(this.infoPanel).height, 10);
        this.handle.classList.add('active');

        this.infoPanel.style.transition = 'none';
    }

    onMouseMove(e) {
        if (!this.isResizing) return;

        const deltaY = this.startY - e.clientY;
        const newHeight = this.startHeight + deltaY;

        this.updateHeight(newHeight);
        this.throttledWindowResize();
    }

    onTouchMove(e) {
        if (!this.isResizing) return;

        const deltaY = this.startY - e.touches[0].clientY;
        const newHeight = this.startHeight + deltaY;

        this.updateHeight(newHeight);
        this.throttledWindowResize();
    }

    throttledWindowResize() {
        const now = Date.now();

        if (now - this.lastResizeCall >= this.resizeThrottleDelay) {
            this.callWindowResize();
            this.lastResizeCall = now;
        } else {
            if (this.resizeTimeout) {
                clearTimeout(this.resizeTimeout);
            }
            this.resizeTimeout = setTimeout(() => {
                this.callWindowResize();
            }, this.resizeThrottleDelay);
        }
    }

    callWindowResize() {
        if (typeof window.onWindowResize === 'function') {
            window.onWindowResize();
        }
    }

    updateHeight(newHeight) {
        newHeight = Math.max(this.minHeight, Math.min(this.maxHeight, newHeight));
        this.infoPanel.style.height = `${newHeight}px`;

        // Сохраняем в store
        store.setState('ui.infoPanelHeight', newHeight);

        const handleHeight = this.handle.offsetHeight || 20;
        const containerHeight = window.innerHeight - newHeight - handleHeight - 80;
        const minContainerHeight = 100;
        const actualHeight = Math.max(minContainerHeight, containerHeight);

        if (this.modelContainer.classList.contains('active')) {
            this.modelContainer.style.height = `${actualHeight}px`;
        }

        if (this.drawingContainer.classList.contains('active')) {
            this.drawingContainer.style.height = `${actualHeight}px`;
        }
    }

    stopResize() {
        if (!this.isResizing) return;

        this.isResizing = false;
        this.handle.classList.remove('active');

        this.infoPanel.style.transition = '';
        document.body.style.cursor = '';

        if (this.resizeTimeout) {
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = null;
        }

        this.callWindowResize();
        this.saveHeight();
    }

    // ============================================================
    // Сохранение/восстановление высоты
    // ============================================================

    saveHeight() {
        const height = parseInt(getComputedStyle(this.infoPanel).height, 10);
        localStorage.setItem('infoPanelHeight', height);
        store.setState('ui.infoPanelHeight', height);
    }

    restoreHeight() {
        // Сначала пробуем из store
        let savedHeight = store.getState('ui.infoPanelHeight');
        
        // Затем из localStorage
        if (!savedHeight) {
            savedHeight = localStorage.getItem('infoPanelHeight');
        }
        
        if (savedHeight) {
            const height = parseInt(savedHeight, 10);
            this.updateHeight(height);
        } else {
            const defaultHeight = window.innerHeight * 0.4;
            this.updateHeight(defaultHeight);
        }
    }

    // ============================================================
    // Переключение вкладок
    // ============================================================

    initViewToggle() {
        if (!this.viewToggleBtn) return;

        this.updateToggleIcon();

        // Обработчики для кнопки - с явным остановом всплытия
        this.viewToggleBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });

        this.viewToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleView();
        });

        // Для мобильных устройств
        this.viewToggleBtn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
        }, { passive: true });

        this.viewToggleBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleView();
        }, { passive: false });

        this.viewToggleBtn.addEventListener('touchcancel', (e) => {
            e.stopPropagation();
        });
    }

    toggleView() {
        const newView = this.currentView === 'specification' ? 'cutting' : 'specification';
        this.currentView = newView;

        // Сохраняем в store
        store.setState('ui.currentView', newView);

        this.showCurrentView();
        this.updateToggleIcon();
    }

    showCurrentView() {
        document.querySelectorAll('.tab-pane').forEach(pane => {
            pane.classList.remove('active');
        });

        const currentPane = document.getElementById(this.currentView);
        if (currentPane) {
            currentPane.classList.add('active');
        }

        // Восстанавливаем выделение если на вкладке спецификации
        if (this.currentView === 'specification' && store.getState('specification.lastSelectedPart')) {
            setTimeout(() => {
                const rows = document.querySelectorAll('.part-row');
                const selectedPart = store.getState('specification.lastSelectedPart');
                
                rows.forEach(row => {
                    const partName = row.getAttribute('data-part-name');
                    if (partName === selectedPart) {
                        row.classList.add('active');
                        SpecificationService.highlightParts(partName, true);
                    } else {
                        row.classList.remove('active');
                    }
                });
            }, 10);
        }
    }

    updateToggleIcon() {
        const icon = this.currentView === 'specification' ? 'cut' : 'list-alt';
        this.viewToggleBtn.innerHTML = `<svg><use xlink:href="assets/icons/sprite.svg#${icon}"></use></svg>`;
    }

    saveViewState() {
        localStorage.setItem('currentView', this.currentView);
    }

    restoreViewState() {
        const savedView = localStorage.getItem('currentView');
        if (savedView === 'specification' || savedView === 'cutting') {
            return savedView;
        }
        return 'specification';
    }

    setView(view) {
        if (view === 'specification' || view === 'cutting') {
            this.currentView = view;
            store.setState('ui.currentView', view);
            this.showCurrentView();
            this.updateToggleIcon();
        }
    }
}

// ============================================================
// Автоматическая инициализация
// ============================================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.resizeHandler = new ResizeHandler();
    });
} else {
    window.resizeHandler = new ResizeHandler();
}

export default ResizeHandler;
