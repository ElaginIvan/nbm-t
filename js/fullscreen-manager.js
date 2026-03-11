/**
 * Fullscreen Manager Module
 * Отвечает за управление полноэкранным режимом
 */

import { store } from './store.js';

export const FullscreenManager = {
    isFullscreen: false,

    init() {
        this.toggleBtn = document.getElementById('toggle-fullscreen-btn');
        this.modelContainer = document.getElementById('model-container');
        this.drawingContainer = document.getElementById('drawing-container');
        this.infoPanel = document.querySelector('.info-panel');

        if (!this.toggleBtn) return;

        this.bindEvents();
        console.log('Fullscreen manager initialized');
    },

    bindEvents() {
        this.toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.toggleFullscreen();
        });

        // Выход по ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isFullscreen) {
                this.exitFullscreen();
            }
        });
    },

    toggleFullscreen() {
        if (this.isFullscreen) {
            this.exitFullscreen();
        } else {
            this.enterFullscreen();
        }
    },

    enterFullscreen() {
        const activeContainer = this.modelContainer.classList.contains('active')
            ? this.modelContainer
            : this.drawingContainer;

        this.infoPanel.style.display = 'none';

        const resizeHandle = document.getElementById('resize-handle');
        if (resizeHandle) {
            resizeHandle.style.display = 'none';
        }

        document.body.classList.add('fullscreen-active');
        activeContainer.classList.add('fullscreen-expanded');

        const projectContainer = document.querySelector('.project-container');
        if (projectContainer) {
            projectContainer.classList.add('fullscreen-wide');
        }

        this.isFullscreen = true;
        store.setState('ui.isFullscreen', true);

        this.updateButtonState();

        if (activeContainer === this.modelContainer && window.onWindowResize) {
            setTimeout(() => window.onWindowResize(), 50);
        }

        if (activeContainer === this.drawingContainer) {
            this.setupDrawingControls();
        }

        console.log('Entered fullscreen mode');
    },

    exitFullscreen() {
        if (!this.isFullscreen) return;

        const activeContainer = this.modelContainer.classList.contains('active')
            ? this.modelContainer
            : this.drawingContainer;

        this.infoPanel.style.display = '';

        const resizeHandle = document.getElementById('resize-handle');
        if (resizeHandle) {
            resizeHandle.style.display = '';
        }

        document.body.classList.remove('fullscreen-active');
        this.modelContainer.classList.remove('fullscreen-expanded');
        this.drawingContainer.classList.remove('fullscreen-expanded');

        const projectContainer = document.querySelector('.project-container');
        if (projectContainer) {
            projectContainer.classList.remove('fullscreen-wide');
        }

        this.isFullscreen = false;
        store.setState('ui.isFullscreen', false);

        this.updateButtonState();

        if (activeContainer === this.modelContainer) {
            activeContainer.style.transition = 'height 0.3s ease';

            const onTransitionEnd = () => {
                activeContainer.removeEventListener('transitionend', onTransitionEnd);
                activeContainer.style.transition = '';

                if (window.onWindowResize) {
                    window.onWindowResize();
                    console.log('Window resized after smooth transition');
                }
            };

            activeContainer.addEventListener('transitionend', onTransitionEnd);

            setTimeout(() => {
                if (activeContainer.style.transition) {
                    activeContainer.removeEventListener('transitionend', onTransitionEnd);
                    activeContainer.style.transition = '';
                    if (window.onWindowResize) {
                        window.onWindowResize();
                    }
                }
            }, 50);
        } else {
            setTimeout(() => {
                if (window.onWindowResize) {
                    window.onWindowResize();
                }
            }, 50);
        }

        this.restoreDrawingControls();

        console.log('Exited fullscreen mode');
    },

    updateButtonState() {
        const icon = this.isFullscreen ? 'compress' : 'expand';
        this.toggleBtn.innerHTML = `<svg><use xlink:href="assets/icons/sprite.svg#${icon}"></use></svg>`;
    },

    setupDrawingControls() {
        const drawingControls = this.drawingContainer.querySelector('.drawing-controls');
        if (!drawingControls) return;

        drawingControls.classList.add('fullscreen-controls');

        if (this.isMobile()) {
            drawingControls.style.bottom = '80px';
        }
    },

    restoreDrawingControls() {
        const drawingControls = this.drawingContainer.querySelector('.drawing-controls');
        if (!drawingControls) return;

        drawingControls.classList.remove('fullscreen-controls');
        drawingControls.style.bottom = '';
    },

    isMobile() {
        return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    },

    forceExit() {
        if (this.isFullscreen) {
            this.exitFullscreen();
        }
    }
};

// Автоматическая инициализация
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => FullscreenManager.init());
} else {
    FullscreenManager.init();
}

// Экспорт
window.FullscreenManager = FullscreenManager;
window.exitFullscreen = () => FullscreenManager.exitFullscreen();

export default FullscreenManager;
