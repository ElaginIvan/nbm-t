/**
 * Модуль обработки ввода (мышь и тач события)
 */
export const InputHandlers = {
    isDragging: false,
    isZooming: false,
    dragStart: { x: 0, y: 0 },
    initialDistance: null,
    initialZoom: 1,

    /**
     * Инициализирует обработчики мыши
     */
    initMouseHandlers(drawingViewer, zoomManager) {
        const imageElement = document.getElementById('drawing-image');
        const drawingWrapper = document.querySelector('.drawing-wrapper');

        if (imageElement) {
            imageElement.addEventListener('mousedown', (e) => this.handleMouseDown(e, drawingViewer, zoomManager));
            // 👇 ДОБАВЛЯЕМ обработчик двойного клика на изображение
            imageElement.addEventListener('dblclick', (e) => this.handleDoubleClick(e, drawingViewer, zoomManager));
        }

        if (drawingWrapper) {
            drawingWrapper.addEventListener('mousedown', (e) => {
                if (e.target === drawingWrapper) {
                    this.handleMouseDown(e, drawingViewer, zoomManager);
                }
            });
            // 👇 ДОБАВЛЯЕМ обработчик двойного клика на wrapper
            drawingWrapper.addEventListener('dblclick', (e) => this.handleDoubleClick(e, drawingViewer, zoomManager));
        }

        document.addEventListener('mouseup', () => this.handleMouseUp());
        document.addEventListener('mousemove', (e) => this.handleMouseMove(e, zoomManager));

        const drawingContainer = document.getElementById('drawing-container');
        if (drawingContainer) {
            drawingContainer.addEventListener('wheel', (e) => this.handleWheel(e, drawingViewer, zoomManager), { passive: false });
        }
    },

    /**
     * Инициализирует обработчики тач-событий
     */
    initTouchHandlers(drawingViewer, zoomManager) {
        const drawingWrapper = document.querySelector('.drawing-wrapper');
        if (drawingWrapper) {
            drawingWrapper.addEventListener('touchstart', (e) => this.handleTouchStart(e, drawingViewer, zoomManager), { passive: true });
            drawingWrapper.addEventListener('touchmove', (e) => this.handleTouchMove(e, drawingViewer, zoomManager), { passive: true });
            drawingWrapper.addEventListener('touchend', (e) => this.handleTouchEnd(e, drawingViewer, zoomManager));
        }
    },


    /**
     * Обработка нажатия кнопки мыши
     */
    handleMouseDown(e, drawingViewer, zoomManager) {
        if (drawingViewer.currentMode !== '2D') return;

        e.preventDefault();
        e.stopPropagation();

        this.isDragging = true;
        this.dragStart.x = e.clientX - zoomManager.imagePos.x;
        this.dragStart.y = e.clientY - zoomManager.imagePos.y;

        const imageElement = document.getElementById('drawing-image');
        if (imageElement) {
            imageElement.style.cursor = 'grabbing';
            imageElement.classList.add('dragging');
        }

        const drawingWrapper = document.querySelector('.drawing-wrapper');
        if (drawingWrapper) {
            drawingWrapper.style.cursor = 'grabbing';
        }

        console.log('🐭 Mouse drag started', { x: this.dragStart.x, y: this.dragStart.y });
    },

    /**
     * Обработка движения мыши
     */
    handleMouseMove(e, zoomManager) {
        if (!this.isDragging) return;

        e.preventDefault();
        e.stopPropagation();

        zoomManager.imagePos.x = e.clientX - this.dragStart.x;
        zoomManager.imagePos.y = e.clientY - this.dragStart.y;
        zoomManager.applyZoom();

        console.log('🐭 Mouse dragging', { x: zoomManager.imagePos.x, y: zoomManager.imagePos.y });
    },

    /**
     * Обработка отпускания кнопки мыши
     */
    handleMouseUp() {
        if (!this.isDragging) return;

        this.isDragging = false;
        const imageElement = document.getElementById('drawing-image');
        const drawingWrapper = document.querySelector('.drawing-wrapper');

        if (imageElement) {
            imageElement.style.cursor = 'grab';
            imageElement.classList.remove('dragging');
        }

        if (drawingWrapper) {
            drawingWrapper.style.cursor = 'default';
        }

        console.log('🐭 Mouse drag ended');
    },

    /**
     * Обработка колеса мыши
     */
    handleWheel(e, drawingViewer, zoomManager) {
        if (drawingViewer.currentMode !== '2D') return;

        e.preventDefault();
        e.stopPropagation();

        const drawingContainer = document.getElementById('drawing-container');
        const imageElement = document.getElementById('drawing-image');

        if (!drawingContainer || !imageElement) return;

        const delta = Math.sign(e.deltaY);
        const zoomFactor = delta > 0 ? 0.9 : 1.1;

        const rect = drawingContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const imageRect = imageElement.getBoundingClientRect();
        const imageCenterX = imageRect.left - rect.left + imageRect.width / 2;
        const imageCenterY = imageRect.top - rect.top + imageRect.height / 2;

        const relativeX = mouseX - imageCenterX;
        const relativeY = mouseY - imageCenterY;

        const oldZoom = zoomManager.zoomLevel;
        zoomManager.zoomLevel *= zoomFactor;
        zoomManager.zoomLevel = Math.max(zoomManager.minZoom, Math.min(zoomManager.maxZoom, zoomManager.zoomLevel));

        if (zoomManager.zoomLevel !== oldZoom) {
            const scaleChange = zoomManager.zoomLevel / oldZoom;
            zoomManager.imagePos.x -= relativeX * (1 - 1 / scaleChange);
            zoomManager.imagePos.y -= relativeY * (1 - 1 / scaleChange);
            zoomManager.applyZoom();

            console.log('🔍 Zoom level changed:', zoomManager.zoomLevel);
        }
    },

    /**
     * Начало касания
     */
    handleTouchStart(e, drawingViewer, zoomManager) {
        if (drawingViewer.currentMode !== '2D') return;

        if (e.touches.length === 2) {
            e.preventDefault();
            e.stopPropagation();

            this.isZooming = true;
            this.isDragging = false;

            this.initialDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
            this.initialZoom = zoomManager.zoomLevel;

            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            this.dragStart.x = (touch1.clientX + touch2.clientX) / 2 - zoomManager.imagePos.x;
            this.dragStart.y = (touch1.clientY + touch2.clientY) / 2 - zoomManager.imagePos.y;
        } else if (e.touches.length === 1) {
            e.preventDefault();
            e.stopPropagation();

            this.isDragging = true;
            this.isZooming = false;

            const touch = e.touches[0];
            this.dragStart.x = touch.clientX - zoomManager.imagePos.x;
            this.dragStart.y = touch.clientY - zoomManager.imagePos.y;

            const imageElement = document.getElementById('drawing-image');
            if (imageElement) {
                imageElement.classList.add('dragging');
            }
        }
    },

    /**
     * Движение пальцев
     */
    handleTouchMove(e, drawingViewer, zoomManager) {
        if (drawingViewer.currentMode !== '2D') return;

        if (this.isZooming && e.touches.length === 2) {
            e.preventDefault();
            e.stopPropagation();

            const currentDistance = this.getTouchDistance(e.touches[0], e.touches[1]);

            if (this.initialDistance) {
                const scaleFactor = currentDistance / this.initialDistance;
                const newZoomLevel = Math.max(zoomManager.minZoom, Math.min(zoomManager.maxZoom, this.initialZoom * scaleFactor));

                if (newZoomLevel !== zoomManager.zoomLevel) {
                    const touch1 = e.touches[0];
                    const touch2 = e.touches[1];
                    const centerX = (touch1.clientX + touch2.clientX) / 2;
                    const centerY = (touch1.clientY + touch2.clientY) / 2;

                    const drawingContainer = document.getElementById('drawing-container');
                    const imageElement = document.getElementById('drawing-image');

                    if (drawingContainer && imageElement) {
                        const rect = drawingContainer.getBoundingClientRect();
                        const imageRect = imageElement.getBoundingClientRect();

                        const containerCenterX = centerX - rect.left;
                        const containerCenterY = centerY - rect.top;

                        const imageCenterX = imageRect.left - rect.left + imageRect.width / 2;
                        const imageCenterY = imageRect.top - rect.top + imageRect.height / 2;

                        const relativeX = containerCenterX - imageCenterX;
                        const relativeY = containerCenterY - imageCenterY;

                        const oldZoom = zoomManager.zoomLevel;
                        zoomManager.zoomLevel = newZoomLevel;

                        const scaleChange = zoomManager.zoomLevel / oldZoom;
                        zoomManager.imagePos.x -= relativeX * (1 - 1 / scaleChange);
                        zoomManager.imagePos.y -= relativeY * (1 - 1 / scaleChange);
                    }

                    zoomManager.applyZoom();
                }
            }
        } else if (this.isDragging && e.touches.length === 1) {
            e.preventDefault();
            e.stopPropagation();

            const touch = e.touches[0];
            zoomManager.imagePos.x = touch.clientX - this.dragStart.x;
            zoomManager.imagePos.y = touch.clientY - this.dragStart.y;
            zoomManager.applyZoom();
        }
    },

    /**
     * Завершение касания
     */
    handleTouchEnd(e, drawingViewer, zoomManager) {
        if (this.isZooming) {
            this.isZooming = false;
            this.initialDistance = null;
            this.initialZoom = 1;
        }

        if (this.isDragging) {
            this.isDragging = false;

            const imageElement = document.getElementById('drawing-image');
            if (imageElement) {
                imageElement.classList.remove('dragging');
            }
        }

        // Если больше нет касаний, сбрасываем состояние
        if (e.touches.length === 0) {
            this.isDragging = false;
            this.isZooming = false;
        }
    },

    /**
     * 👇 НОВЫЙ МЕТОД: Обработка двойного клика/нажатия
     */
    handleDoubleClick(e, drawingViewer, zoomManager) {
        // Работает только в 2D режиме
        if (drawingViewer.currentMode !== '2D') return;

        e.preventDefault();
        e.stopPropagation();

        console.log('🔄 Double click/tap - reset zoom');

        // Вызываем сброс зума
        zoomManager.resetZoom();
    },

    /**
     * Вычисляет расстояние между двумя точками касания
     */
    getTouchDistance(touch1, touch2) {
        const dx = touch2.clientX - touch1.clientX;
        const dy = touch2.clientY - touch1.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }
};