/**
 * Модуль управления UI элементами
 */
export const UIManager = {
    /**
     * Обновляет отображение в зависимости от режима
     */
    updateView(mode) {
        const modelContainer = document.getElementById('model-container');
        const drawingContainer = document.getElementById('drawing-container');
        const imageElement = document.getElementById('drawing-image');
        const placeholder = document.getElementById('drawing-placeholder');

        if (mode === '3D') {
            modelContainer.classList.add('active');
            modelContainer.classList.remove('disabled');
            drawingContainer.classList.remove('active');
        } else {
            modelContainer.classList.remove('active');
            drawingContainer.classList.add('active');

            const hasImage = imageElement.src && imageElement.src !== window.location.href;

            if (hasImage) {
                imageElement.style.display = 'block';
                placeholder.style.display = 'none';
            } else {
                imageElement.style.display = 'none';
                placeholder.style.display = 'block';
            }
        }
    },

    /**
     * Обновляет состояние кнопки переключения режима
     */
    updateToggleButton(mode) {
        const btn = document.getElementById('toggle-3d-2d-btn');
        const icon = mode === '3D' ? 'image' : 'cube';
        btn.innerHTML = `<svg><use xlink:href="assets/icons/sprite.svg#${icon}"></use></svg>`;
    },

    /**
     * Создает элементы управления для нескольких чертежей
     */
    createMultiDrawingControls(drawingLoader) {
        const controls = document.querySelector('.drawing-controls');
        this.removeMultiDrawingControls();

        // Кнопка "Предыдущий"
        const prevBtn = document.createElement('button');
        prevBtn.className = 'drawing-btn prev-drawing';
        prevBtn.title = 'Предыдущий лист';
        prevBtn.innerHTML = '<svg><use xlink:href="assets/icons/sprite.svg#chevron-left"></use></svg>';
        controls.appendChild(prevBtn);

        // Индикатор
        const indicator = document.createElement('div');
        indicator.className = 'drawing-indicator';
        indicator.innerHTML = '<span class="current-sheet">1</span> / <span class="total-sheets">1</span>';
        controls.appendChild(indicator);

        // Кнопка "Следующий"
        const nextBtn = document.createElement('button');
        nextBtn.className = 'drawing-btn next-drawing';
        nextBtn.title = 'Следующий лист';
        nextBtn.innerHTML = '<svg><use xlink:href="assets/icons/sprite.svg#chevron-right"></use></svg>';
        controls.appendChild(nextBtn);

        // Обработчики
        prevBtn.addEventListener('click', () => drawingLoader.switchDrawing(-1));
        nextBtn.addEventListener('click', () => drawingLoader.switchDrawing(1));

        this.updateDrawingIndicator();
    },

    /**
     * Удаляет элементы управления для нескольких чертежей
     */
    removeMultiDrawingControls() {
        const controls = document.querySelector('.drawing-controls');
        const prevBtn = controls.querySelector('.prev-drawing');
        const nextBtn = controls.querySelector('.next-drawing');
        const indicator = controls.querySelector('.drawing-indicator');

        if (prevBtn) prevBtn.remove();
        if (nextBtn) nextBtn.remove();
        if (indicator) indicator.remove();
    },

    /**
     * Обновляет индикатор текущего чертежа
     */
    updateDrawingIndicator() {
        if (!window.currentDrawings) return;

        const { files, currentIndex } = window.currentDrawings;
        const currentEl = document.querySelector('.current-sheet');
        const totalEl = document.querySelector('.total-sheets');
        const prevBtn = document.querySelector('.prev-drawing');
        const nextBtn = document.querySelector('.next-drawing');

        if (currentEl) currentEl.textContent = currentIndex + 1;
        if (totalEl) totalEl.textContent = files.length;

        if (files.length <= 1) {
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
        } else {
            if (prevBtn) prevBtn.style.display = 'flex';
            if (nextBtn) nextBtn.style.display = 'flex';
        }
    },
};