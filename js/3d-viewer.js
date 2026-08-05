/**
 * 3D Viewer Module — рендеринг 3D сцены
 * Подмодули: engine.js | Плагины: cutting-3d, measure, animation, center-of-mass, transform-gizmo, camera-background
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { store, escapeHtml } from './app.js';
import { SpecificationService } from './specification.js';
import PluginManager from './plugin-system.js';
import {
    setupCamera, setupLights,
    handleWindowResize, initResizeListener
} from './engine.js';

// Плагины 3D-модуля (импорт регистрирует их в PluginManager)
import './plugins/cutting-3d.js';
import './plugins/measure.js';
import './plugins/animation.js';
import './plugins/center-of-mass.js';
import './plugins/transform-gizmo.js';
import './plugins/camera-background.js';
import './plugins/view-display.js';

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

let scene = null, camera = null, renderer = null, controls = null, model = null;
let modelLoaded = false;
let _cleanupResizeListener = null;
let _dblClickHandler = null;

// Рендер-цикл: activity-throttle — 60fps при работе с 3D, 15fps в простое,
// RAF отменяется при сворачивании вкладки. События слушаются на #model-container,
// чтобы скролл таблицы и клики по UI не держали 60fps.
const ACTIVE_FPS = 60, IDLE_FPS = 1;
const ACTIVE_MS = 1000 / ACTIVE_FPS, IDLE_MS = 1000 / IDLE_FPS;
const IDLE_DELAY = 2000;
const ACTIVITY_EVENTS = ['pointerdown','pointermove','pointerup','wheel','keydown','touchstart','touchmove'];

let _rafId = null;
let _lastFrame = 0;
let _lastActivity = 0;
let _visibilityHandler = null;
let _activityHandler = null;

function _attachActivity() {
    if (_activityHandler) return;
    const c = document.getElementById('model-container');
    if (!c) return;
    _activityHandler = () => { _lastActivity = performance.now(); };
    for (const evt of ACTIVITY_EVENTS) c.addEventListener(evt, _activityHandler, { passive: true });
}

function _detachActivity() {
    if (!_activityHandler) return;
    const c = document.getElementById('model-container');
    if (c) for (const evt of ACTIVITY_EVENTS) c.removeEventListener(evt, _activityHandler);
    _activityHandler = null;
}

function getUISettings() {
    return store.getState('ui.settings') || {};
}

function getModelColor() { return getUISettings().modelColor || null; }
function getMaterialSettings() {
    const s = getUISettings();
    return { metalness: s.modelMetalness !== undefined ? s.modelMetalness : 0.1, roughness: s.modelRoughness !== undefined ? s.modelRoughness : 0.75 };
}

function applyModelColor(object, color) {
    const modelColor = new THREE.Color(color);
    object.traverse(child => {
        if (child.isMesh && child.material) { child.material.color.copy(modelColor); child.material.dithering = true; }
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

    setupLights(scene);

    _registerModuleAPI();
    const _uiController = PluginManager.initUI(container, '3d-viewer');
    window._pluginUIController = _uiController;

    _startRenderLoop();
    _ensureFpsOverlay();

    loadModel(modelPath);
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

        const modelColor = getModelColor();
        if (modelColor) applyModelColor(model, modelColor);

        const matSettings = getMaterialSettings();
        model.traverse(child => {
            if (child.isMesh && child.material) { child.material.metalness = matSettings.metalness; child.material.roughness = matSettings.roughness; child.material.dithering = true; }
        });

        // Рёбра, сетка, тени — создаёт плагин view-display (при autoStart)

        _frameAll();

        handleWindowResize(camera, renderer);
        if (_cleanupResizeListener) _cleanupResizeListener();
        _cleanupResizeListener = initResizeListener(camera, renderer);

        const viewerEl = document.getElementById('viewer');
        if (_dblClickHandler && viewerEl) viewerEl.removeEventListener('dblclick', _dblClickHandler);
        _dblClickHandler = resetView;
        if (viewerEl) viewerEl.addEventListener('dblclick', _dblClickHandler);

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
    _frameAll();
}

function _frameAll() {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const distance = Math.max(size.x, size.y, size.z) * 1.5;
    camera.position.set(distance, distance * 0.7, distance);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
}

function animate(now) {
    _rafId = requestAnimationFrame(animate);

    const containerVisible = document.getElementById('model-container')?.classList.contains('active');
    const isIdle = !containerVisible || (now - _lastActivity) > IDLE_DELAY;
    const targetMs = isIdle ? IDLE_MS : ACTIVE_MS;

    if (now - _lastFrame < targetMs) return;
    _lastFrame = now;

    if (controls) controls.update();
    // Делегируем per-frame обновления активным плагинам
    PluginManager.frameUpdate(now);
    if (renderer && scene && camera) renderer.render(scene, camera);

    if (_fpsOverlay) _updateFpsOverlay(now, isIdle);
}

let _fpsOverlay = null;
let _fpsFrames = 0;
let _fpsLastTs = 0;
let _fpsDisplay = 0;

function _ensureFpsOverlay() {
    if (_fpsOverlay) return;
    const el = document.createElement('div');
    el.id = 'fps-overlay';
    el.style.cssText = 'position:fixed;top:6px;right:8px;z-index:99999;color:#00ff66;font:600 14px/1 monospace;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,0.55);pointer-events:none;letter-spacing:0.5px;min-width:24px;text-align:center';
    el.textContent = '–';
    document.body.appendChild(el);
    _fpsOverlay = el;
}

function _updateFpsOverlay(now, isIdle) {
    _fpsFrames++;
    if (!_fpsLastTs) _fpsLastTs = now;
    const elapsed = now - _fpsLastTs;
    if (elapsed >= 500) {
        _fpsDisplay = Math.round((_fpsFrames * 1000) / elapsed);
        _fpsFrames = 0; _fpsLastTs = now;
    }
    _fpsOverlay.style.color = isIdle ? '#ffcc00' : '#00ff66';
    _fpsOverlay.textContent = String(_fpsDisplay || '–');
}

function _resetFpsCounter() { _fpsFrames = 0; _fpsLastTs = 0; }

function _startRenderLoop() {
    _stopRenderLoop();
    _lastActivity = performance.now();
    _attachActivity();

    _visibilityHandler = () => {
        if (document.hidden) {
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
            _detachActivity();
        } else {
            _lastActivity = performance.now();
            _lastFrame = 0;
            _resetFpsCounter();
            _attachActivity();
            if (!_rafId) _rafId = requestAnimationFrame(animate);
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);

    _lastFrame = 0;
    _rafId = requestAnimationFrame(animate);
}

function _stopRenderLoop() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _detachActivity();
    if (_visibilityHandler) {
        document.removeEventListener('visibilitychange', _visibilityHandler);
        _visibilityHandler = null;
    }
}

function waitForProjectData() {
    if (document.getElementById('project-data')?.getAttribute('data-model-path')) {
        init();
    } else if (waitForProjectData._attempts < waitForProjectData._maxAttempts) {
        waitForProjectData._attempts++;
        setTimeout(waitForProjectData, 100);
    } else {
        console.warn('waitForProjectData: data-model-path не появился после ' +
            waitForProjectData._maxAttempts + ' попыток — инициализация отменена.');
        showErrorMessage('Не удалось определить путь к 3D-модели. ' +
            'Возможно, данные проекта не загрузились. Попробуйте обновить страницу.');
    }
}
waitForProjectData._attempts = 0;
waitForProjectData._maxAttempts = 50;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForProjectData);
else waitForProjectData();

window.onWindowResize = function () {
    if (camera && renderer) {
        handleWindowResize(camera, renderer);
    }
};

export const ModelViewer = {
    init, getModel: () => model, getScene: () => scene, getCamera: () => camera,
    getControls: () => controls, isModelLoaded: () => modelLoaded, resetView
};

window.ModelViewer = ModelViewer;
export default ModelViewer;
