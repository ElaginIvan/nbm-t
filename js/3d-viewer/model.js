/**
 * 3D Viewer Module
 * Отвечает за инициализацию и рендеринг 3D сцены
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';

import { initCuttingTool } from './model-cut.js';
import { getModelPath, showErrorMessage } from './model-utils.js';
import { setupLights, updateCameraLightPosition } from './model-lights.js';
import { createAdaptiveGrid, updateGridPosition, checkCameraOrientation } from './model-grid.js';
import { addEdgesToObject } from './model-geometry.js';
import { setupCamera } from './model-camera.js';
import { onWindowResize as handleWindowResize, initResizeListener } from './model-WindowResize.js';

import { store } from '../store.js';
import { SpecificationService } from '../services/specificationService.js';

// ============================================================
// Состояние модуля (локальное, не глобальное)
// ============================================================
let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let model = null;
let gridHelper = null;

let isGridVisible = true;
let originalGridOpacity = 0.5;

// Флаг для отслеживания состояния загрузки
let modelLoaded = false;
let modelLoadCallbacks = [];

// ============================================================
// Вспомогательные функции
// ============================================================

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
 * Получает цвет модели из localStorage
 * @returns {string|null} Цвет в формате hex или null
 */
function getModelColor() {
    const savedSettings = localStorage.getItem('uiSettings');
    if (savedSettings) {
        try {
            const { modelColor } = JSON.parse(savedSettings);
            return modelColor || null;
        } catch (e) {
            console.warn('Failed to parse model color from settings:', e);
        }
    }
    return null;
}

/**
 * Получает настройки материала из localStorage
 * @returns {Object} Настройки материала { metalness, roughness }
 */
function getMaterialSettings() {
    const savedSettings = localStorage.getItem('uiSettings');
    if (savedSettings) {
        try {
            const { modelMetalness, modelRoughness } = JSON.parse(savedSettings);
            return {
                metalness: modelMetalness !== undefined ? modelMetalness : 0.1,
                roughness: modelRoughness !== undefined ? modelRoughness : 0.75
            };
        } catch (e) {
            console.warn('Failed to parse material settings from settings:', e);
        }
    }
    return { metalness: 0.1, roughness: 0.75 };
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

// ============================================================
// Основные функции
// ============================================================

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
    const cameraSetup = setupCamera(container, canvas);
    camera = cameraSetup.camera;
    renderer = cameraSetup.renderer;
    controls = cameraSetup.controls;

    setupLights(scene);
    loadModel();
    animate();
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

            // Применяем настройки материала (metalness, roughness)
            const materialSettings = getMaterialSettings();
            model.traverse((child) => {
                if (child.isMesh && child.material) {
                    child.material.metalness = materialSettings.metalness;
                    child.material.roughness = materialSettings.roughness;
                }
            });
            console.log('Model material settings applied:', materialSettings);

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
                    child.receiveShadow = true;
                }
            });

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

            handleWindowResize(camera, renderer, gridHelper, model);
            initResizeListener(camera, renderer, gridHelper, model);

            // Обработчик двойного клика на canvas, для сброса вида
            const canvas = document.getElementById('viewer');
            canvas.addEventListener('dblclick', resetView);

            // Обновляем store
            store.setState('model.object', model);
            store.setState('model.isLoaded', true);
            store.setState('model.path', modelPath);

            modelLoaded = true;

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

            // Сохраняем структуру модели через сервис
            const projectId = store.getState('project.currentId');
            if (projectId) {
                setTimeout(() => {
                    SpecificationService.saveModelStructure(model, projectId);
                }, 100);
            }

            console.log('✅ Model fully loaded and ready');
        },
        function (xhr) {
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

/**
 * Функция сброса вида
 */
function resetView() {
    if (!model || !camera || !controls) return;

    console.log('🔄 Resetting 3D view');

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    const distance = maxSize * 2;

    camera.position.set(distance, distance * 0.7, distance);
    camera.lookAt(0, 0, 0);

    controls.target.set(0, 0, 0);
    controls.update();

    if (gridHelper) {
        updateGridPosition(model, gridHelper);
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

    // Обновляем позицию света в соответствии с камерой
    if (camera && model) {
        updateCameraLightPosition(camera, model);
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
        handleWindowResize(camera, renderer, gridHelper, model);
    } else {
        const checkInterval = setInterval(() => {
            if (camera && renderer && gridHelper && model) {
                clearInterval(checkInterval);
                handleWindowResize(camera, renderer, gridHelper, model);
            }
        }, 200);
    }
};

// ============================================================
// Экспорт
// ============================================================

export const ModelViewer = {
    init,
    loadModel,
    addEdgesToObject,
    showErrorMessage,
    getModel: () => model,
    getScene: () => scene,
    getCamera: () => camera,
    getControls: () => controls,
    isModelLoaded: () => modelLoaded,
    onModelLoaded: onModelLoaded,
    resetView
};

// Экспортируем для совместимости
window.ModelViewer = ModelViewer;

export default ModelViewer;
