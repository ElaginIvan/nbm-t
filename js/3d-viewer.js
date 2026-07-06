/**
 * 3D Viewer Module
 * Отвечает за инициализацию и рендеринг 3D сцены
 *
 * Подмодули, выделенные в engine.js:
 * - setupCamera (камера)
 * - setupLights / updateCameraLightPosition (свет)
 * - createAdaptiveGrid / updateGridPosition / checkCameraOrientation (сетка)
 * - addEdgesToObject (геометрия)
 * - handleWindowResize / initResizeListener (resize)
 *
 * Плагины (выделены в js/plugins/):
 * - cutting-3d.js: сечение модели (стенцированные cap-плоскости)
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { OrbitControls } from 'three/addons/OrbitControls.js';


import { store, adjustEdgeColor, escapeHtml } from './app.js';
import { SpecificationService } from './specification.js';
import PluginManager from './plugin-system.js';
import {
    setupCamera,
    setupLights,
    updateCameraLightPosition,
    GRID_OPACITY,
    createAdaptiveGrid,
    updateGridPosition,
    checkCameraOrientation,
    addEdgesToObject,
    handleWindowResize,
    initResizeListener
} from './engine.js';

// Плагины 3D-модуля (импорт регистрирует их в PluginManager)
import './plugins/cutting-3d.js';
import './plugins/measure.js';
import './plugins/animation.js';
import './plugins/center-of-mass.js';

// ============================================================
// model-utils.js
// ============================================================

function getModelPath() {
    return document.getElementById('project-data')?.getAttribute('data-model-path') || '';
}

function showErrorMessage(message) {
    const container = document.getElementById('model-container');
    if (container) {
        container.innerHTML = `
            <div class="empty-state empty-state--error">
                <svg class="icon icon--warning" aria-hidden="true">
                    <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
                </svg>
                <h3>Ошибка загрузки</h3>
                <p>${escapeHtml(message)}</p>
            </div>`;
    }
}

// ============================================================
// ОСНОВНОЙ МОДУЛЬ
// ============================================================

let scene = null, camera = null, renderer = null, controls = null, model = null, gridHelper = null;
let modelLoaded = false;
// Сохраняем функции очистки слушателей, чтобы снимать их при перезагрузке модели (устраняет утечки A5/A6)
let _cleanupResizeListener = null;
let _dblClickHandler = null;
let _pluginUI = null; // cleanup от PluginManager.initUI
let _sceneDirty = true; // флаг «сцена требует реендера» (сбрасывается в animate())

function markDirty() { _sceneDirty = true; }

function getUISettings() {
    return store.getState('ui.settings') || {};
}

function getModelColor() { return getUISettings().modelColor || null; }
function getMaterialSettings() {
    const s = getUISettings();
    return { metalness: s.modelMetalness !== undefined ? s.modelMetalness : 0.1, roughness: s.modelRoughness !== undefined ? s.modelRoughness : 0.75 };
}
function getEdgesEnabled() { const s = getUISettings(); return s.modelEdgesEnabled !== undefined ? s.modelEdgesEnabled : true; }

function applyModelColor(object, color) {
    const edgeColor = adjustEdgeColor(color, 0.10);
    const modelColor = new THREE.Color(color);
    const edgeColorObj = new THREE.Color(edgeColor);
    object.traverse(child => {
        if (child.isMesh && child.material) { child.material.color.copy(modelColor); child.material.dithering = true; }
        if (child.isLineSegments && child.material) child.material.color.copy(edgeColorObj);
    });
}

function showLoadingIndicator() {
    let loader = document.getElementById('model-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'model-loader';
        loader.innerHTML = `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:white;padding:20px;border-radius:8px;z-index:1000;text-align:center;min-width:200px"><div style="margin-bottom:10px">Загрузка модели...</div><div id="loader-progress" style="width:100%;height:4px;background:#333;border-radius:2px;overflow:hidden"><div id="loader-progress-bar" style="width:0%;height:100%;background:#4CAF50;transition:width 0.3s"></div></div><div id="loader-percent" style="margin-top:8px;font-size:14px">0%</div></div>`;
        document.body.appendChild(loader);
    }
}

function updateLoadingProgress(percent) {
    const bar = document.getElementById('loader-progress-bar');
    const text = document.getElementById('loader-percent');
    if (bar) bar.style.width = percent + '%';
    if (text) text.textContent = percent + '%';
}

function hideLoadingIndicator() {
    const loader = document.getElementById('model-loader');
    if (loader) { loader.style.opacity = '0'; setTimeout(() => { if (loader.parentNode) loader.remove(); }, 500); }
}

/**
 * Регистрируем API 3D-модуля для плагинов.
 * Плагины получают доступ к сцене, камере, модели через PluginManager.
 */
function _registerModuleAPI() {
    PluginManager.registerModuleAPI('3d-viewer', {
        get scene() { return scene; },
        get camera() { return camera; },
        get renderer() { return renderer; },
        get controls() { return controls; },
        get model() { return model; },
        get store() { return store; },
    });
}

function init() {
    const container = document.getElementById('model-container');
    if (!container) { console.error('Model container not found'); return; }

    const modelPath = getModelPath();
    if (!modelPath) { showErrorMessage('Путь к модели не указан. Проверьте данные проекта.'); return; }

    scene = new THREE.Scene();
    const canvas = document.getElementById('viewer');
    const setup = setupCamera(container, canvas);
    camera = setup.camera;
    renderer = setup.renderer;
    controls = setup.controls;
    controls.addEventListener('change', () => { _sceneDirty = true; });

    setupLights(scene);

    // Регистрируем API и создаём UI плагинов
    _registerModuleAPI();
    _pluginUI = PluginManager.initUI(container, '3d-viewer');

    loadModel(modelPath);
    animate();
}

function loadModel(modelPath) {
    showLoadingIndicator();
    new GLTFLoader().load(modelPath, gltf => {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.set(-center.x, -center.y, -center.z);
        scene.add(model);

        model.traverse(child => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
        addEdgesToObject(model);

        const modelColor = getModelColor();
        if (modelColor) applyModelColor(model, modelColor);

        const matSettings = getMaterialSettings();
        model.traverse(child => {
            if (child.isMesh && child.material) { child.material.metalness = matSettings.metalness; child.material.roughness = matSettings.roughness; child.material.dithering = true; }
        });

        if (!getEdgesEnabled()) model.traverse(child => { if (child.isLineSegments) child.visible = false; });

        createAdaptiveGrid(scene);
        gridHelper = scene.getObjectByName('adaptiveGrid');
        if (gridHelper) updateGridPosition(model, gridHelper);

        const size = box.getSize(new THREE.Vector3());
        const distance = Math.max(size.x, size.y, size.z) * 2;
        camera.position.set(distance, distance * 0.7, distance);
        camera.lookAt(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.update();

        handleWindowResize(camera, renderer, gridHelper, model, markDirty);
        // Снимаем старые слушатели перед установкой новых (фикс утечек A5/A6)
        if (_cleanupResizeListener) _cleanupResizeListener();
        _cleanupResizeListener = initResizeListener(camera, renderer, gridHelper, model, markDirty);

        const viewerEl = document.getElementById('viewer');
        if (_dblClickHandler && viewerEl) viewerEl.removeEventListener('dblclick', _dblClickHandler);
        _dblClickHandler = resetView;
        viewerEl.addEventListener('dblclick', _dblClickHandler);

        model.animations = gltf.animations;
        store.setState('model.object', model);
        store.setState('model.rawAnimations', gltf.animations);
        store.setState('model.isLoaded', true);
        store.setState('model.path', modelPath);
        modelLoaded = true;
        hideLoadingIndicator();

        window.dispatchEvent(new CustomEvent('modelLoaded', { detail: { model, scene, camera, controls, animations: gltf.animations } }));

        const projectId = store.getState('project.currentId');
        if (projectId) setTimeout(() => SpecificationService.saveModelStructure(model, projectId), 100);
    }, xhr => {
        // Защита от NaN/Infinity, если сервер не отдаёт Content-Length (xhr.total === 0)
        const percent = xhr.total ? Math.round(xhr.loaded / xhr.total * 100) : 0;
        updateLoadingProgress(percent);
    }, error => {
        console.error('Error loading model:', error);
        hideLoadingIndicator();
        showErrorMessage('Не удалось загрузить модель. Проверьте путь к файлу: ' + modelPath);
    });
}

function resetView() {
    if (!model || !camera || !controls) return;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const distance = Math.max(size.x, size.y, size.z) * 2;
    camera.position.set(distance, distance * 0.7, distance);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
    if (gridHelper) updateGridPosition(model, gridHelper);
    _sceneDirty = true;
}

function animate() {
    requestAnimationFrame(animate);
    if (document.hidden) return;
    const controlsUpdated = controls ? controls.update() : false;
    if (controlsUpdated) _sceneDirty = true;
    if (_sceneDirty) {
        if (gridHelper && camera) checkCameraOrientation(gridHelper, camera, GRID_OPACITY);
        if (camera && model) updateCameraLightPosition(camera, model);
        _sceneDirty = false;
    }
    if (renderer && scene && camera) renderer.render(scene, camera);
}

function waitForProjectData() {
    // Лимит попыток предотвращает бесконечный поллинг, если атрибут data-model-path
    // так и не появится на странице (фикс A9).
    if (document.getElementById('project-data')?.getAttribute('data-model-path')) {
        init();
    } else if (waitForProjectData._attempts < waitForProjectData._maxAttempts) {
        waitForProjectData._attempts++;
        setTimeout(waitForProjectData, 100);
    } else {
        console.warn('waitForProjectData: data-model-path не появился после ' +
            waitForProjectData._maxAttempts + ' попыток — инициализация отменена.');
        // Показываем пользователю, что 3D-модель не загрузится
        showErrorMessage('Не удалось определить путь к 3D-модели. ' +
            'Возможно, данные проекта не загрузились. Попробуйте обновить страницу.');
    }
}
waitForProjectData._attempts = 0;
waitForProjectData._maxAttempts = 50; // 50 × 100 мс = 5 секунд

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForProjectData);
else waitForProjectData();

// Хранилище интервала ожидания модели (фикс утечки A7: ранее каждый вызов
// onWindowResize запускал новый setInterval, и они накапливались).
let _resizeWaitInterval = null;

window.onWindowResize = function () {
    if (camera && renderer && gridHelper && model) {
        handleWindowResize(camera, renderer, gridHelper, model, markDirty);
    } else if (!_resizeWaitInterval) {
        // Запускаем только один поллинговый интервал; очищаем по готовности модели
        _resizeWaitInterval = setInterval(() => {
            if (camera && renderer && gridHelper && model) {
                clearInterval(_resizeWaitInterval);
                _resizeWaitInterval = null;
                handleWindowResize(camera, renderer, gridHelper, model, markDirty);
            }
        }, 200);
    }
};

// ============================================================
// ЭКСПОРТ
// ============================================================

export const ModelViewer = {
    init, getModel: () => model, getScene: () => scene, getCamera: () => camera,
    getControls: () => controls, isModelLoaded: () => modelLoaded, resetView
};

window.ModelViewer = ModelViewer;
export default ModelViewer;