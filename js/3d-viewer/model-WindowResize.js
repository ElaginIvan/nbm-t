/**
 * model-WindowResize.js
 * Обработчик изменения размера окна для 3D вьювера
 */

// Импортируем необходимые функции
import { updateGridPosition } from './model-grid.js';

/**
 * Обрабатывает изменение размера окна
 * @param {THREE.Camera} camera - Камера сцены
 * @param {THREE.WebGLRenderer} renderer - Рендерер
 * @param {THREE.Object3D} gridHelper - Сетка
 * @param {THREE.Object3D} model - Модель
 */
function onWindowResize(camera, renderer, gridHelper, model) {
    const container = document.getElementById('model-container');
    if (container && camera && renderer) {
        // Получаем актуальные размеры контейнера
        const width = container.clientWidth;
        const height = container.clientHeight;

        // Обновляем камеру и рендерер
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);

        // Только обновляем позицию сетки, не меняем прозрачность
        if (gridHelper && model) {
            updateGridPosition(model, gridHelper);
        }
    }
}

/**
 * Создает обработчик изменения размера с привязанными зависимостями
 * @param {THREE.Camera} camera - Камера сцены
 * @param {THREE.WebGLRenderer} renderer - Рендерер
 * @param {THREE.Object3D} gridHelper - Сетка
 * @param {THREE.Object3D} model - Модель
 * @returns {Function} Функция-обработчик
 */
function createResizeHandler(camera, renderer, gridHelper, model) {
    return function() {
        onWindowResize(camera, renderer, gridHelper, model);
    };
}

/**
 * Инициализирует слушатель события изменения размера окна
 * @param {THREE.Camera} camera - Камера сцены
 * @param {THREE.WebGLRenderer} renderer - Рендерер
 * @param {THREE.Object3D} gridHelper - Сетка
 * @param {THREE.Object3D} model - Модель
 * @returns {Function} Функция для удаления слушателя
 */
function initResizeListener(camera, renderer, gridHelper, model) {
    const resizeHandler = createResizeHandler(camera, renderer, gridHelper, model);
    window.addEventListener('resize', resizeHandler);
    
    // Возвращаем функцию для удаления слушателя
    return function() {
        window.removeEventListener('resize', resizeHandler);
    };
}

// Экспортируем функции
export {
    onWindowResize,
    createResizeHandler,
    initResizeListener
};