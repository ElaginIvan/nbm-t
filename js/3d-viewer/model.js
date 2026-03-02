// Основные переменные
let scene, camera, renderer, controls, model, gridHelper;
let isGridVisible = true;
let originalGridOpacity = 0.5;

/**
 * Глобальная константа цвета модели
 * Установите null чтобы использовать цвет из projects.json или цвет модели по умолчанию
 */
// Зеленый - 0x006629, Желтый - 0xa8b800, Синий - 0x0058bd
const DEFAULT_MODEL_COLOR = null; // Например: '#FF5733' или 0xFF5733

// Импорты
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { initCuttingTool } from './model-cut.js';
import { getModelPath, showErrorMessage } from './model-utils.js';
import { setupLights } from './model-lights.js';
import { createAdaptiveGrid, updateGridPosition, checkCameraOrientation } from './model-grid.js';
import { addEdgesToObject } from './model-geometry.js';
import { setupCamera } from './model-camera.js';
import { onWindowResize, initResizeListener } from './model-WindowResize.js';

// Флаг для отслеживания состояния загрузки
let modelLoaded = false;
let modelLoadCallbacks = [];

/**
 * Вызывается когда модель гарантированно загружена
 */
function onModelLoaded(callback) {
    if (modelLoaded && model) {
        callback(model);
    } else {
        modelLoadCallbacks.push(callback);
    }
}

/**
 * Инициализирует сцену
 */
function init() {
    const container = document.getElementById('model-container');
    if (!container) {
        console.error('Model container not found');
        return;
    }

    const modelPath = getModelPath();
    console.log('Model path:', modelPath);

    if (!modelPath) {
        showErrorMessage('Путь к модели не указан. Проверьте данные проекта.');
        return;
    }

    scene = new THREE.Scene();

    const canvas = document.getElementById('viewer');
    ({ camera, renderer, controls } = setupCamera(container, canvas));

    setupLights(scene);
    loadModel();
    animate();
}

/**
 * Получает цвет модели из projects.json или глобальной константы
 * @returns {string|null} Цвет в формате hex или null
 */
function getModelColor() {
    // Сначала проверяем глобальную константу
    if (DEFAULT_MODEL_COLOR) {
        return DEFAULT_MODEL_COLOR;
    }

    // Затем проверяем projects.json
    const projectData = document.getElementById('project-data');
    if (projectData) {
        const color = projectData.getAttribute('data-model-color');
        if (color) {
            return color;
        }
    }

    // Если цвет не указан, возвращаем null (используется цвет модели по умолчанию)
    return null;
}

/**
 * Применяет цвет ко всем мешам модели
 * @param {THREE.Object3D} object - Объект модели
 * @param {string} color - Цвет в формате hex
 */
function applyModelColor(object, color) {
    object.traverse((child) => {
        if (child.isMesh && child.material) {
            const newColor = new THREE.Color(color);
            child.material.color = newColor;
        }
    });
}

/**
 * Загружает модель с гарантией завершения
 */
function loadModel() {
    const modelPath = getModelPath();
    console.log('Loading model from:', modelPath);

    if (!modelPath) {
        showErrorMessage('Путь к модели не указан');
        return;
    }

    const loader = new GLTFLoader();

    // Показываем индикатор загрузки для больших моделей
    showLoadingIndicator();

    loader.load(
        modelPath,
        function (gltf) {
            console.log('Model loaded successfully');
            model = gltf.scene;

            // Применяем цвет если указан
            const modelColor = getModelColor();
            if (modelColor) {
                applyModelColor(model, modelColor);
                console.log('Model color applied:', modelColor);
            }

            // Центрирование
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());

            model.position.x -= center.x;
            model.position.y -= center.y;
            model.position.z -= center.z;

            scene.add(model);

            // Включаем тени для всех мешей модели
            model.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true; // false - Модель не получает тени (только отбрасывает)
                }
            });

            // addEdgesToObject(model); // Наносим ребра на кромки
            initCuttingTool(scene, model, renderer);

            createAdaptiveGrid(scene);
            gridHelper = scene.getObjectByName('adaptiveGrid');

            if (gridHelper) {
                updateGridPosition(model, gridHelper);
            }

            const size = box.getSize(new THREE.Vector3());
            const maxSize = Math.max(size.x, size.y, size.z);
            const distance = maxSize * 2;

            camera.position.set(distance, distance * 0.7, distance);
            camera.lookAt(0, 0, 0);
            controls.target.set(0, 0, 0);
            controls.update();

            onWindowResize(camera, renderer, gridHelper, model);
            initResizeListener(camera, renderer, gridHelper, model);

            // Обработчик двойного клика на canvas, для сброса вида
            const canvas = document.getElementById('viewer');
            canvas.addEventListener('dblclick', resetView);

            // Устанавливаем флаг загрузки и делаем модель глобальной
            modelLoaded = true;
            window.model = model;

            // Скрываем индикатор загрузки
            hideLoadingIndicator();

            // Вызываем все сохраненные колбэки
            modelLoadCallbacks.forEach(callback => {
                try {
                    callback(model);
                } catch (e) {
                    console.error('Error in model load callback:', e);
                }
            });
            modelLoadCallbacks = [];

            // Диспатчим событие
            window.dispatchEvent(new CustomEvent('modelLoaded', {
                detail: { model, scene, camera, controls }
            }));

            // Передаем структуру модели
            if (window.Specification && typeof window.Specification.saveModelStructure === 'function') {
                // Даем небольшой таймаут для гарантии, что все готово
                setTimeout(() => {
                    window.Specification.saveModelStructure(model);
                }, 100);
            }

            console.log('✅ Model fully loaded and ready');
        },
        function (xhr) {
            // Обновляем прогресс для больших моделей
            const percent = Math.round(xhr.loaded / xhr.total * 100);
            console.log(percent + '% loaded');
            updateLoadingProgress(percent);
        },
        function (error) {
            console.error('Error loading model:', error);
            hideLoadingIndicator();
            showErrorMessage('Не удалось загрузить модель. Проверьте путь к файлу: ' + modelPath);
        }
    );
}

// Функция сброса вида
function resetView() {
    if (!model || !camera || !controls) return;

    console.log('🔄 Resetting 3D view');

    // Получаем размеры модели для правильного позиционирования камеры
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    const distance = maxSize * 2; // Та же формула, что и при загрузке

    // Сбрасываем позицию камеры
    camera.position.set(distance, distance * 0.7, distance);
    camera.lookAt(0, 0, 0);

    // Сбрасываем target controls
    controls.target.set(0, 0, 0);
    controls.update();

    // Обновляем сетку если есть
    if (gridHelper) {
        updateGridPosition(model, gridHelper);
    }
}

/**
 * Показывает индикатор загрузки
 */
function showLoadingIndicator() {
    let loader = document.getElementById('model-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'model-loader';
        loader.innerHTML = `
            <div style="
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(0,0,0,0.8);
                color: white;
                padding: 20px;
                border-radius: 8px;
                z-index: 1000;
                text-align: center;
                min-width: 200px;
            ">
                <div style="margin-bottom: 10px;">Загрузка модели...</div>
                <div id="loader-progress" style="
                    width: 100%;
                    height: 4px;
                    background: #333;
                    border-radius: 2px;
                    overflow: hidden;
                ">
                    <div id="loader-progress-bar" style="
                        width: 0%;
                        height: 100%;
                        background: #4CAF50;
                        transition: width 0.3s;
                    "></div>
                </div>
                <div id="loader-percent" style="margin-top: 8px; font-size: 14px;">0%</div>
            </div>
        `;
        document.body.appendChild(loader);
    }
}

/**
 * Обновляет прогресс загрузки
 */
function updateLoadingProgress(percent) {
    const bar = document.getElementById('loader-progress-bar');
    const text = document.getElementById('loader-percent');
    if (bar) bar.style.width = percent + '%';
    if (text) text.textContent = percent + '%';
}

/**
 * Скрывает индикатор загрузки
 */
function hideLoadingIndicator() {
    const loader = document.getElementById('model-loader');
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => {
            if (loader.parentNode) loader.remove();
        }, 500);
    }
}

/**
 * Анимация
 */
function animate() {
    requestAnimationFrame(animate);

    if (gridHelper && camera) {
        checkCameraOrientation(gridHelper, camera, isGridVisible, originalGridOpacity);
    }

    if (controls) controls.update();
    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

// Запускаем инициализацию после загрузки DOM и данных проекта
function waitForProjectData() {
    const projectData = document.getElementById('project-data');
    const modelPath = projectData?.getAttribute('data-model-path');
    
    if (modelPath) {
        console.log('Project data loaded, initializing viewer...');
        init();
    } else {
        console.log('Waiting for project data...');
        setTimeout(waitForProjectData, 100);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForProjectData);
} else {
    waitForProjectData();
}

// Глобальная функция resize с проверкой загрузки
window.onWindowResize = function () {
    if (camera && renderer && gridHelper && model) {
        onWindowResize(camera, renderer, gridHelper, model);
    } else {
        // Ждем загрузки
        const checkInterval = setInterval(() => {
            if (camera && renderer && gridHelper && model) {
                clearInterval(checkInterval);
                onWindowResize(camera, renderer, gridHelper, model);
            }
        }, 200);
    }
};

// Экспортируем функции
window.ModelViewer = {
    init,
    loadModel,
    addEdgesToObject,
    showErrorMessage: window.showErrorMessage,
    getModel: () => model,
    getScene: () => scene,
    getCamera: () => camera,
    getControls: () => controls,
    isModelLoaded: () => modelLoaded,
    onModelLoaded: onModelLoaded,
    resetView: resetView
};