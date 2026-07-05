/**
 * Плагин: Сечение модели (3D)
 *
 * Стенцированные сечения с cap-плоскостями по осям X/Y/Z.
 * Панель — компактная пилюля в один ряд (использует стили из model-cutting-panel.css).
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';

// ============================================================
// Состояние
// ============================================================

const cutRefs = { scene: null, model: null, renderer: null };
const cutObjects = {
    stencilGroups: [], capPlanes: [], capPlaneGroups: [],
    clippingPlanes: { x: null, y: null, z: null }
};
const originalMaterials = new WeakMap();
const materialCache = new Map();

const capOptions = {
    color: null,
    metalness: 0.1,
    roughness: 0.75,
    planeSize: 100,
    useModelColor: true
};

let _store = null;
let _boundSliderHandler = null;
let _boundAxisBtns = [];

// ============================================================
// Логика сечения
// ============================================================

function syncCapOptionsFromStore() {
    const s = _store?.getState('ui.settings');
    if (!s) return;
    if (s.modelMetalness !== undefined) capOptions.metalness = s.modelMetalness;
    if (s.modelRoughness !== undefined) capOptions.roughness = s.modelRoughness;
}

function computeModelBounds() {
    if (!cutRefs.model) return;
    const box = new THREE.Box3().setFromObject(cutRefs.model);
    const bounds = {}, initialValues = {};
    ['x', 'y', 'z'].forEach(axis => {
        bounds[axis] = { min: box.min[axis], max: box.max[axis] };
        initialValues[axis] = box.max[axis];
    });
    _store.setState('cutting3d.axisBounds', bounds);
    _store.setState('cutting3d.axisValues', initialValues);
    const size = new THREE.Vector3();
    box.getSize(size);
    capOptions.planeSize = Math.max(size.x, size.y, size.z) * 1.5;
}

function getModelBaseColor() {
    if (!cutRefs.model) return 0xCCCCCC;
    let baseColor = 0xCCCCCC;
    cutRefs.model.traverse(node => {
        if (node.isMesh && node.material && baseColor === 0xCCCCCC) {
            const mat = Array.isArray(node.material) ? node.material[0] : node.material;
            if (mat?.color) baseColor = mat.color.getHex();
        }
    });
    return baseColor;
}

function createPlaneStencilGroup(geometry, plane, renderOrder) {
    const group = new THREE.Group();
    const cacheKey = `stencil-${renderOrder}`;
    let baseMaterial = materialCache.get(cacheKey);
    if (!baseMaterial) {
        baseMaterial = new THREE.MeshBasicMaterial({
            depthWrite: false, depthTest: false, colorWrite: false,
            stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc
        });
        materialCache.set(cacheKey, baseMaterial);
    }
    const backMaterial = baseMaterial.clone();
    Object.assign(backMaterial, {
        side: THREE.BackSide, clippingPlanes: [plane],
        stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp
    });
    const frontMaterial = baseMaterial.clone();
    Object.assign(frontMaterial, {
        side: THREE.FrontSide, clippingPlanes: [plane],
        stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp
    });
    const backMesh = new THREE.Mesh(geometry, backMaterial);
    const frontMesh = new THREE.Mesh(geometry, frontMaterial);
    backMesh.renderOrder = frontMesh.renderOrder = renderOrder;
    group.add(backMesh, frontMesh);
    return group;
}

function createCapPlane(plane, renderOrder, otherPlanes) {
    const capColor = capOptions.useModelColor ? (capOptions.color || getModelBaseColor()) : (capOptions.color || 0xCCCCCC);
    const material = new THREE.MeshStandardMaterial({
        color: capColor, metalness: capOptions.metalness, roughness: capOptions.roughness,
        clippingPlanes: otherPlanes, stencilWrite: true, stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
        side: THREE.DoubleSide, dithering: true
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(capOptions.planeSize, capOptions.planeSize), material);
    mesh.renderOrder = renderOrder + 0.1;
    mesh.onAfterRender = () => { if (cutRefs.renderer) cutRefs.renderer.clearStencil(); };
    return mesh;
}

function updateCapPlanePosition(capPlane, plane) {
    if (!capPlane || !plane) return;
    plane.coplanarPoint(capPlane.position);
    capPlane.lookAt(capPlane.position.x - plane.normal.x, capPlane.position.y - plane.normal.y, capPlane.position.z - plane.normal.z);
}

function disposeGroup(group) {
    group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose());
        }
    });
}

function enableCutting() {
    if (!cutRefs.model || _store.getState('cutting3d.isActive')) return;
    _store.setState('cutting3d.isActive', true);
    const bounds = _store.getState('cutting3d.axisBounds');
    cutObjects.clippingPlanes = {
        x: new THREE.Plane(new THREE.Vector3(-1, 0, 0), bounds.x.max),
        y: new THREE.Plane(new THREE.Vector3(0, -1, 0), bounds.y.max),
        z: new THREE.Plane(new THREE.Vector3(0, 0, -1), bounds.z.max)
    };
    const worldGeometries = [];
    cutRefs.model.traverse(node => {
        if (!node.isMesh) return;
        if (!originalMaterials.has(node)) originalMaterials.set(node, node.material);
        const cloneMaterial = m => { if (!m) return m; const n = m.clone(); n.clippingPlanes = []; n.clipShadows = true; n.shadowSide = THREE.DoubleSide; n.dithering = true; return n; };
        node.material = Array.isArray(node.material) ? node.material.map(cloneMaterial) : cloneMaterial(node.material);
        if (node.geometry) {
            const wg = node.geometry.clone();
            node.updateWorldMatrix(true, false);
            wg.applyMatrix4(node.matrixWorld);
            worldGeometries.push(wg);
        }
    });
    const allPlanes = [cutObjects.clippingPlanes.x, cutObjects.clippingPlanes.y, cutObjects.clippingPlanes.z];
    ['x', 'y', 'z'].forEach((axis, index) => {
        const stencilGroup = new THREE.Group();
        stencilGroup.name = `stencil-${axis}`;
        worldGeometries.forEach(geom => stencilGroup.add(createPlaneStencilGroup(geom, allPlanes[index], index + 1)));
        cutRefs.scene.add(stencilGroup);
        cutObjects.stencilGroups.push(stencilGroup);
        const otherPlanes = allPlanes.filter((_, i) => i !== index);
        const capPlane = createCapPlane(allPlanes[index], index + 1, otherPlanes);
        capPlane.name = `cap-${axis}`;
        const capGroup = new THREE.Group();
        capGroup.add(capPlane);
        cutRefs.scene.add(capGroup);
        cutObjects.capPlanes.push(capPlane);
        cutObjects.capPlaneGroups.push(capGroup);
    });
    applyClippingPlanes();
}

function disableCutting() {
    if (!cutRefs.model || !_store.getState('cutting3d.isActive')) return;
    _store.setState('cutting3d.isActive', false);
    cutRefs.model.traverse(node => { if (originalMaterials.has(node)) node.material = originalMaterials.get(node); });
    [...cutObjects.stencilGroups, ...cutObjects.capPlaneGroups].forEach(group => { cutRefs.scene.remove(group); disposeGroup(group); });
    cutObjects.stencilGroups = []; cutObjects.capPlanes = []; cutObjects.capPlaneGroups = [];
    cutObjects.clippingPlanes = { x: null, y: null, z: null };
    _store.setState('cutting3d.activeAxis', null);
}

function applyClippingPlanes() {
    if (!cutRefs.model || !_store.getState('cutting3d.isActive')) return;
    const axisValues = _store.getState('cutting3d.axisValues');
    const invertedAxes = _store.getState('cutting3d.invertedAxes');
    const bounds = _store.getState('cutting3d.axisBounds');
    const activePlanes = [], activeAxes = [];
    ['x', 'y', 'z'].forEach(axis => {
        const plane = cutObjects.clippingPlanes[axis];
        if (!plane) return;
        const isActive = Math.abs(axisValues[axis] - bounds[axis].max) > 0.001;
        if (isActive) {
            const sign = invertedAxes[axis] ? 1 : -1;
            plane.normal.set(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
            plane.constant = invertedAxes[axis] ? -axisValues[axis] : axisValues[axis];
            activePlanes.push(plane);
            activeAxes.push(axis);
        }
    });
    cutRefs.model.traverse(node => {
        if (node.isMesh || node.isLine || node.isLineSegments || node.isLineLoop) {
            (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => {
                if (m) { m.clippingPlanes = activePlanes.slice(); m.clipShadows = true; m.needsUpdate = true; }
            });
        }
    });
    const allPlanes = [cutObjects.clippingPlanes.x, cutObjects.clippingPlanes.y, cutObjects.clippingPlanes.z];
    ['x', 'y', 'z'].forEach((axis, index) => {
        const capPlane = cutObjects.capPlanes[index];
        const stencilGroup = cutObjects.stencilGroups[index];
        if (!capPlane || !stencilGroup) return;
        const isActive = activeAxes.includes(axis);
        stencilGroup.visible = isActive;
        capPlane.visible = isActive;
        if (isActive) {
            updateCapPlanePosition(capPlane, allPlanes[index]);
            capPlane.material.clippingPlanes = activePlanes.filter((_, idx) => activeAxes[idx] !== axis);
            capPlane.material.needsUpdate = true;
        }
    });
}

function updateCapColor() {
    if (!_store.getState('cutting3d.isActive')) return;
    const newColor = capOptions.useModelColor ? getModelBaseColor() : (capOptions.color || 0xCCCCCC);
    cutObjects.capPlanes.forEach(p => { if (p.material) p.material.color.setHex(newColor); });
}

// ============================================================
// UI-помощники
// ============================================================

function updateAxisUI(axisBtns, invertBtn, slider) {
    const activeAxis = _store.getState('cutting3d.activeAxis');
    axisBtns.forEach(b => b.classList.toggle('active', b.dataset.axis === activeAxis));
    slider.disabled = false; invertBtn.disabled = false;
    invertBtn.classList.toggle('active', _store.getState('cutting3d.invertedAxes')[activeAxis]);
    updateSliderFromAxisValue(slider);
}

function updateSliderFromAxisValue(slider) {
    const axis = _store.getState('cutting3d.activeAxis');
    if (!axis) return;
    const bounds = _store.getState('cutting3d.axisBounds')[axis];
    const value = _store.getState('cutting3d.axisValues')[axis];
    const inverted = _store.getState('cutting3d.invertedAxes')[axis];
    const range = bounds.max - bounds.min;
    slider.value = range > 0
        ? Math.max(0, Math.min(1, inverted
            ? (value - bounds.min) / range
            : (bounds.max - value) / range))
        : 0;
}

function updateAxisValueFromSlider(percent) {
    const axis = _store.getState('cutting3d.activeAxis');
    if (!axis) return;
    const bounds = _store.getState('cutting3d.axisBounds')[axis];
    const inverted = _store.getState('cutting3d.invertedAxes')[axis];
    const value = inverted
        ? bounds.min + percent * (bounds.max - bounds.min)
        : bounds.max - percent * (bounds.max - bounds.min);
    _store.setState('cutting3d.axisValues', { ..._store.getState('cutting3d.axisValues'), [axis]: value });
}

function resetCutting(axisBtns, slider, invertBtn) {
    const bounds = _store.getState('cutting3d.axisBounds');
    ['x', 'y', 'z'].forEach(axis => {
        _store.setState('cutting3d.axisValues', { ..._store.getState('cutting3d.axisValues'), [axis]: bounds[axis].max });
    });
    _store.setState('cutting3d.invertedAxes', { x: false, y: false, z: false });
    invertBtn.classList.remove('active');
    _store.setState('cutting3d.activeAxis', null);
    axisBtns.forEach(b => b.classList.remove('active'));
    slider.disabled = true; invertBtn.disabled = true;
    applyClippingPlanes();
}

// ============================================================
// Регистрация плагина
// ============================================================

PluginManager.register({
    id: 'cutting-3d',
    name: 'Сечение',
    icon: 'slice-fill',
    module: '3d-viewer',

    /**
     * Кнопка плагина показывается только если модель уже загружена.
     * PluginManager переоценивает condition при каждом событии modelLoaded.
     */
    condition: (api) => !!(api && api.model && api.scene),

    init(api) {
        if (!api.scene || !api.model) return;

        _store = api.store;
        cutRefs.scene = api.scene;
        cutRefs.model = api.model;
        cutRefs.renderer = api.renderer;

        if (api.renderer) {
            api.renderer.localClippingEnabled = true;
            if (!api.renderer.capabilities.stencilBuffer) {
                console.warn('[cutting-3d] Renderer does not support stencil buffer.');
            }
        }

        syncCapOptionsFromStore();
        computeModelBounds();
        enableCutting();

        // Глобальная совместимость (используется в SettingsManager)
        window.ModelCut = { updateCapColor };
    },

    destroy() {
        disableCutting();
        window.ModelCut = null;
        _store = null;
    },

    panel: {
        /**
         * CSS-класс для тулбара — задаёт позицию и форму.
         * Использует стили из model-cutting-panel.css (.cutting-panel).
         */
        className: 'cutting-panel plugin-pill',

        /**
         * HTML панели — один ряд: оси | слайдер | действия
         */
        html: `
            <div class="cutting-axes plugin-pill-group">
                <button class="cutting-axis-btn plugin-pill-btn axis-x" data-axis="x">X</button>
                <button class="cutting-axis-btn plugin-pill-btn axis-y" data-axis="y">Y</button>
                <button class="cutting-axis-btn plugin-pill-btn axis-z" data-axis="z">Z</button>
            </div>
            <div class="cutting-slider-container">
                <input type="range" class="cutting-slider" min="0" max="1" step="0.01" value="0" disabled>
            </div>
            <div class="cutting-actions plugin-pill-group">
                <button class="cutting-invert-btn plugin-pill-btn" disabled>
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-right-arrow-left"></use></svg>
                </button>
                <button class="cutting-reset-btn plugin-pill-btn">
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-rotate-left"></use></svg>
                </button>
            </div>
        `,

        onMount(toolbar) {
            const axisBtns = toolbar.querySelectorAll('.cutting-axis-btn');
            const slider = toolbar.querySelector('.cutting-slider');
            const invertBtn = toolbar.querySelector('.cutting-invert-btn');
            const resetBtn = toolbar.querySelector('.cutting-reset-btn');

            // Кнопки осей
            axisBtns.forEach(btn => {
                const handler = () => {
                    if (!_store.getState('cutting3d.isActive')) return;
                    _store.setState('cutting3d.activeAxis', btn.dataset.axis);
                    updateAxisUI(axisBtns, invertBtn, slider);
                };
                btn.addEventListener('click', handler);
                _boundAxisBtns.push({ btn, handler });
            });

            // Слайдер
            _boundSliderHandler = (e) => {
                const axis = _store.getState('cutting3d.activeAxis');
                if (!axis || !_store.getState('cutting3d.isActive')) return;
                updateAxisValueFromSlider(parseFloat(e.target.value));
                applyClippingPlanes();
            };
            slider.addEventListener('input', _boundSliderHandler);

            // Инверсия
            const invertHandler = () => {
                const axis = _store.getState('cutting3d.activeAxis');
                if (!axis || !_store.getState('cutting3d.isActive')) return;
                const cur = _store.getState('cutting3d.invertedAxes');
                _store.setState('cutting3d.invertedAxes', { ...cur, [axis]: !cur[axis] });
                invertBtn.classList.toggle('active', _store.getState('cutting3d.invertedAxes')[axis]);
                updateSliderFromAxisValue(slider);
                applyClippingPlanes();
            };
            invertBtn.addEventListener('click', invertHandler);
            _boundAxisBtns.push({ btn: invertBtn, handler: invertHandler });

            // Сброс
            const resetHandler = () => resetCutting(axisBtns, slider, invertBtn);
            resetBtn.addEventListener('click', resetHandler);
            _boundAxisBtns.push({ btn: resetBtn, handler: resetHandler });

            // Если уже была выбрана ось — восстанавливаем UI
            if (_store.getState('cutting3d.activeAxis')) {
                updateAxisUI(axisBtns, invertBtn, slider);
            }
        },

        onUnmount() {
            // Proper cleanup: снимаем слушатели, которые сохраняли в onMount
            for (const { btn, handler } of _boundAxisBtns) {
                btn.removeEventListener('click', handler);
            }
            _boundAxisBtns = [];
            if (_boundSliderHandler) {
                const slider = document.querySelector('.cutting-slider');
                if (slider) slider.removeEventListener('input', _boundSliderHandler);
                _boundSliderHandler = null;
            }
        }
    }
});