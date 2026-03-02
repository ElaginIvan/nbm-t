/**
 * Модуль управления масштабированием
 * Интегрирован с store для сохранения состояния
 */

import { drawingStore } from '../store.js';

export const ZoomManager = {
    zoomLevel: 1,
    minZoom: 0.1,
    maxZoom: 5,
    imagePos: { x: 0, y: 0 },
    currentMode: '3D',
    isDragging: false,
    startPos: { x: 0, y: 0 },

    /**
     * Сбрасывает масштаб и позицию
     */
    resetZoom() {
        this.zoomLevel = 1;
        this.imagePos = { x: 0, y: 0 };
        this.applyZoom();
    },

    /**
     * Применяет текущий масштаб и позицию
     */
    applyZoom() {
        const imageElement = document.getElementById('drawing-image');
        if (!imageElement) return;

        imageElement.style.transform =
            `translate(${this.imagePos.x}px, ${this.imagePos.y}px) scale(${this.zoomLevel})`;
        imageElement.style.transformOrigin = 'center center';
    },

    /**
     * Увеличивает масштаб
     */
    zoomIn(delta = 0.1) {
        if (this.currentMode !== '2D') return;

        this.zoomLevel = Math.min(this.maxZoom, this.zoomLevel + delta);
        this.applyZoom();
    },

    /**
     * Уменьшает масштаб
     */
    zoomOut(delta = 0.1) {
        if (this.currentMode !== '2D') return;

        this.zoomLevel = Math.max(this.minZoom, this.zoomLevel - delta);
        this.applyZoom();
    },

    /**
     * Устанавливает масштаб
     */
    setZoom(level) {
        if (this.currentMode !== '2D') return;

        this.zoomLevel = Math.max(this.minZoom, Math.min(this.maxZoom, level));
        this.applyZoom();
    },

    /**
     * Перемещает изображение
     */
    pan(x, y) {
        if (this.currentMode !== '2D') return;

        this.imagePos.x += x;
        this.imagePos.y += y;
        this.applyZoom();
    },

    /**
     * Начинает перетаскивание
     */
    startDrag(startX, startY) {
        if (this.currentMode !== '2D') return;

        this.isDragging = true;
        this.startPos = { x: startX, y: startY };
    },

    /**
     * Перетаскивает изображение
     */
    drag(currentX, currentY) {
        if (!this.isDragging || this.currentMode !== '2D') return;

        const deltaX = currentX - this.startPos.x;
        const deltaY = currentY - this.startPos.y;

        this.pan(deltaX, deltaY);
        this.startPos = { x: currentX, y: currentY };
    },

    /**
     * Завершает перетаскивание
     */
    endDrag() {
        this.isDragging = false;
    },

    /**
     * Проверяет, является ли текущий режим 2D
     */
    is2DMode() {
        return this.currentMode === '2D';
    }
};

export default ZoomManager;
