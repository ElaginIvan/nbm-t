/**
 * Плагин: Вид — полный контроль отображения 3D-сцены
 *
 * Создаёт и управляет:
 * - Тени (DirectionalLight с shadowMap + ShadowMaterial плоскость, привязана к камере)
 * - Солнце (азимут + высота + плотность)
 * - Адаптивная сетка (GridHelper + оси, автоскрытие при виде сверху)
 * - Рёбра модели (EdgesGeometry + LineSegments)
 * - Цвет модели (HSV-пикер)
 *
 * Состояние тоглов и настройки солнца сохраняются в localStorage.
 * При деактивации — удаляет все созданные объекты со сцены.
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';

// ============================================================
// КОНСТАНТЫ
// ============================================================

const STORAGE_KEY = 'pluginViewDisplay';
const GRID_OPACITY = 0.5;

/** Состояние по умолчанию при первом запуске */
const DEFAULT_STATE = {
    shadowEnabled: true,
    gridVisible: true,
    edgesEnabled: true,
    shadowAzimuth: 45,
    shadowElevation: 50,
    shadowOpacity: 0.35,
};

// Границы слайдеров солнца
const AZIMUTH_MIN = 0, AZIMUTH_MAX = 360;
const ELEVATION_MIN = 5, ELEVATION_MAX = 89;
const OPACITY_MIN = 0, OPACITY_MAX = 1;

const PRESETS = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db'];

// ============================================================
// СОСТОЯНИЕ ПЛАГИНА
// ============================================================

let _api = null;
let _boundHandlers = [];
let _docHandlers = [];
let _cleanedUp = false;

// Тоглы
let _shadowEnabled = true;
let _gridVisible = true;
let _edgesEnabled = true;

// Настройки солнца
let _shadowAzimuth = DEFAULT_STATE.shadowAzimuth;
let _shadowElevation = DEFAULT_STATE.shadowElevation;
let _shadowOpacity = DEFAULT_STATE.shadowOpacity;

// Панель солнца
let _sunPanelEl = null;
let _sunPanelVisible = false;
let _sunOutsideClickHandler = null;

// Объекты на сцене
let _cameraLight = null;
let _gridHelper = null;
let _shadowPlane = null;

// Цвет модели (HSV-пикер)
let _hue = 0, _sat = 1, _val = 1;
let _colorPanelEl = null;
let _colorPanelVisible = false;
let _styleEl = null;
let _svActive = false;
let _hueActive = false;
let _outsideClickHandler = null;

// Металличность и шероховатость
let _metalness = 0.1, _roughness = 0.75;
let _metalnessActive = false, _roughnessActive = false;

// ============================================================
// localStorage
// ============================================================

function _loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.warn('[view-display] Ошибка чтения localStorage:', e);
        return null;
    }
}

function _saveState() {
    try {
        const rgb = hsvToRgb(_hue, _sat, _val);
        const modelColor = rgbToHex(rgb.r, rgb.g, rgb.b);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            shadowEnabled: _shadowEnabled,
            gridVisible: _gridVisible,
            edgesEnabled: _edgesEnabled,
            shadowAzimuth: _shadowAzimuth,
            shadowElevation: _shadowElevation,
            shadowOpacity: _shadowOpacity,
            modelColor,
            metalness: _metalness,
            roughness: _roughness
        }));
    } catch (e) {
        console.warn('[view-display] Ошибка записи localStorage:', e);
    }
}

// ============================================================
// HSV-конвертация
// ============================================================

function hsvToRgb(h, s, v) {
    let r, g, b;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0, s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return { h, s, v };
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ============================================================
// СОЗДАНИЕ: DirectionalLight (солнце)
// ============================================================

function _createCameraLight() {
    if (!_api || !_api.scene) return;
    _cameraLight = new THREE.DirectionalLight(0xffffff, 1.2);
    _cameraLight.castShadow = _shadowEnabled;
    _cameraLight.shadow.mapSize.width = 4096;
    _cameraLight.shadow.mapSize.height = 4096;
    _cameraLight.shadow.camera.near = 0.5;
    _cameraLight.shadow.camera.far = 200;
    _cameraLight.shadow.bias = 0;
    _cameraLight.shadow.normalBias = 0.02;
    _cameraLight.shadow.radius = 4;
    _api.scene.add(_cameraLight);
}

function _removeCameraLight() {
    if (_cameraLight && _api && _api.scene) {
        _api.scene.remove(_cameraLight);
        _cameraLight.dispose && _cameraLight.dispose();
    }
    _cameraLight = null;
}

// ============================================================
// ПОЗИЦИОНИРОВАНИЕ СОЛНЦА: азимут + высота (стабильная технология оригинала)
// ============================================================

function _updateSunPosition() {
    if (!_cameraLight || !_api.camera || !_api.model) return;

    const targetPos = new THREE.Vector3();
    _api.model.getWorldPosition(targetPos);
    const cameraPos = new THREE.Vector3();
    _api.camera.getWorldPosition(cameraPos);

    // Смещение света от камеры по азимуту/высоте (в локальном пространстве камеры)
    const az = THREE.MathUtils.degToRad(_shadowAzimuth);
    const el = THREE.MathUtils.degToRad(_shadowElevation);
    const dist = Math.max(cameraPos.distanceTo(targetPos) * 0.5, 8);

    const lightOffset = new THREE.Vector3(
        Math.cos(el) * Math.cos(az),
        Math.sin(el),
        Math.cos(el) * Math.sin(az)
    ).multiplyScalar(dist);

    // Поворачиваем смещение вместе с камерой (как в оригинале)
    lightOffset.applyQuaternion(_api.camera.quaternion.clone());

    _cameraLight.position.copy(cameraPos.clone().add(lightOffset));
    _cameraLight.lookAt(targetPos);

    // Frustum — фиксированный по размеру модели (как в оригинале)
    const box = new THREE.Box3().setFromObject(_api.model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const frustumSize = Math.max(maxDim * 0.4, 5);
    const shadowCam = _cameraLight.shadow.camera;
    shadowCam.left = -frustumSize;
    shadowCam.right = frustumSize;
    shadowCam.top = frustumSize;
    shadowCam.bottom = -frustumSize;
    shadowCam.updateProjectionMatrix();

    // Адаптивный bias: вблизи — 0 (тень плотная), вдалеке — -0.0004 (нет мерцания)
    const d = cameraPos.distanceTo(targetPos);
    const modelSize = size.length();
    const closeDist = modelSize * 2.5;
    const farDist = modelSize * 6;
    let bias;
    if (d <= closeDist) {
        bias = 0;
    } else if (d >= farDist) {
        bias = -0.0004;
    } else {
        bias = -0.0004 * ((d - closeDist) / (farDist - closeDist));
    }
    if (_cameraLight.shadow.bias !== bias) {
        _cameraLight.shadow.bias = bias;
    }
}

function _applyShadowOpacity() {
    if (!_shadowPlane || !_shadowPlane.material) return;
    _shadowPlane.material.opacity = _shadowOpacity;
}

// ============================================================
// СОЗДАНИЕ: Адаптивная сетка
// ============================================================

function _createGrid() {
    if (!_api || !_api.scene || !_api.model) return;

    const size = 100, divisions = 20;
    const mainGrid = new THREE.GridHelper(size, divisions, 0x888888, 0x444444);
    mainGrid.material.opacity = GRID_OPACITY;
    mainGrid.material.transparent = true;
    mainGrid.material.receiveShadow = false;

    const axisLength = size / 2, axisWidth = 0.3;
    const axesGroup = new THREE.Group();

    const planeX = new THREE.Mesh(
        new THREE.PlaneGeometry(axisLength * 2, axisWidth),
        new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: GRID_OPACITY, side: THREE.DoubleSide })
    );
    planeX.rotation.x = -Math.PI / 2;
    axesGroup.add(planeX);

    const planeZ = new THREE.Mesh(
        new THREE.PlaneGeometry(axisWidth, axisLength * 2),
        new THREE.MeshBasicMaterial({ color: 0x0000ff, transparent: true, opacity: GRID_OPACITY, side: THREE.DoubleSide })
    );
    planeZ.rotation.x = -Math.PI / 2;
    axesGroup.add(planeZ);

    axesGroup.position.y = 0.001;

    _gridHelper = new THREE.Group();
    _gridHelper.name = 'adaptiveGrid';
    _gridHelper.add(mainGrid);
    _gridHelper.add(axesGroup);
    _api.scene.add(_gridHelper);

    _positionGrid();
}

function _removeGrid() {
    if (_gridHelper && _api && _api.scene) {
        _api.scene.remove(_gridHelper);
        _gridHelper.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
    _gridHelper = null;
}

function _positionGrid() {
    if (!_gridHelper || !_api.model) return;
    const box = new THREE.Box3().setFromObject(_api.model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    _gridHelper.position.set(center.x, box.min.y - 0.01, center.z);
    const modelSize = Math.max(size.x, size.z);
    const gridScale = Math.max(modelSize * 1.5, 10);
    _gridHelper.scale.set(gridScale / 100, 1, gridScale / 100);
}

function _updateGridOrientation() {
    if (!_gridHelper || !_api.camera) return;
    const cameraDir = new THREE.Vector3();
    _api.camera.getWorldDirection(cameraDir);
    // Скрывать только при виде снизу вверх (как тень — back-face culling)
    _gridHelper.visible = _gridVisible && (cameraDir.y <= 0);
}

// ============================================================
// СОЗДАНИЕ: Тень на земле (ShadowMaterial плоскость)
// ============================================================

function _createShadowPlane() {
    if (!_api || !_api.model) return;

    const box = new THREE.Box3().setFromObject(_api.model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const planeSize = Math.max(maxDim * 4, 20);

    const planeGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    const planeMat = new THREE.ShadowMaterial({ opacity: 0.35, color: 0x000000 });
    planeMat.depthWrite = false;
    _shadowPlane = new THREE.Mesh(planeGeo, planeMat);
    _shadowPlane.rotation.x = -Math.PI / 2;
    _shadowPlane.position.set(
        box.getCenter(new THREE.Vector3()).x,
        box.min.y,
        box.getCenter(new THREE.Vector3()).z
    );
    _shadowPlane.receiveShadow = true;
    _shadowPlane.visible = _shadowEnabled;
    _api.scene.add(_shadowPlane);
}

function _removeShadowPlane() {
    if (_shadowPlane && _api && _api.scene) {
        _api.scene.remove(_shadowPlane);
        _shadowPlane.geometry.dispose();
        _shadowPlane.material.dispose();
    }
    _shadowPlane = null;
}

function _positionShadowPlane() {
    if (!_shadowPlane || !_api.model) return;
    const box = new THREE.Box3().setFromObject(_api.model);
    const center = box.getCenter(new THREE.Vector3());
    _shadowPlane.position.set(center.x, box.min.y, center.z);
}

// ============================================================
// СОЗДАНИЕ: Рёбра модели (EdgesGeometry + LineSegments)
// ============================================================

function _createEdges() {
    if (!_api || !_api.model) return;

    _api.model.traverse(child => {
        if (child.isMesh) {
            const edgesGeometry = new THREE.EdgesGeometry(child.geometry, 35);
            const edgesMaterial = new THREE.LineBasicMaterial({ color: 0x808080 });
            edgesMaterial.clippingPlanes = [];
            edgesMaterial.clipShadows = true;
            const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
            edges.matrix.copy(child.matrix);
            edges.matrixWorld.copy(child.matrixWorld);
            child.add(edges);
            child.userData.isHighlightable = true;
        }
    });

    _applyEdgesVisibility(_edgesEnabled);
    _applyEdgeColor();
}

function _removeEdges() {
    if (!_api || !_api.model) return;
    _api.model.traverse(child => {
        if (child.isMesh) {
            const toRemove = [];
            for (const sub of child.children) {
                if (sub.isLineSegments && !sub.userData.preserveEdges) toRemove.push(sub);
            }
            for (const edge of toRemove) {
                edge.geometry.dispose();
                edge.material.dispose();
                child.remove(edge);
            }
        }
    });
}

function _applyEdgesVisibility(enabled) {
    if (!_api || !_api.model) return;
    _api.model.traverse(child => {
        if (child.isLineSegments) child.visible = enabled;
    });
}

function _applyEdgeColor() {
    if (!_api || !_api.model) return;
    const settings = _api.store.getState('ui.settings') || {};
    const color = settings.modelColor || '#CCCCCC';
    const hsl = {};
    new THREE.Color(color).getHSL(hsl);
    hsl.l = hsl.l > 0.5 ? Math.max(0, hsl.l - 0.15) : Math.min(1, hsl.l + 0.15);
    _api.model.traverse(child => {
        if (child.isLineSegments && child.material) {
            child.material.color.setHSL(hsl.h, hsl.s, hsl.l);
        }
    });
}

// ============================================================
// ЦВЕТ МОДЕЛИ
// ============================================================

function _applyModelColor(hexColor) {
    if (!_api || !_api.model || !hexColor) return;
    const modelColor = new THREE.Color(hexColor);
    _api.model.traverse(child => {
        if (child.isMesh && child.material) child.material.color.copy(modelColor);
    });
    _applyEdgeColorFromHex(hexColor);
}

function _applyEdgeColorFromHex(hexColor) {
    if (!_api || !_api.model || !hexColor) return;
    const hsl = {};
    new THREE.Color(hexColor).getHSL(hsl);
    hsl.l = hsl.l > 0.5 ? Math.max(0, hsl.l - 0.15) : Math.min(1, hsl.l + 0.15);
    _api.model.traverse(child => {
        if (child.isLineSegments && child.material) {
            child.material.color.setHSL(hsl.h, hsl.s, hsl.l);
        }
    });
}

function _applyMetalness(value) {
    if (!_api || !_api.model) return;
    _api.model.traverse(child => {
        if (child.isMesh && child.material) {
            child.material.metalness = value;
        }
    });
}

function _applyRoughness(value) {
    if (!_api || !_api.model) return;
    _api.model.traverse(child => {
        if (child.isMesh && child.material) {
            child.material.roughness = value;
        }
    });
}

// ============================================================
// ТОГЛЫ
// ============================================================

function _toggleShadow() {
    _shadowEnabled = !_shadowEnabled;
    if (_cameraLight) _cameraLight.castShadow = _shadowEnabled;
    if (_shadowPlane) _shadowPlane.visible = _shadowEnabled;
    _updateShadowUI();
    _updateSunPanelUI();
    _saveState();
}

function _toggleSunPanel() {
    _sunPanelVisible ? _hideSunPanel() : _showSunPanel();
}

function _setShadowAzimuth(deg) {
    _shadowAzimuth = THREE.MathUtils.clamp(deg, AZIMUTH_MIN, AZIMUTH_MAX);
    _updateSunPosition();
    _updateSunPanelUI();
    _saveState();
}

function _setShadowElevation(deg) {
    _shadowElevation = THREE.MathUtils.clamp(deg, ELEVATION_MIN, ELEVATION_MAX);
    _updateSunPosition();
    _updateSunPanelUI();
    _saveState();
}

function _setShadowOpacity(val) {
    _shadowOpacity = THREE.MathUtils.clamp(val, OPACITY_MIN, OPACITY_MAX);
    _applyShadowOpacity();
    _updateSunPanelUI();
    _saveState();
}

function _toggleGrid() {
    _gridVisible = !_gridVisible;
    _updateGridUI();
    _saveState();
}

function _toggleEdges() {
    _edgesEnabled = !_edgesEnabled;
    _applyEdgesVisibility(_edgesEnabled);
    _updateEdgesUI();
    _saveState();
}

// ============================================================
// UI pill-bar
// ============================================================

function _updateShadowUI() {
    const btn = document.getElementById('vd-shadow-btn');
    if (btn) btn.classList.toggle('active', _shadowEnabled);
}

function _updateGridUI() {
    const btn = document.getElementById('vd-grid-btn');
    if (btn) btn.classList.toggle('active', _gridVisible);
}

function _updateEdgesUI() {
    const btn = document.getElementById('vd-edges-btn');
    if (btn) btn.classList.toggle('active', _edgesEnabled);
}

function _updateSwatch(hex) {
    const sw = document.getElementById('vd-color-swatch');
    if (sw) sw.style.background = hex;
}

function _updateMRUI() {
    const metalnessHandle = document.getElementById('vd-metalness-handle');
    const roughnessHandle = document.getElementById('vd-roughness-handle');
    if (metalnessHandle) metalnessHandle.style.top = (_metalness * 100) + '%';
    if (roughnessHandle) roughnessHandle.style.top = (_roughness * 100) + '%';
}

// ============================================================
// UI: панель «Солнце» (toggle, click outside)
// ============================================================

function _createSunPanel() {
    if (_sunPanelEl) return;

    _injectStyles();

    const el = document.createElement('div');
    el.className = 'vd-sun-panel';
    el.innerHTML = `
        <div class="vd-sun-slider-group">
            <label class="vd-sun-label">Азимут</label>
            <input type="range" id="vd-sun-azimuth" class="vd-sun-slider" min="${AZIMUTH_MIN}" max="${AZIMUTH_MAX}" step="1" value="${_shadowAzimuth}">
            <span class="vd-sun-value" id="vd-sun-azimuth-value">${Math.round(_shadowAzimuth)}°</span>
        </div>
        <div class="vd-sun-slider-group">
            <label class="vd-sun-label">Высота</label>
            <input type="range" id="vd-sun-elevation" class="vd-sun-slider" min="${ELEVATION_MIN}" max="${ELEVATION_MAX}" step="1" value="${_shadowElevation}">
            <span class="vd-sun-value" id="vd-sun-elevation-value">${Math.round(_shadowElevation)}°</span>
        </div>
        <div class="vd-sun-slider-group">
            <label class="vd-sun-label">Плотность</label>
            <input type="range" id="vd-sun-opacity" class="vd-sun-slider" min="0" max="1" step="0.05" value="${_shadowOpacity}">
            <span class="vd-sun-value" id="vd-sun-opacity-value">${Math.round(_shadowOpacity * 100)}%</span>
        </div>
    `;
    const container = document.querySelector('.plugin-panels') || document.getElementById('model-container');
    if (container) container.appendChild(el);
    _sunPanelEl = el;

    // Слайдеры
    const azSlider = el.querySelector('#vd-sun-azimuth');
    if (azSlider) {
        const h = () => _setShadowAzimuth(parseFloat(azSlider.value));
        azSlider.addEventListener('input', h);
        _boundHandlers.push({ el: azSlider, type: 'input', handler: h });
    }
    const elSlider = el.querySelector('#vd-sun-elevation');
    if (elSlider) {
        const h = () => _setShadowElevation(parseFloat(elSlider.value));
        elSlider.addEventListener('input', h);
        _boundHandlers.push({ el: elSlider, type: 'input', handler: h });
    }
    const opSlider = el.querySelector('#vd-sun-opacity');
    if (opSlider) {
        const h = () => _setShadowOpacity(parseFloat(opSlider.value));
        opSlider.addEventListener('input', h);
        _boundHandlers.push({ el: opSlider, type: 'input', handler: h });
    }
}

function _showSunPanel() {
    _createSunPanel();
    _sunPanelVisible = true;
    _sunPanelEl.classList.add('visible');
    _updateSunPosition();
    _updateSunBtnUI();
    _updateSunPanelUI();

    // Закрытие тапом вне зоны (как у панели цвета)
    _sunOutsideClickHandler = e => {
        if (!_sunPanelEl.contains(e.target) &&
            !document.getElementById('vd-sun-btn')?.contains(e.target)) {
            _hideSunPanel();
        }
    };
    setTimeout(() => _addDocHandler('pointerdown', _sunOutsideClickHandler), 0);
}

function _hideSunPanel() {
    if (!_sunPanelEl) return;
    _sunPanelVisible = false;
    _sunPanelEl.classList.remove('visible');
    _updateSunBtnUI();

    if (_sunOutsideClickHandler) {
        _docHandlers = _docHandlers.filter(h => h.handler !== _sunOutsideClickHandler);
        document.removeEventListener('pointerdown', _sunOutsideClickHandler);
        _sunOutsideClickHandler = null;
    }
}

function _updateSunBtnUI() {
    const btn = document.getElementById('vd-sun-btn');
    if (!btn) return;
    btn.classList.toggle('panel-open', _sunPanelVisible);
}

function _updateSunPanelUI() {
    const azSlider = document.getElementById('vd-sun-azimuth');
    const azLabel = document.getElementById('vd-sun-azimuth-value');
    const elSlider = document.getElementById('vd-sun-elevation');
    const elLabel = document.getElementById('vd-sun-elevation-value');
    const opSlider = document.getElementById('vd-sun-opacity');
    const opLabel = document.getElementById('vd-sun-opacity-value');

    if (azSlider) azSlider.value = String(_shadowAzimuth);
    if (azLabel) azLabel.textContent = Math.round(_shadowAzimuth) + '°';
    if (elSlider) elSlider.value = String(_shadowElevation);
    if (elLabel) elLabel.textContent = Math.round(_shadowElevation) + '°';
    if (opSlider) opSlider.value = String(_shadowOpacity);
    if (opLabel) opLabel.textContent = Math.round(_shadowOpacity * 100) + '%';
}

// ============================================================
// onFrame
// ============================================================

function _onFrame() {
    if (_shadowEnabled) _updateSunPosition();
    _updateGridOrientation();
    _positionShadowPlane();
}

// ============================================================
// HSV-пикер UI
// ============================================================

function _updateColorUI() {
    const hueHandle = document.getElementById('vd-hue-handle');
    const svHandle = document.getElementById('vd-sv-handle');
    const svSquare = document.getElementById('vd-sv-square');
    if (hueHandle) hueHandle.style.top = (_hue * 100) + '%';
    const pure = hsvToRgb(_hue, 1, 1);
    if (svSquare) svSquare.style.background = `rgb(${pure.r},${pure.g},${pure.b})`;
    if (svHandle) {
        svHandle.style.left = (_sat * 100) + '%';
        svHandle.style.top = ((1 - _val) * 100) + '%';
    }
}

function _applyColor() {
    const rgb = hsvToRgb(_hue, _sat, _val);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    _applyModelColor(hex);
    _updateSwatch(hex);
    _saveState();
    if (_api && _api.renderer && _api.scene && _api.camera) {
        _api.renderer.render(_api.scene, _api.camera);
    }
}

// ============================================================
// Стили (цвет + солнце)
// ============================================================

function _injectStyles() {
    if (_styleEl) return;
    _styleEl = document.createElement('style');
    _styleEl.textContent = `
.vd-color-panel {
    position: absolute;
    bottom: calc(100% + 50px);
    left: 50%;
    width: 260px;
    max-width: 80vw;
    padding: 10px;
    transform-origin: center bottom;
    background: var(--button-color);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(128, 128, 128, 0.15);
    border-radius: 20px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
    touch-action: none;
    user-select: none;
    z-index: 9998;
    opacity: 0;
    transform: translateX(-50%) scale(0.85) translateY(10px);
    pointer-events: none;
    transition: opacity 0.25s ease, transform 0.25s ease;
}
.vd-color-panel.visible {
    opacity: 1;
    transform: translateX(-50%) scale(1) translateY(0);
    pointer-events: auto;
}
.vd-panel-body { display: flex; gap: 8px; align-items: stretch; }
.vd-presets {
    display: flex;
    flex-direction: column;
    gap: 6px;
    justify-content: space-around;
    align-items: center;
}
.vd-preset {
    width: 26px; height: 26px;
    border-radius: 50%;
    border: 2px solid var(--border-color, rgba(128, 128, 128, 0.25));
    cursor: pointer;
    transition: transform 0.15s;
    flex-shrink: 0;
}
.vd-preset:active { transform: scale(0.9); }
.vd-hue-slider {
    width: 22px;
    flex-shrink: 0;
    border-radius: 11px;
    background: linear-gradient(to bottom,
        hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%),
        hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%));
    position: relative;
    cursor: pointer;
    touch-action: none;
}
.vd-hue-handle {
    position: absolute;
    left: 50%;
    width: 28px; height: 8px;
    border-radius: 4px;
    background: #fff;
    border: 2px solid rgba(0,0,0,0.3);
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    transform: translate(-50%, -50%);
    pointer-events: none;
}
.vd-sv-square {
    flex: 1;
    aspect-ratio: 1;
    border-radius: 12px;
    position: relative;
    cursor: crosshair;
    overflow: hidden;
    touch-action: none;
}
.vd-sv-square::before {
    content: '';
    position: absolute; inset: 0;
    background: linear-gradient(to right, #fff, transparent);
    border-radius: 12px;
}
.vd-sv-square::after {
    content: '';
    position: absolute; inset: 0;
    background: linear-gradient(to bottom, transparent, #000);
    border-radius: 12px;
}
.vd-sv-handle {
    position: absolute;
    width: 22px; height: 22px;
    border-radius: 50%;
    border: 3px solid #fff;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.5);
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 2;
}
.vd-color-swatch {
    display: block;
    width: 22px; height: 22px;
    border-radius: 50%;
    border: 2px solid var(--border-color, rgba(128, 128, 128, 0.25));
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15);
    background: #cccccc;
}

/* === Вертикальные слайдеры металличности/шероховатости === */
.vd-mr-slider {
    width: 20px;
    flex-shrink: 0;
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    touch-action: none;
    border: 1px solid rgba(128, 128, 128, 0.15);
}
.vd-metalness-track {
    background: linear-gradient(to bottom, #a0a0a0, #d0d8e8);
}
.vd-roughness-track {
    background: linear-gradient(to bottom, #e0e0e0, #606060);
}
.vd-mr-handle {
    position: absolute;
    left: 50%;
    width: 26px; height: 8px;
    border-radius: 4px;
    background: #fff;
    border: 2px solid rgba(0,0,0,0.3);
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    transform: translate(-50%, -50%);
    pointer-events: none;
}

/* === Панель «Солнце» === */
.vd-sun-panel {
    position: absolute;
    bottom: calc(100% + 50px);
    left: 50%;
    transform: translateX(-50%) scale(0.9);
    transform-origin: center bottom;
    background: var(--button-color);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(128, 128, 128, 0.15);
    border-radius: 16px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 220px;
    max-width: 86vw;
    user-select: none;
    -webkit-user-select: none;
    z-index: 9997;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s;
}
.vd-sun-panel.visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transform: translateX(-50%) scale(1);
}
.vd-sun-slider-group {
    display: grid;
    grid-template-columns: 56px 1fr 44px;
    align-items: center;
    gap: 8px;
}
.vd-sun-label {
    font-size: 11px;
    color: var(--text-color);
    opacity: 0.75;
    font-weight: 500;
    user-select: none;
    -webkit-user-select: none;
}
.vd-sun-value {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-color);
    text-align: right;
    font-variant-numeric: tabular-nums;
    opacity: 0.9;
}
.vd-sun-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.15);
    outline: none;
    cursor: pointer;
}
.vd-sun-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #ffd060;
    border: 2px solid rgba(255, 255, 255, 0.7);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    transition: transform 0.15s;
}
.vd-sun-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
.vd-sun-slider::-webkit-slider-thumb:active { transform: scale(0.95); }
.vd-sun-slider::-moz-range-thumb {
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #ffd060;
    border: 2px solid rgba(255, 255, 255, 0.7);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
    cursor: pointer;
}
#vd-sun-btn.panel-open {
    background: rgba(255, 208, 96, 0.25);
    border-color: rgba(255, 208, 96, 0.6);
    box-shadow: 0 2px 8px rgba(255, 208, 96, 0.25);
}
#vd-sun-btn.panel-open svg { fill: #ffd060; }
@media (max-width: 768px) {
    .vd-sun-panel { min-width: 200px; padding: 8px 10px; gap: 6px; }
    .vd-sun-slider-group { grid-template-columns: 50px 1fr 40px; gap: 6px; }
}
`;
    document.head.appendChild(_styleEl);
}

function _addDocHandler(type, handler, opts) {
    document.addEventListener(type, handler, opts);
    _docHandlers.push({ type, handler });
}

function _removeDocHandlers() {
    for (const { type, handler } of _docHandlers) {
        document.removeEventListener(type, handler);
    }
    _docHandlers = [];
}

// ============================================================
// Панель цвета (HSV-пикер)
// ============================================================

function _createColorPanel() {
    if (_colorPanelEl) return;

    _injectStyles();

    const el = document.createElement('div');
    el.className = 'vd-color-panel';
    el.innerHTML = `
        <div class="vd-panel-body">
            <div class="vd-presets" id="vd-presets"></div>
            <div class="vd-sv-square" id="vd-sv-square">
                <div class="vd-sv-handle" id="vd-sv-handle"></div>
            </div>
            <div class="vd-hue-slider" id="vd-hue-slider">
                <div class="vd-hue-handle" id="vd-hue-handle"></div>
            </div>
            <div class="vd-mr-slider vd-metalness-track" id="vd-metalness-slider" title="Металличность">
                <div class="vd-mr-handle" id="vd-metalness-handle"></div>
            </div>
            <div class="vd-mr-slider vd-roughness-track" id="vd-roughness-slider" title="Шероховатость">
                <div class="vd-mr-handle" id="vd-roughness-handle"></div>
            </div>
        </div>
    `;
    const panels = document.querySelector('.plugin-panels');
    (panels || document.getElementById('model-container')).appendChild(el);
    _colorPanelEl = el;

    // Пресеты
    const presetsEl = el.querySelector('#vd-presets');
    PRESETS.forEach(c => {
        const preset = document.createElement('div');
        preset.className = 'vd-preset';
        preset.style.background = c;
        preset.addEventListener('click', () => {
            const rgb = hexToRgb(c);
            const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
            _hue = hsv.h; _sat = hsv.s; _val = hsv.v;
            _updateColorUI();
            _applyColor();
        });
        presetsEl.appendChild(preset);
    });

    // SV-взаимодействие
    const svSquare = el.querySelector('#vd-sv-square');

    function onSV(e) {
        if (!_svActive) return;
        const rect = svSquare.getBoundingClientRect();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        _sat = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
        _val = 1 - Math.max(0, Math.min(1, (cy - rect.top) / rect.height));
        _updateColorUI();
        _applyColor();
    }

    svSquare.addEventListener('mousedown', e => { _svActive = true; onSV(e); });
    svSquare.addEventListener('touchstart', e => { _svActive = true; onSV(e); e.preventDefault(); }, { passive: false });

    _addDocHandler('mousemove', onSV);
    _addDocHandler('touchmove', e => { if (_svActive) { onSV(e); e.preventDefault(); } }, { passive: false });
    _addDocHandler('mouseup', () => { _svActive = false; });
    _addDocHandler('touchend', () => { _svActive = false; });

    // Hue-взаимодействие
    const hueSlider = el.querySelector('#vd-hue-slider');

    function onHue(e) {
        if (!_hueActive) return;
        const rect = hueSlider.getBoundingClientRect();
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        _hue = Math.max(0, Math.min(1, (cy - rect.top) / rect.height));
        _updateColorUI();
        _applyColor();
    }

    hueSlider.addEventListener('mousedown', e => { _hueActive = true; onHue(e); });
    hueSlider.addEventListener('touchstart', e => { _hueActive = true; onHue(e); e.preventDefault(); }, { passive: false });

    _addDocHandler('mousemove', onHue);
    _addDocHandler('touchmove', e => { if (_hueActive) { onHue(e); e.preventDefault(); } }, { passive: false });
    _addDocHandler('mouseup', () => { _hueActive = false; });
    _addDocHandler('touchend', () => { _hueActive = false; });

    // Metalness-взаимодействие
    const metalnessSlider = el.querySelector('#vd-metalness-slider');

    function onMetalness(e) {
        if (!_metalnessActive) return;
        const rect = metalnessSlider.getBoundingClientRect();
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        _metalness = Math.max(0, Math.min(1, (cy - rect.top) / rect.height));
        _updateMRUI();
        _applyMetalness(_metalness);
        _saveState();
    }

    metalnessSlider.addEventListener('mousedown', e => { _metalnessActive = true; onMetalness(e); });
    metalnessSlider.addEventListener('touchstart', e => { _metalnessActive = true; onMetalness(e); e.preventDefault(); }, { passive: false });

    _addDocHandler('mousemove', onMetalness);
    _addDocHandler('touchmove', e => { if (_metalnessActive) { onMetalness(e); e.preventDefault(); } }, { passive: false });
    _addDocHandler('mouseup', () => { _metalnessActive = false; });
    _addDocHandler('touchend', () => { _metalnessActive = false; });

    // Roughness-взаимодействие
    const roughnessSlider = el.querySelector('#vd-roughness-slider');

    function onRoughness(e) {
        if (!_roughnessActive) return;
        const rect = roughnessSlider.getBoundingClientRect();
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        _roughness = Math.max(0, Math.min(1, (cy - rect.top) / rect.height));
        _updateMRUI();
        _applyRoughness(_roughness);
        _saveState();
    }

    roughnessSlider.addEventListener('mousedown', e => { _roughnessActive = true; onRoughness(e); });
    roughnessSlider.addEventListener('touchstart', e => { _roughnessActive = true; onRoughness(e); e.preventDefault(); }, { passive: false });

    _addDocHandler('mousemove', onRoughness);
    _addDocHandler('touchmove', e => { if (_roughnessActive) { onRoughness(e); e.preventDefault(); } }, { passive: false });
    _addDocHandler('mouseup', () => { _roughnessActive = false; });
    _addDocHandler('touchend', () => { _roughnessActive = false; });
}

function _showColorPanel() {
    _createColorPanel();
    _colorPanelVisible = true;
    _colorPanelEl.classList.add('visible');
    _updateColorUI();
    _updateMRUI();

    _outsideClickHandler = e => {
        if (!_colorPanelEl.contains(e.target) &&
            !document.getElementById('vd-color-btn')?.contains(e.target)) {
            _hideColorPanel();
        }
    };
    setTimeout(() => _addDocHandler('pointerdown', _outsideClickHandler), 0);
}

function _hideColorPanel() {
    if (!_colorPanelEl) return;
    _colorPanelVisible = false;
    _svActive = false;
    _hueActive = false;
    _metalnessActive = false;
    _roughnessActive = false;
    _colorPanelEl.classList.remove('visible');
    if (_outsideClickHandler) {
        _docHandlers = _docHandlers.filter(h => h.handler !== _outsideClickHandler);
        document.removeEventListener('pointerdown', _outsideClickHandler);
        _outsideClickHandler = null;
    }
}

function _toggleColorPanel() {
    _colorPanelVisible ? _hideColorPanel() : _showColorPanel();
}

// ============================================================
// ИНИЦИАЛИЗАЦИЯ / ОЧИСТКА
// ============================================================

function _init(api) {
    _api = api;
    _cleanedUp = false;
    _boundHandlers = [];
    _docHandlers = [];

    // 1. Загружаем сохранённое состояние
    const saved = _loadState();
    if (saved) {
        _shadowEnabled = typeof saved.shadowEnabled === 'boolean' ? saved.shadowEnabled : DEFAULT_STATE.shadowEnabled;
        _gridVisible = typeof saved.gridVisible === 'boolean' ? saved.gridVisible : DEFAULT_STATE.gridVisible;
        _edgesEnabled = typeof saved.edgesEnabled === 'boolean' ? saved.edgesEnabled : DEFAULT_STATE.edgesEnabled;
        _shadowAzimuth = typeof saved.shadowAzimuth === 'number'
            ? THREE.MathUtils.clamp(saved.shadowAzimuth, AZIMUTH_MIN, AZIMUTH_MAX)
            : DEFAULT_STATE.shadowAzimuth;
        _shadowElevation = typeof saved.shadowElevation === 'number'
            ? THREE.MathUtils.clamp(saved.shadowElevation, ELEVATION_MIN, ELEVATION_MAX)
            : DEFAULT_STATE.shadowElevation;
        _shadowOpacity = typeof saved.shadowOpacity === 'number'
            ? THREE.MathUtils.clamp(saved.shadowOpacity, OPACITY_MIN, OPACITY_MAX)
            : DEFAULT_STATE.shadowOpacity;
    } else {
        _shadowEnabled = DEFAULT_STATE.shadowEnabled;
        _gridVisible = DEFAULT_STATE.gridVisible;
        _edgesEnabled = DEFAULT_STATE.edgesEnabled;
        _shadowAzimuth = DEFAULT_STATE.shadowAzimuth;
        _shadowElevation = DEFAULT_STATE.shadowElevation;
        _shadowOpacity = DEFAULT_STATE.shadowOpacity;
    }

    // 2. Создаём объекты на сцене
    _createCameraLight();
    _createShadowPlane();
    _createGrid();
    _createEdges();

    // 3. Применяем настройки
    _applyShadowOpacity();
    _updateSunPosition();

    // 4. CSS для pill-bar
    _injectStyles();

    // 5. Начальный цвет
    const pluginColor = saved?.modelColor;
    const settingsColor = api.store.getState('ui.settings')?.modelColor;
    const currentColor = pluginColor || settingsColor || '#cccccc';
    const rgb = hexToRgb(currentColor);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    _hue = hsv.h; _sat = hsv.s; _val = hsv.v;
    _applyModelColor(currentColor);

    // 6. Металличность и шероховатость
    const uiSettings = api.store.getState('ui.settings') || {};
    _metalness = (saved?.metalness !== undefined) ? saved.metalness
        : (uiSettings.modelMetalness !== undefined ? uiSettings.modelMetalness : 0.1);
    _roughness = (saved?.roughness !== undefined) ? saved.roughness
        : (uiSettings.modelRoughness !== undefined ? uiSettings.modelRoughness : 0.75);
    _applyMetalness(_metalness);
    _applyRoughness(_roughness);
}

function _cleanup() {
    if (_cleanedUp) return;
    _cleanedUp = true;

    _removeCameraLight();
    _removeShadowPlane();
    _removeGrid();
    _removeEdges();

    _hideSunPanel();
    if (_sunPanelEl) { _sunPanelEl.remove(); _sunPanelEl = null; }

    _hideColorPanel();
    if (_colorPanelEl) { _colorPanelEl.remove(); _colorPanelEl = null; }
    _removeDocHandlers();
    if (_styleEl) { _styleEl.remove(); _styleEl = null; }

    for (const { el, type, handler } of _boundHandlers) {
        el.removeEventListener(type, handler);
    }
    _boundHandlers = [];
    _api = null;
}

// ============================================================
// РЕГИСТРАЦИЯ ПЛАГИНА
// ============================================================

PluginManager.register({
    id: 'view-display',
    name: 'Вид',
    icon: 'image',
    module: '3d-viewer',

    meta: {
        autoStart: true,
        description: 'Тени, солнце, сетка, рёбра, цвет модели',
        category: 'display'
    },

    condition: (api) => !!(api && api.model && api.scene),

    init(api) {
        _init(api);
        return () => _cleanup();
    },

    destroy() {
        _cleanup();
    },

    onFrame() {
        if (_cleanedUp || !_api) return;
        _onFrame();
    },

    panel: {
        className: 'vd-panel plugin-pill',

        html: `
            <div class="cam-group plugin-pill-group">
                <button class="cam-btn plugin-pill-btn" id="vd-shadow-btn" title="Тени">
                    <svg><use xlink:href="assets/icons/sprite.svg#shadow-line"></use></svg>
                </button>
                <button class="cam-btn plugin-pill-btn" id="vd-sun-btn" title="Солнце">
                    <svg><use xlink:href="assets/icons/sprite.svg#sun"></use></svg>
                </button>
                <button class="cam-btn plugin-pill-btn" id="vd-grid-btn" title="Сетка">
                    <svg><use xlink:href="assets/icons/sprite.svg#grid-line"></use></svg>
                </button>
                <button class="cam-btn plugin-pill-btn" id="vd-edges-btn" title="Рёбра">
                    <svg><use xlink:href="assets/icons/sprite.svg#edges-line"></use></svg>
                </button>
            </div>
            <div class="cam-pill-divider plugin-pill-divider"></div>
            <button class="cam-btn plugin-pill-btn" id="vd-color-btn" title="Цвет модели">
                <span class="vd-color-swatch" id="vd-color-swatch"></span>
            </button>

        `,

        onMount() {
            const bind = (id, type, handler) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.addEventListener(type, handler);
                _boundHandlers.push({ el, type, handler });
            };

            bind('vd-shadow-btn', 'click', _toggleShadow);
            bind('vd-sun-btn', 'click', _toggleSunPanel);
            bind('vd-grid-btn', 'click', _toggleGrid);
            bind('vd-edges-btn', 'click', _toggleEdges);
            bind('vd-color-btn', 'click', _toggleColorPanel);

            // Начальное состояние UI
            const rgb = hsvToRgb(_hue, _sat, _val);
            _updateSwatch(rgbToHex(rgb.r, rgb.g, rgb.b));
            _updateShadowUI();
            _updateGridUI();
            _updateEdgesUI();
            _updateSunBtnUI();
            _updateSunPanelUI();
        },

        onUnmount() {
            _cleanup();
        }
    }
});
