// js/fullscreen-manager.js
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
        // Определяем активный контейнер
        const activeContainer = this.modelContainer.classList.contains('active')
            ? this.modelContainer
            : this.drawingContainer;

        // Прячем панель с информацией
        this.infoPanel.style.display = 'none';

        // Прячем ползунок
        const resizeHandle = document.getElementById('resize-handle');
        if (resizeHandle) {
            resizeHandle.style.display = 'none';
        }

        // Добавляем класс к body для полноэкранных стилей
        document.body.classList.add('fullscreen-active');

        // Добавляем класс к активному контейнеру
        activeContainer.classList.add('fullscreen-expanded');

        // Убираем ограничение ширины у контейнера
        const projectContainer = document.querySelector('.project-container');
        if (projectContainer) {
            projectContainer.classList.add('fullscreen-wide');
        }

        // Обновляем состояние
        this.isFullscreen = true;

        // Обновляем кнопку
        this.updateButtonState();

        // Обновляем Three.js если нужно
        if (activeContainer === this.modelContainer && window.onWindowResize) {
            setTimeout(() => window.onWindowResize(), 50);
        }

        // Настраиваем панель управления чертежами
        if (activeContainer === this.drawingContainer) {
            this.setupDrawingControls();
        }

        console.log('Entered fullscreen mode');
    },

    exitFullscreen() {
        if (!this.isFullscreen) return;

        // Сохраняем ссылку на активный контейнер до изменений
        const activeContainer = this.modelContainer.classList.contains('active')
            ? this.modelContainer
            : this.drawingContainer;

        // Показываем панель с информацией
        this.infoPanel.style.display = '';

        // Показываем ползунок
        const resizeHandle = document.getElementById('resize-handle');
        if (resizeHandle) {
            resizeHandle.style.display = '';
        }

        // Убираем классы
        document.body.classList.remove('fullscreen-active');
        this.modelContainer.classList.remove('fullscreen-expanded');
        this.drawingContainer.classList.remove('fullscreen-expanded');

        // Восстанавливаем обычную ширину
        const projectContainer = document.querySelector('.project-container');
        if (projectContainer) {
            projectContainer.classList.remove('fullscreen-wide');
        }

        // Обновляем состояние
        this.isFullscreen = false;

        // Обновляем кнопку
        this.updateButtonState();

        // ПЛАВНОЕ РЕШЕНИЕ: используем transitionend событие
        // Добавляем временный обработчик для плавного изменения размера
        if (activeContainer === this.modelContainer) {
            // Сначала добавляем transition для контейнера
            activeContainer.style.transition = 'height 0.3s ease';
            
            // Ждем окончания анимации изменения размера
            const onTransitionEnd = () => {
                activeContainer.removeEventListener('transitionend', onTransitionEnd);
                activeContainer.style.transition = '';
                
                // Вызываем onWindowResize после окончания анимации
                if (window.onWindowResize) {
                    window.onWindowResize();
                    console.log('Window resized after smooth transition');
                }
            };
            
            activeContainer.addEventListener('transitionend', onTransitionEnd);
            
            // Если transition не сработал (запасной вариант)
            setTimeout(() => {
                if (activeContainer.style.transition) {
                    activeContainer.removeEventListener('transitionend', onTransitionEnd);
                    activeContainer.style.transition = '';
                    if (window.onWindowResize) {
                        window.onWindowResize();
                    }
                }
            }, 50); // Чуть больше чем transition
        } else {
            // Для чертежей просто вызываем с задержкой
            setTimeout(() => {
                if (window.onWindowResize) {
                    window.onWindowResize();
                }
            }, 50);
        }

        // Восстанавливаем панель управления чертежами
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

        // Просто добавляем класс для стилей
        drawingControls.classList.add('fullscreen-controls');

        // Перемещаем панель повыше на мобильных
        if (this.isMobile()) {
            drawingControls.style.bottom = '80px'; // Выше системной панели
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