/**
 * Плагин: Сечение модели (3D) — Drag-версия
 *
 * Секущая плоскость управляется прямым перетаскиванием на модели,
 * а не ползунком. При выборе оси (X/Y/Z) появляется полупрозрачная
 * цветная плоскость, которую можно двигать мышкой или пальцем.
 *
 * Сохранена вся логика stencil-сечений и cap-плоскостей из оригинала.
 * Изменён только UI и способ управления позицией сечения.
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';

// ============================================================
// КОНСТАНТЫ
// ============================================================

const AXIS_COLORS = {
    x: 0xff4444,
    y: 0x44ff44,
    z: 0x4488ff
};

const PLANE_OPACITY = 0.13;
const PLANE_HOVER_OPACITY = 0.22;
const PLANE_DRAG_OPACITY = 0.22;
const PLANE_EDGE_OPACITY = 0.55;

// ============================================================
// СОСТОЯНИЕ СЕЧЕНИЯ (stencil, cap, clipping)
// ============================================================

const cutRefs = { scene: null, model: null, renderer: null, camera: null, controls: null };
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
let _boundUIHandlers = [];

// Включённые оси (может быть несколько одновременно)
const enabledAxes = { x: false, y: false, z: false };

// ============================================================
// DRAG STATE
// ============================================================

const drag = {
    isDragging: false,
    axis: null,
    planeGroup: null,   // THREE.Group: mesh + edges
    planeMesh: null,    // Полупрозрачная плоскость
    planeEdges: null,   // Рамка плоскости
    isVisible: true,

    // Механика перетаскивания
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    helperPlane: null,  // THREE.Plane — невидимая плоскость для проекции
    startAxisValue: 0,

    // Ссылки на обработчики для cleanup
    _ptrDown: null,
    _ptrMove: null,
    _ptrUp: null,
};

// ============================================================
// ЛОГИКА СЕЧЕНИЯ — stencil, cap, clipping (без изменений)
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
        initialValues[axis] = (box.min[axis] + box.max[axis]) / 2;
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
    const activePlanes = [];

    // Применяем сечение для всех включённых осей
    ['x', 'y', 'z'].forEach(axis => {
        if (!enabledAxes[axis]) return;
        const plane = cutObjects.clippingPlanes[axis];
        if (!plane) return;

        const sign = invertedAxes[axis] ? 1 : -1;
        plane.normal.set(
            axis === 'x' ? sign : 0,
            axis === 'y' ? sign : 0,
            axis === 'z' ? sign : 0
        );
        plane.constant = invertedAxes[axis] ? -axisValues[axis] : axisValues[axis];
        activePlanes.push(plane);
    });

    cutRefs.model.traverse(node => {
        if (node.isMesh || node.isLine || node.isLineSegments || node.isLineLoop) {
            (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => {
                if (m) { m.clippingPlanes = activePlanes.slice(); m.clipShadows = true; m.needsUpdate = true; }
            });
        }
    });

    ['x', 'y', 'z'].forEach((axis, index) => {
        const capPlane = cutObjects.capPlanes[index];
        const stencilGroup = cutObjects.stencilGroups[index];
        if (!capPlane || !stencilGroup) return;

        const isOn = enabledAxes[axis];
        stencilGroup.visible = isOn;
        capPlane.visible = isOn;

        if (isOn) {
            updateCapPlanePosition(capPlane, cutObjects.clippingPlanes[axis]);
            // Cap обрезается плоскостями других включённых осей
            capPlane.material.clippingPlanes = activePlanes.filter(p => p !== cutObjects.clippingPlanes[axis]);
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
// VISIBLE PLANE — полупрозрачная плоскость на модели
// ============================================================

/**
 * Создаёт видимую секущую плоскость для указанной оси.
 * Плоскость — полупрозрачный прямоугольник цвета оси с рамкой.
 */
function createVisiblePlane(axis) {
    removeVisiblePlane();
    if (!cutRefs.model || !cutRefs.scene) return;

    const bounds = _store.getState('cutting3d.axisBounds');
    const axisValue = _store.getState('cutting3d.axisValues')[axis];
    if (!bounds[axis]) return;

    // Размер плоскости — по габаритам модели + запас
    const box = new THREE.Box3().setFromObject(cutRefs.model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const planeSize = maxDim * 1.1;

    // Полупрозрачная заливка
    const geometry = new THREE.PlaneGeometry(planeSize, planeSize);
    const material = new THREE.MeshBasicMaterial({
        color: AXIS_COLORS[axis],
        transparent: true,
        opacity: PLANE_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: true,
        clippingPlanes: [], // Не обрезается секущими плоскостями
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 998;

    // Рамка (рёбра прямоугольника)
    const edgesGeo = new THREE.EdgesGeometry(geometry);
    const edgeMat = new THREE.LineBasicMaterial({
        color: AXIS_COLORS[axis],
        transparent: true,
        opacity: PLANE_EDGE_OPACITY,
        clippingPlanes: [],
    });
    const edges = new THREE.LineSegments(edgesGeo, edgeMat);
    edges.renderOrder = 999;

    // Группа
    const group = new THREE.Group();
    group.name = 'cutting-visible-plane';
    group.add(mesh);
    group.add(edges);

    // Ориентация: PlaneGeometry по умолчанию в XY (нормаль +Z)
    if (axis === 'x') group.rotation.y = Math.PI / 2;
    else if (axis === 'y') group.rotation.x = -Math.PI / 2;

    // Позиция
    const pos = new THREE.Vector3(0, 0, 0);
    pos[axis] = axisValue;
    group.position.copy(pos);

    // Центрировка — сдвиг по осям перпендикулярных нормали
    const center = box.getCenter(new THREE.Vector3());
    if (axis === 'x') { group.position.y = center.y; group.position.z = center.z; }
    else if (axis === 'y') { group.position.x = center.x; group.position.z = center.z; }
    else { group.position.x = center.x; group.position.y = center.y; }

    cutRefs.scene.add(group);

    drag.planeGroup = group;
    drag.planeMesh = mesh;
    drag.planeEdges = edges;
    drag.isVisible = true;
}

/** Удаляет видимую плоскость из сцены */
function removeVisiblePlane() {
    if (drag.planeGroup) {
        cutRefs.scene.remove(drag.planeGroup);
        drag.planeGroup.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        drag.planeGroup = null;
        drag.planeMesh = null;
        drag.planeEdges = null;
    }
}

/**
 * Обновляет позицию видимой плоскости при перемещении сечения.
 * Сохраняет центрировку по перпендикулярным осям.
 */
function updateVisiblePlanePosition(axis, value) {
    if (!drag.planeGroup) return;
    drag.planeGroup.position[axis] = value;
}

/** Переключает видимость секущей плоскости */
function togglePlaneVisibility() {
    drag.isVisible = !drag.isVisible;
    if (drag.planeGroup) {
        drag.planeGroup.visible = drag.isVisible;
    }
    // Если скрыли плоскость во время перетаскивания — завершаем drag
    if (!drag.isVisible && drag.isDragging) {
        handlePointerUp();
    }
    return drag.isVisible;
}

// ============================================================
// DRAG INTERACTION — перетаскивание плоскости мышкой/пальцем
// ============================================================

/** Получить нормированные координаты указателя относительно canvas */
function _getPointerCoords(event) {
    const rect = cutRefs.renderer.domElement.getBoundingClientRect();
    drag.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    drag.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function handlePointerDown(event) {
    if (!drag.planeMesh || !_store.getState('cutting3d.isActive') || !drag.isVisible) return;

    const activeAxis = _store.getState('cutting3d.activeAxis');
    if (!activeAxis) return;

    _getPointerCoords(event);
    drag.raycaster.setFromCamera(drag.pointer, cutRefs.camera);

    // Проверяем попадание по видимой плоскости
    const hits = drag.raycaster.intersectObject(drag.planeMesh);
    if (hits.length === 0) return;

    // Начинаем перетаскивание — блокируем OrbitControls до того,
    // как он обработает событие (мы в capture-фазе)
    event.stopImmediatePropagation();
    event.preventDefault();

    drag.isDragging = true;
    drag.axis = activeAxis;
    drag.startAxisValue = _store.getState('cutting3d.axisValues')[activeAxis];

    // Создаём невидимую вспомогательную плоскость:
    // перпендикулярна направлению камеры, проходит через точку попадания
    const cameraDir = new THREE.Vector3();
    cutRefs.camera.getWorldDirection(cameraDir);
    drag.helperPlane = new THREE.Plane();
    drag.helperPlane.setFromNormalAndCoplanarPoint(cameraDir, hits[0].point);

    // Блокируем OrbitControls
    if (cutRefs.controls) cutRefs.controls.enabled = false;

    // Визуальный фидбэк
    if (drag.planeMesh) drag.planeMesh.material.opacity = PLANE_DRAG_OPACITY;
    cutRefs.renderer.domElement.style.cursor = 'grabbing';
}

function handlePointerMove(event) {
    if (!drag.planeMesh) return;

    _getPointerCoords(event);
    drag.raycaster.setFromCamera(drag.pointer, cutRefs.camera);

    if (drag.isDragging) {
        event.preventDefault();
        event.stopPropagation();

        // Пересекаем луч с вспомогательной плоскостью
        const intersection = new THREE.Vector3();
        const hasHit = drag.raycaster.ray.intersectPlane(drag.helperPlane, intersection);
        if (!hasHit) return;

        // Берём компоненту по оси сечения
        const axis = drag.axis;
        let newValue = intersection[axis];

        // Ограничиваем в пределах модели
        const bounds = _store.getState('cutting3d.axisBounds')[axis];
        newValue = Math.max(bounds.min, Math.min(bounds.max, newValue));

        // Обновляем store и применяем сечение
        _store.setState('cutting3d.axisValues', {
            ..._store.getState('cutting3d.axisValues'),
            [axis]: newValue
        });
        applyClippingPlanes();
        updateVisiblePlanePosition(axis, newValue);
    } else {
        // Hover-эффект (только если плоскость видима)
        if (!drag.planeMesh || !drag.isVisible) return;
        const hits = drag.raycaster.intersectObject(drag.planeMesh);
        if (hits.length > 0) {
            drag.planeMesh.material.opacity = PLANE_HOVER_OPACITY;
            cutRefs.renderer.domElement.style.cursor = 'grab';
        } else {
            drag.planeMesh.material.opacity = PLANE_OPACITY;
            cutRefs.renderer.domElement.style.cursor = '';
        }
    }
}

function handlePointerUp() {
    if (!drag.isDragging) return;

    drag.isDragging = false;
    drag.helperPlane = null;

    // Разблокируем OrbitControls
    if (cutRefs.controls) cutRefs.controls.enabled = true;

    // Сброс курсора и прозрачности
    cutRefs.renderer.domElement.style.cursor = '';
    if (drag.planeMesh) drag.planeMesh.material.opacity = PLANE_OPACITY;
}

/** Подключает обработчики pointer events к canvas */
function setupDragListeners() {
    const canvas = cutRefs.renderer?.domElement;
    if (!canvas) return;

    // PointerDown — на canvas в capture-фазе, чтобы перехватить событие
    // до OrbitControls и предотвратить вращение камеры при клике на плоскость
    drag._ptrDown = (e) => handlePointerDown(e);
    canvas.addEventListener('pointerdown', drag._ptrDown, true);

    // PointerMove и PointerUp — на window для надёжности
    drag._ptrMove = (e) => handlePointerMove(e);
    drag._ptrUp = () => handlePointerUp();
    window.addEventListener('pointermove', drag._ptrMove);
    window.addEventListener('pointerup', drag._ptrUp);

    // Touch-совместимость: предотвращаем скролл при перетаскивании
    drag._touchPrevent = (e) => { if (drag.isDragging) e.preventDefault(); };
    canvas.addEventListener('touchmove', drag._touchPrevent, { passive: false });
}

/** Отключает все обработчики pointer events */
function cleanupDragListeners() {
    const canvas = cutRefs.renderer?.domElement;

    if (canvas && drag._ptrDown) canvas.removeEventListener('pointerdown', drag._ptrDown, true);
    if (drag._ptrMove) window.removeEventListener('pointermove', drag._ptrMove);
    if (drag._ptrUp) window.removeEventListener('pointerup', drag._ptrUp);
    if (canvas && drag._touchPrevent) canvas.removeEventListener('touchmove', drag._touchPrevent);

    drag._ptrDown = null;
    drag._ptrMove = null;
    drag._ptrUp = null;
    drag._touchPrevent = null;
}

// ============================================================
// SVG ИКОНКИ (inline — глаз/глаз закрыт)
// ============================================================

const EYE_OPEN_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

const EYE_CLOSED_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// ============================================================
// UI HELPERS
// ============================================================

function updateAxisUI(axisBtns, visibilityBtn) {
    const activeAxis = _store.getState('cutting3d.activeAxis');
    axisBtns.forEach(b => {
        const axis = b.dataset.axis;
        // enabled — ось включена (режет модель)
        b.classList.toggle('enabled', enabledAxes[axis]);
        // active — ось выбрана для перетаскивания (видимая плоскость)
        b.classList.toggle('active', axis === activeAxis);
    });

    // Кнопка видимости доступна когда есть активная ось
    const hasActive = !!activeAxis;
    if (visibilityBtn) visibilityBtn.disabled = !hasActive;
}

function updateVisibilityButton(visibilityBtn) {
    if (!visibilityBtn) return;
    visibilityBtn.classList.toggle('active', drag.isVisible);
    visibilityBtn.innerHTML = drag.isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    visibilityBtn.title = drag.isVisible ? 'Скрыть плоскость' : 'Показать плоскость';
}

function resetCutting(axisBtns, visibilityBtn) {
    // Сбрасываем значения осей на центр модели
    const bounds = _store.getState('cutting3d.axisBounds');
    const newValues = {};
    ['x', 'y', 'z'].forEach(axis => {
        newValues[axis] = (bounds[axis].min + bounds[axis].max) / 2;
        enabledAxes[axis] = false;
    });
    _store.setState('cutting3d.axisValues', newValues);

    _store.setState('cutting3d.invertedAxes', { x: false, y: false, z: false });
    _store.setState('cutting3d.activeAxis', null);

    // Сброс UI
    axisBtns.forEach(b => { b.classList.remove('active'); b.classList.remove('enabled'); });

    // Удаляем видимую плоскость
    removeVisiblePlane();
    drag.isVisible = true;
    updateVisibilityButton(visibilityBtn);

    applyClippingPlanes();
}

// ============================================================
// РЕГИСТРАЦИЯ ПЛАГИНА
// ============================================================

PluginManager.register({
    id: 'cutting-3d',
    name: 'Сечение',
    icon: 'slice-fill',
    module: '3d-viewer',

    condition: (api) => !!(api && api.model && api.scene),

    init(api) {
        if (!api.scene || !api.model) return;

        _store = api.store;
        cutRefs.scene = api.scene;
        cutRefs.model = api.model;
        cutRefs.renderer = api.renderer;
        cutRefs.camera = api.camera;
        cutRefs.controls = api.controls;

        if (api.renderer) {
            api.renderer.localClippingEnabled = true;
            if (!api.renderer.capabilities.stencilBuffer) {
                console.warn('[cutting-3d] Renderer does not support stencil buffer.');
            }
        }

        syncCapOptionsFromStore();
        computeModelBounds();
        enableCutting();
        setupDragListeners();

        window.ModelCut = { updateCapColor };
    },

    destroy() {
        disableCutting();
        removeVisiblePlane();
        cleanupDragListeners();
        window.ModelCut = null;
        _store = null;
    },

    panel: {
        className: 'cutting-panel plugin-pill',

        html: `
            <div class="cutting-axes plugin-pill-group">
                <button class="cutting-axis-btn plugin-pill-btn axis-x" data-axis="x">X</button>
                <button class="cutting-axis-btn plugin-pill-btn axis-y" data-axis="y">Y</button>
                <button class="cutting-axis-btn plugin-pill-btn axis-z" data-axis="z">Z</button>
            </div>
            <div class="cutting-actions plugin-pill-group">
                <button class="cutting-visibility-btn plugin-pill-btn active" id="cutting-visibility-btn" title="Скрыть плоскость">
                    ${EYE_OPEN_SVG}
                </button>
                <button class="cutting-invert-btn plugin-pill-btn" disabled title="Инвертировать направление">
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-right-arrow-left"></use></svg>
                </button>
                <button class="cutting-reset-btn plugin-pill-btn" title="Сбросить сечение">
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-rotate-left"></use></svg>
                </button>
            </div>
        `,

        onMount(toolbar) {
            const axisBtns = toolbar.querySelectorAll('.cutting-axis-btn');
            const visibilityBtn = toolbar.querySelector('#cutting-visibility-btn');
            const invertBtn = toolbar.querySelector('.cutting-invert-btn');
            const resetBtn = toolbar.querySelector('.cutting-reset-btn');

            // --- Кнопки осей ---
            axisBtns.forEach(btn => {
                const handler = () => {
                    if (!_store.getState('cutting3d.isActive')) return;

                    const clickedAxis = btn.dataset.axis;
                    const currentAxis = _store.getState('cutting3d.activeAxis');

                    if (currentAxis === clickedAxis) {
                        // Клик по текущей активной оси → отключаем её
                        enabledAxes[clickedAxis] = false;

                        // Переключаемся на другую включённую ось, если есть
                        const otherEnabled = ['x', 'y', 'z'].find(a => enabledAxes[a] && a !== clickedAxis);

                        if (otherEnabled) {
                            _store.setState('cutting3d.activeAxis', otherEnabled);
                            createVisiblePlane(otherEnabled);
                        } else {
                            _store.setState('cutting3d.activeAxis', null);
                            removeVisiblePlane();
                        }

                        drag.isVisible = true;
                        updateVisibilityButton(visibilityBtn);
                        applyClippingPlanes();
                    } else if (enabledAxes[clickedAxis]) {
                        // Клик по уже включённой (но не активной) оси → переключаем drag на неё
                        _store.setState('cutting3d.activeAxis', clickedAxis);
                        createVisiblePlane(clickedAxis);
                    } else {
                        // Новая ось → включаем и делаем активной
                        enabledAxes[clickedAxis] = true;
                        _store.setState('cutting3d.activeAxis', clickedAxis);

                        createVisiblePlane(clickedAxis);
                        drag.isVisible = true;
                        updateVisibilityButton(visibilityBtn);
                        applyClippingPlanes();
                    }

                    updateAxisUI(axisBtns, visibilityBtn);

                    // Обновляем состояние кнопки инверсии
                    if (invertBtn) {
                        const ax = _store.getState('cutting3d.activeAxis');
                        invertBtn.disabled = !ax;
                        invertBtn.classList.toggle('active', ax ? _store.getState('cutting3d.invertedAxes')[ax] : false);
                    }
                };
                btn.addEventListener('click', handler);
                _boundUIHandlers.push({ el: btn, type: 'click', handler });
            });

            // --- Кнопка видимости ---
            if (visibilityBtn) {
                const handler = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const visible = togglePlaneVisibility();
                    updateVisibilityButton(visibilityBtn);
                };
                visibilityBtn.addEventListener('click', handler);
                _boundUIHandlers.push({ el: visibilityBtn, type: 'click', handler });
            }

            // --- Кнопка инверсии ---
            if (invertBtn) {
                const handler = () => {
                    const axis = _store.getState('cutting3d.activeAxis');
                    if (!axis || !_store.getState('cutting3d.isActive')) return;

                    const cur = _store.getState('cutting3d.invertedAxes');
                    _store.setState('cutting3d.invertedAxes', { ...cur, [axis]: !cur[axis] });
                    invertBtn.classList.toggle('active', _store.getState('cutting3d.invertedAxes')[axis]);

                    applyClippingPlanes();
                };
                invertBtn.addEventListener('click', handler);
                _boundUIHandlers.push({ el: invertBtn, type: 'click', handler });
            }

            // --- Кнопка сброса ---
            if (resetBtn) {
                const handler = () => resetCutting(axisBtns, visibilityBtn);
                resetBtn.addEventListener('click', handler);
                _boundUIHandlers.push({ el: resetBtn, type: 'click', handler });
            }

            // Восстановление состояния, если ось уже была активна
            if (_store.getState('cutting3d.activeAxis')) {
                const axis = _store.getState('cutting3d.activeAxis');
                createVisiblePlane(axis);
                updateAxisUI(axisBtns, visibilityBtn);
            }
        },

        onUnmount() {
            for (const { el, type, handler } of _boundUIHandlers) {
                el.removeEventListener(type, handler);
            }
            _boundUIHandlers = [];
        }
    }
});