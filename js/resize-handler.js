// resize-handler.js
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
        this.minHeight = 60;
        this.maxHeight = window.innerHeight - 60;

        // Для троттлинга
        this.lastResizeCall = 0;
        this.resizeThrottleDelay = 50;
        this.resizeTimeout = null;

        this.restoreHeight();
        this.init();
        this.initViewToggle();
        this.restoreViewState();
    }

    init() {
        // Обработчики для всей области handle (кроме кнопки)
        this.handle.addEventListener('mousedown', (e) => {
            // Если клик не на кнопке - начинаем ресайз
            if (!this.isToggleButton(e.target)) {
                this.startResize(e);
            }
        });

        this.handle.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;

            const touch = e.touches[0];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);

            // Если касание не на кнопке - начинаем ресайз
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
    }

    // Проверка, является ли элемент кнопкой переключения
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

    saveHeight() {
        const height = parseInt(getComputedStyle(this.infoPanel).height, 10);
        localStorage.setItem('infoPanelHeight', height);
    }

    restoreHeight() {
        const savedHeight = localStorage.getItem('infoPanelHeight');
        if (savedHeight) {
            const height = parseInt(savedHeight, 10);
            this.updateHeight(height);
        } else {
            const defaultHeight = window.innerHeight * 0.6;
            this.updateHeight(defaultHeight);
        }
    }

    // Инициализация кнопки переключения
    initViewToggle() {
        if (!this.viewToggleBtn) return;

        this.currentView = 'specification';
        this.updateToggleIcon();

        // Обработчики для кнопки - с явным остановом всплытия
        this.viewToggleBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); // Останавливаем всплытие к родителю
        });

        this.viewToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Останавливаем всплытие
            this.toggleView();
        });

        // Для мобильных устройств
        this.viewToggleBtn.addEventListener('touchstart', (e) => {
            e.stopPropagation(); // Важно! Останавливаем всплытие
        }, { passive: true });

        this.viewToggleBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Важно! Останавливаем всплытие
            this.toggleView();
        }, { passive: false });

        this.viewToggleBtn.addEventListener('touchcancel', (e) => {
            e.stopPropagation();
        });

        this.showCurrentView();
    }

    toggleView() {
        this.currentView = this.currentView === 'specification' ? 'cutting' : 'specification';
        this.showCurrentView();
        this.updateToggleIcon();
        this.saveViewState();
    }

    showCurrentView() {
        document.querySelectorAll('.tab-pane').forEach(pane => {
            pane.classList.remove('active');
        });

        const currentPane = document.getElementById(this.currentView);
        if (currentPane) {
            currentPane.classList.add('active');
        }

        if (this.currentView === 'specification' && window.Specification && window.Specification.lastSelectedPart) {
            setTimeout(() => {
                const rows = document.querySelectorAll('.part-row');
                rows.forEach(row => {
                    const partName = row.getAttribute('data-part-name');
                    if (partName === window.Specification.lastSelectedPart) {
                        row.classList.add('active');
                        window.Specification.highlightParts(partName, true);
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
            this.currentView = savedView;
            this.showCurrentView();
            this.updateToggleIcon();
        }
    }

    setView(view) {
        if (view === 'specification' || view === 'cutting') {
            this.currentView = view;
            this.showCurrentView();
            this.updateToggleIcon();
            this.saveViewState();
        }
    }
}

// Автоматическая инициализация
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.resizeHandler = new ResizeHandler();
    });
} else {
    window.resizeHandler = new ResizeHandler();
}