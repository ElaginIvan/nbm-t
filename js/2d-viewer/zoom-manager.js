/**
 * Модуль управления масштабированием
 */
export const ZoomManager = {
    zoomLevel: 1,
    minZoom: 0.1,
    maxZoom: 5,
    imagePos: { x: 0, y: 0 },

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
    }
};