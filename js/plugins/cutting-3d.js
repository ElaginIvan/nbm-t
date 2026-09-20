/**
 * Плагин: Сечение модели (3D) — drag-версия.
 * Секущая плоскость управляется прямым перетаскиванием: при выборе оси (X/Y/Z)
 * появляется полупрозрачная плоскость, которую можно двигать мышкой или пальцем.
 * Stencil-сечение + cap-плоскости. Метки [FIX-XXX-N] в коде — точки патчей производительности/артефактов.
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
const materialCache = new Map();

// [FIX-PERF-3] Кэш «исходный материал модели → клон для сечения».
// Без него m.clone() вызывался бы на каждый узел модели — для ангара
// с ~1000 узлов это ~1000 клонов, даже если все они шарят один исходник
// (Default). С кэшем клон создаётся один раз на уникальный исходный
// материал — Three.js снова может батчить draw call'ы.
const _clonedModelMaterials = new Map();

// Связь «оригинальный меш модели → его stencil-меши (back+front по каждой оси)».
// Нужна для синхронизации видимости: если деталь спрятали (mesh.visible=false
// или скрыт её предок в дереве сборки), соответствующие stencil-меши тоже
// прячутся → cap-плоскость больше не рисает «заглушку» в этом месте.
// Map (а не WeakMap): реестр живёт ровно одну сессию сечения и ПОЛНОСТЬЮ
// сбрасывается в disableCutting. WeakMap очистить нельзя — из-за этого при
// повторном включении сечения registeredMeshes оставался пустым и синхронизация
// cap-заглушек умирала навсегда (критичный баг C1).
const meshToStencilMeshes = new Map();

// Список мешей, у которых есть зарегистрированные stencil-меши.
// Используется для быстрого обхода в syncPartVisibility без полного traverse модели.
const registeredMeshes = new Set();

// E4: отписка от Store вместо RAF-идентификатора. Видимость деталей меняется
// только событийно (дерево спецификации), вечный 60-кадровый поллинг удалён.
let _unsubscribeVisibility = null;

const capOptions = {
    metalness: 0.1,
    roughness: 0.75,
    planeSizes: {
        x: { w: 100, h: 100 },
        y: { w: 100, h: 100 },
        z: { w: 100, h: 100 }
    }
};

let _store = null;
let _boundUIHandlers = [];

const enabledAxes = { x: false, y: false, z: false };

// ============================================================
// DRAG STATE
// ============================================================

const drag = {
    isDragging: false,
    axis: null,
    planeGroup: null,
    planeMesh: null,
    planeEdges: null,
    isVisible: true,

    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    helperPlane: null,

    activePointers: new Map(),

    _savedControlsState: null,

    _ptrDown: null,
    _ptrMove: null,
    _ptrUp: null,
    _ptrCancel: null,
    _touchPrevent: null,
};

// ============================================================
// ЛОГИКА СЕЧЕНИЯ — stencil, cap, clipping
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
    const MARGIN = 1.1;
    capOptions.planeSizes = {
        x: { w: size.z * MARGIN, h: size.y * MARGIN },
        y: { w: size.x * MARGIN, h: size.z * MARGIN },
        z: { w: size.x * MARGIN, h: size.y * MARGIN }
    };
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
    // [FIX-PERF-1] Раньше baseMaterial.clone() вызывался на КАЖДУЮ пару
    // stencil-мешей → для ангара с ~1000 узлов это ~6000 отдельных
    // MeshBasicMaterial в сцене. Теперь кэшируем ГОТОВЫЕ back+front
    // материалы на ось (3 оси × 2 стороны = 6 материалов всего).
    // clippingPlanes — ссылка, обновляем её на актуальный plane (он
    // один на ось, значит общий для всех пар).
    const cacheKey = `stencil-pair-${renderOrder}`;
    let cached = materialCache.get(cacheKey);
    if (!cached) {
        const backMaterial = new THREE.MeshBasicMaterial({
            depthWrite: false, depthTest: false, colorWrite: false,
            stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
            side: THREE.BackSide,
            stencilFail: THREE.IncrementWrapStencilOp,
            stencilZFail: THREE.IncrementWrapStencilOp,
            stencilZPass: THREE.IncrementWrapStencilOp
        });
        const frontMaterial = new THREE.MeshBasicMaterial({
            depthWrite: false, depthTest: false, colorWrite: false,
            stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
            side: THREE.FrontSide,
            stencilFail: THREE.DecrementWrapStencilOp,
            stencilZFail: THREE.DecrementWrapStencilOp,
            stencilZPass: THREE.DecrementWrapStencilOp
        });
        // [FIX-PERF-1] Помечаем shared-материалы флагом, чтобы disposeGroup
        // не диспозил их 6072 раза (по разу на каждый stencil-меш). Реальное
        // dispose делаем централизованно в disableCutting.
        backMaterial.userData.__sharedStencil = true;
        frontMaterial.userData.__sharedStencil = true;
        cached = { back: backMaterial, front: frontMaterial, shared: true };
        materialCache.set(cacheKey, cached);
    }
    // Plane мог быть переопределён (инверсия оси) — обновляем ссылку
    // в обоих shared-материалах. Это копия массива из 1 элемента.
    cached.back.clippingPlanes = [plane];
    cached.front.clippingPlanes = [plane];

    const backMesh = new THREE.Mesh(geometry, cached.back);
    const frontMesh = new THREE.Mesh(geometry, cached.front);
    backMesh.renderOrder = frontMesh.renderOrder = renderOrder;
    group.add(backMesh, frontMesh);
    return group;
}

function createCapPlane(plane, renderOrder, otherPlanes, axis) {
    const capColor = getModelBaseColor();
    // [FIX-ART-1] polygonOffset тащит cap-плоскость к камере — иначе
    // z-fighting с ребром модели на той же глубине axisValue,
    // из-за чего заглушка выглядит «утопленной во внутрь» (видна
    // частично, местами перекрыта краем геометрии). Это классика
    // stencil-сечений, без polygonOffset кап неизбежно мерцает.
    // [FIX-PERF-4] dithering:true убран — материал непрозрачный,
    // dithering только порождал лишний shader variant без визуального
    // эффекта.
    const material = new THREE.MeshStandardMaterial({
        color: capColor, metalness: capOptions.metalness, roughness: capOptions.roughness,
        clippingPlanes: otherPlanes, stencilWrite: true, stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
        side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -1
    });
    const sizes = capOptions.planeSizes[axis] || { w: 100, h: 100 };
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sizes.w, sizes.h), material);
    mesh.renderOrder = renderOrder + 0.1;
    mesh.onAfterRender = () => { if (cutRefs.renderer) cutRefs.renderer.clearStencil(); };
    return mesh;
}

function updateCapPlanePosition(capPlane, plane, axis) {
    if (!capPlane || !plane) return;
    const bounds = _store.getState('cutting3d.axisBounds');
    const axisValue = _store.getState('cutting3d.axisValues')[axis];
    const cx = (bounds.x.min + bounds.x.max) / 2;
    const cy = (bounds.y.min + bounds.y.max) / 2;
    const cz = (bounds.z.min + bounds.z.max) / 2;

    // [FIX-ART-3] Небольшой сдвиг cap вдоль нормали разреза в сторону
    // сохранённой части модели — страховка от z-fighting сверх polygonOffset.
    // Берём долю от размера модели по этой оси (1e-4 ≈ 0.6 мм для ангара
    // 60 м), чтобы не было визуально заметно, но хватало для depth buffer
    // на дальних дистанциях. Нормаль указывает отсекаемую сторону, значит
    // сдвиг в направлении -normal = в сторону сохранённой геометрии.
    const axisSpan = Math.max(bounds[axis].max - bounds[axis].min, 1e-6);
    const epsilon = Math.max(axisSpan * 1e-4, 1e-3);
    const offset = -epsilon; // в сторону сохранённой части

    if (axis === 'x') {
        capPlane.position.set(axisValue + offset * plane.normal.x, cy, cz);
    } else if (axis === 'y') {
        capPlane.position.set(cx, axisValue + offset * plane.normal.y, cz);
    } else { // 'z'
        capPlane.position.set(cx, cy, axisValue + offset * plane.normal.z);
    }

    // [FIX-ART-2] Для оси Y (нормаль ±Y) lookAt с дефолтным up=(0,1,0)
    // даёт degenerate-матрицу: view direction = (0, ±1, 0) параллелен up →
    // cross product = 0 → rotation NaN/zero. Это причина артефактов на
    // вертикальных разрезах балок: кап мог быть ориентирован случайно
    // или вообще не отрисовываться. Меняем up на (0,0,1) — не параллелен
    // Y-нормали. Для X и Z дефолтный up работает, но явно фиксируем для
    // предсказуемости.
    if (axis === 'y') {
        capPlane.up.set(0, 0, 1);
    } else {
        capPlane.up.set(0, 1, 0);
    }
    capPlane.lookAt(
        capPlane.position.x - plane.normal.x,
        capPlane.position.y - plane.normal.y,
        capPlane.position.z - plane.normal.z
    );
}

function disposeGroup(group) {
    group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => {
                if (!m) return;
                // [FIX-PERF-1] shared stencil-материалы диспозим отдельно —
                // в disableCutting через materialCache.forEach, чтобы не
                // вызывать dispose() 6072 раза на 6 материалов (это безопасно
                // для Three.js — dispose() идемпотентен, но лишняя работа).
                if (m.userData?.__sharedStencil) return;
                if (typeof m.dispose === 'function') m.dispose();
            });
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
    const worldGeometrySources = [];
    cutRefs.model.traverse(node => {
        if (!node.isMesh) return;
        if (node.geometry) {
            const wg = node.geometry.clone();
            node.updateWorldMatrix(true, false);
            wg.applyMatrix4(node.matrixWorld);
            worldGeometrySources.push({ geom: wg, node });
        }
    });
    const allPlanes = [cutObjects.clippingPlanes.x, cutObjects.clippingPlanes.y, cutObjects.clippingPlanes.z];
    ['x', 'y', 'z'].forEach((axis, index) => {
        const stencilGroup = new THREE.Group();
        stencilGroup.name = `stencil-${axis}`;
        worldGeometrySources.forEach(({ geom, node }) => {
            const stencilPair = createPlaneStencilGroup(geom, allPlanes[index], index + 1);
            stencilGroup.add(stencilPair);
            if (!meshToStencilMeshes.has(node)) {
                meshToStencilMeshes.set(node, []);
                registeredMeshes.add(node);
            }
            meshToStencilMeshes.get(node).push(...stencilPair.children);
        });
        cutRefs.scene.add(stencilGroup);
        cutObjects.stencilGroups.push(stencilGroup);
        const otherPlanes = allPlanes.filter((_, i) => i !== index);
        const capPlane = createCapPlane(allPlanes[index], index + 1, otherPlanes, axis);
        capPlane.name = `cap-${axis}`;
        const capGroup = new THREE.Group();
        capGroup.add(capPlane);
        cutRefs.scene.add(capGroup);
        cutObjects.capPlanes.push(capPlane);
        cutObjects.capPlaneGroups.push(capGroup);
    });
    applyClippingPlanes();
    syncPartVisibility();
}

/**
 * Возврат материалов по контракту владения (см. applyClippingPlanes):
 * снимаем ТОЛЬКО собственную запись в стеке подмен. Клоны НЕ диспозим
 * здесь — они в _clonedModelMaterials и могут шариться между узлами,
// диспозим всё скопом в disableCutting().
 */
function releaseClippingMaterials() {
    cutRefs.model.traverse(node => {
        const stack = node.userData?.materialOwners;
        if (!stack) return;
        const idx = stack.findIndex(e => e.owner === 'cutting-3d');
        if (idx === -1) return;
        const isTop = idx === stack.length - 1;
        const saved = stack[idx].saved;
        stack.splice(idx, 1);
        if (stack.length === 0) delete node.userData.materialOwners;
        if (isTop) {
            node.material = saved;
            // [FIX-PERF-3] Не диспозим клон здесь — он может шариться
            // между узлами. Полная очистка — в disableCutting.
        }
    });
}

function disableCutting() {
    if (!cutRefs.model || !_store.getState('cutting3d.isActive')) return;
    _store.setState('cutting3d.isActive', false);
    releaseClippingMaterials();
    [...cutObjects.stencilGroups, ...cutObjects.capPlaneGroups].forEach(group => { cutRefs.scene.remove(group); disposeGroup(group); });
    cutObjects.stencilGroups = []; cutObjects.capPlanes = []; cutObjects.capPlaneGroups = [];
    cutObjects.clippingPlanes = { x: null, y: null, z: null };
    meshToStencilMeshes.clear();
    registeredMeshes.clear();
    enabledAxes.x = false;
    enabledAxes.y = false;
    enabledAxes.z = false;
    _store.setState('cutting3d.activeAxis', null);

    // [FIX-PERF-1] Диспозим shared stencil-материалы и чистим materialCache.
    materialCache.forEach(item => {
        if (item && typeof item === 'object' && item.shared) {
            if (item.back?.dispose) item.back.dispose();
            if (item.front?.dispose) item.front.dispose();
        } else if (item && typeof item.dispose === 'function') {
            item.dispose();
        }
    });
    materialCache.clear();

    // [FIX-PERF-3] Диспозим клонированные материалы модели и чистим кэш.
    _clonedModelMaterials.forEach(m => {
        if (m && typeof m.dispose === 'function') m.dispose();
    });
    _clonedModelMaterials.clear();

    // [FIX-PERF-2] Сбрасываем счётчик количества plane'ов — иначе при
    // следующем enableCutting needsUpdate не сработает на первый apply.
    applyClippingPlanes._lastPlaneCount = -1;
}

// ------------------------------------------------------------
// Синхронизация видимости
// ------------------------------------------------------------

function isEffectivelyVisible(node) {
    let cur = node;
    while (cur) {
        if (cur.visible === false) return false;
        cur = cur.parent;
    }
    return true;
}

function syncPartVisibility() {
    if (!_store.getState('cutting3d.isActive')) return;
    registeredMeshes.forEach(node => {
        const stencilMeshes = meshToStencilMeshes.get(node);
        if (!stencilMeshes) return;
        const visible = isEffectivelyVisible(node);
        for (let i = 0; i < stencilMeshes.length; i++) {
            stencilMeshes[i].visible = visible;
        }
    });
}

function startVisibilitySync() {
    if (_unsubscribeVisibility !== null || !_store) return;
    _unsubscribeVisibility = _store.subscribe('specification.lastSelectedPart', () => {
        syncPartVisibility();
    });
}

function stopVisibilitySync() {
    if (_unsubscribeVisibility !== null) {
        _unsubscribeVisibility();
        _unsubscribeVisibility = null;
    }
}

function applyClippingPlanes() {
    if (!cutRefs.model || !_store.getState('cutting3d.isActive')) return;

    const axisValues = _store.getState('cutting3d.axisValues');
    const invertedAxes = _store.getState('cutting3d.invertedAxes');
    const activePlanes = [];

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

    // [FIX-PERF-2] needsUpdate:true нужен ТОЛЬКО когда изменилось КОЛИЧЕСТВО
    // активных плоскостей — это перекомпилирует шейдер (define
    // NUM_CLIPPING_PLANES в WebGLProgram). Сами значения normal/constant —
    // это uniform'ы, они обновляются без needsUpdate. Раньше needsUpdate
    // дёргался на каждый pointermove → лишние проверки program cache в
    // Three.js на 1000+ материалах в кадре.
    const prevPlaneCount = applyClippingPlanes._lastPlaneCount;
    const planeCountChanged = prevPlaneCount !== activePlanes.length;
    applyClippingPlanes._lastPlaneCount = activePlanes.length;

    cutRefs.model.traverse(node => {
        if (!(node.isMesh || node.isLine || node.isLineSegments || node.isLineLoop)) return;
        if (!node.material) return;
        const stack = node.userData.materialOwners || (node.userData.materialOwners = []);
        const oursIdx = stack.findIndex(e => e.owner === 'cutting-3d');
        if (oursIdx === -1) {
            if (stack.length > 0) return; // материал сейчас подменён другим плагином
            // [FIX-PERF-3] Клонируем материал один раз на уникальный
            // исходный материал, шарим клон между всеми узлами, которые
            // исходно шарили источник. Восстанавливает батчинг Three.js.
            const cloneMaterial = m => {
                if (!m) return m;
                let n = _clonedModelMaterials.get(m);
                if (!n) {
                    n = m.clone();
                    n.clippingPlanes = [];
                    n.clipShadows = true;
                    n.shadowSide = THREE.DoubleSide;
                    // [FIX-PERF-4] dithering:true на непрозрачном материале
                    // только порождал лишний shader variant — убираем.
                    _clonedModelMaterials.set(m, n);
                }
                return n;
            };
            const cloned = Array.isArray(node.material) ? node.material.map(cloneMaterial) : cloneMaterial(node.material);
            stack.push({ owner: 'cutting-3d', saved: node.material });
            node.material = cloned;
        }
        (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => {
            if (m) {
                m.clippingPlanes = activePlanes.slice();
                m.clipShadows = true;
                // [FIX-PERF-2] только при смене количества plane'ов
                if (planeCountChanged) m.needsUpdate = true;
            }
        });
    });

    ['x', 'y', 'z'].forEach((axis, index) => {
        const capPlane = cutObjects.capPlanes[index];
        const stencilGroup = cutObjects.stencilGroups[index];
        if (!capPlane || !stencilGroup) return;

        const isOn = enabledAxes[axis];
        stencilGroup.visible = isOn;
        capPlane.visible = isOn;

        if (isOn) {
            updateCapPlanePosition(capPlane, cutObjects.clippingPlanes[axis], axis);
            capPlane.material.clippingPlanes = activePlanes.filter(p => p !== cutObjects.clippingPlanes[axis]);
            // [FIX-PERF-2]
            if (planeCountChanged) capPlane.material.needsUpdate = true;
        }
    });
}
applyClippingPlanes._lastPlaneCount = -1;

// ============================================================
// VISIBLE PLANE — полупрозрачная плоскость на модели
// ============================================================

function createVisiblePlane(axis) {
    removeVisiblePlane();
    if (!cutRefs.model || !cutRefs.scene) return;

    const bounds = _store.getState('cutting3d.axisBounds');
    const axisValue = _store.getState('cutting3d.axisValues')[axis];
    if (!bounds[axis]) return;

    const sizes = capOptions.planeSizes[axis] || { w: 100, h: 100 };
    const planeWidth = sizes.w;
    const planeHeight = sizes.h;

    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    const material = new THREE.MeshBasicMaterial({
        color: AXIS_COLORS[axis],
        transparent: true,
        opacity: PLANE_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: true,
        clippingPlanes: [],
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 998;

    const edgesGeo = new THREE.EdgesGeometry(geometry);
    const edgeMat = new THREE.LineBasicMaterial({
        color: AXIS_COLORS[axis],
        transparent: true,
        opacity: PLANE_EDGE_OPACITY,
        clippingPlanes: [],
    });
    const edges = new THREE.LineSegments(edgesGeo, edgeMat);
    edges.renderOrder = 999;

    const group = new THREE.Group();
    group.name = 'cutting-visible-plane';
    group.add(mesh);
    group.add(edges);

    if (axis === 'x') group.rotation.y = Math.PI / 2;
    else if (axis === 'y') group.rotation.x = -Math.PI / 2;

    const pos = new THREE.Vector3(0, 0, 0);
    pos[axis] = axisValue;
    group.position.copy(pos);

    const b = _store.getState('cutting3d.axisBounds');
    const cx = (b.x.min + b.x.max) / 2;
    const cy = (b.y.min + b.y.max) / 2;
    const cz = (b.z.min + b.z.max) / 2;
    if (axis === 'x') { group.position.y = cy; group.position.z = cz; }
    else if (axis === 'y') { group.position.x = cx; group.position.z = cz; }
    else { group.position.x = cx; group.position.y = cy; }

    cutRefs.scene.add(group);

    drag.planeGroup = group;
    drag.planeMesh = mesh;
    drag.planeEdges = edges;
    drag.isVisible = true;
}

function removeVisiblePlane() {
    if (!drag.planeGroup) return;
    cutRefs.scene.remove(drag.planeGroup);
    disposeGroup(drag.planeGroup);
    drag.planeGroup = null;
    drag.planeMesh = null;
    drag.planeEdges = null;
}

function updateVisiblePlanePosition(axis, value) {
    if (!drag.planeGroup) return;
    drag.planeGroup.position[axis] = value;
}

function togglePlaneVisibility() {
    drag.isVisible = !drag.isVisible;
    if (drag.planeGroup) {
        drag.planeGroup.visible = drag.isVisible;
    }
    if (!drag.isVisible && drag.isDragging) {
        handlePointerUp();
    }
    return drag.isVisible;
}

// ============================================================
// DRAG INTERACTION — перетаскивание плоскости мышкой/пальцем
// ============================================================

function _getPointerCoords(event) {
    const rect = cutRefs.renderer.domElement.getBoundingClientRect();
    drag.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    drag.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function _setControlsForDrag(enabled) {
    if (!cutRefs.controls) return;
    if (enabled) {
        if (drag._savedControlsState) {
            cutRefs.controls.enableRotate = drag._savedControlsState.enableRotate;
            cutRefs.controls.enablePan = drag._savedControlsState.enablePan;
            drag._savedControlsState = null;
        } else {
            cutRefs.controls.enableRotate = true;
            cutRefs.controls.enablePan = true;
        }
    } else {
        if (!drag._savedControlsState) {
            drag._savedControlsState = {
                enableRotate: cutRefs.controls.enableRotate,
                enablePan: cutRefs.controls.enablePan,
            };
        }
        cutRefs.controls.enableRotate = false;
        cutRefs.controls.enablePan = false;
    }
}

function _cancelDrag() {
    drag.isDragging = false;
    drag.helperPlane = null;
    if (cutRefs.renderer?.domElement) cutRefs.renderer.domElement.style.cursor = '';
    if (drag.planeMesh) drag.planeMesh.material.opacity = PLANE_OPACITY;
}

function handlePointerDown(event) {
    if (PluginManager.isPluginPaused('cutting-3d')) return;

    drag.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (drag.activePointers.size > 1) {
        if (drag.isDragging) {
            _cancelDrag();
            _setControlsForDrag(true);
        }
        return;
    }

    if (!drag.planeMesh || !_store.getState('cutting3d.isActive') || !drag.isVisible) return;

    const activeAxis = _store.getState('cutting3d.activeAxis');
    if (!activeAxis) return;

    _getPointerCoords(event);
    drag.raycaster.setFromCamera(drag.pointer, cutRefs.camera);

    const hits = drag.raycaster.intersectObject(drag.planeMesh);
    if (hits.length === 0) return;

    event.preventDefault();
    _setControlsForDrag(false);

    drag.isDragging = true;
    drag.axis = activeAxis;

    const cameraDir = new THREE.Vector3();
    cutRefs.camera.getWorldDirection(cameraDir);
    drag.helperPlane = new THREE.Plane();
    drag.helperPlane.setFromNormalAndCoplanarPoint(cameraDir, hits[0].point);

    if (drag.planeMesh) drag.planeMesh.material.opacity = PLANE_DRAG_OPACITY;
    cutRefs.renderer.domElement.style.cursor = 'grabbing';
}

function handlePointerMove(event) {
    if (!drag.planeMesh) return;

    if (drag.activePointers.has(event.pointerId)) {
        drag.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (drag.activePointers.size > 1) {
        if (drag.isDragging) {
            _cancelDrag();
            _setControlsForDrag(true);
        }
        return;
    }

    _getPointerCoords(event);
    drag.raycaster.setFromCamera(drag.pointer, cutRefs.camera);

    if (drag.isDragging) {
        event.preventDefault();

        const intersection = new THREE.Vector3();
        const hasHit = drag.raycaster.ray.intersectPlane(drag.helperPlane, intersection);
        if (!hasHit) return;

        const axis = drag.axis;
        let newValue = intersection[axis];

        const bounds = _store.getState('cutting3d.axisBounds')[axis];
        newValue = Math.max(bounds.min, Math.min(bounds.max, newValue));

        _store.setState('cutting3d.axisValues', {
            ..._store.getState('cutting3d.axisValues'),
            [axis]: newValue
        });
        applyClippingPlanes();
        updateVisiblePlanePosition(axis, newValue);
    } else {
        if (PluginManager.isPluginPaused('cutting-3d')) return;
        if (drag.activePointers.size > 0) return;
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

function handlePointerUp(event) {
    if (event && event.pointerId !== undefined) {
        drag.activePointers.delete(event.pointerId);
    }

    if (drag.isDragging) {
        _cancelDrag();
    }

    if (drag.activePointers.size === 0) {
        _setControlsForDrag(true);
    }
}

function setupDragListeners() {
    const canvas = cutRefs.renderer?.domElement;
    if (!canvas) return;

    drag._ptrDown = (e) => handlePointerDown(e);
    canvas.addEventListener('pointerdown', drag._ptrDown, true);

    drag._ptrMove = (e) => handlePointerMove(e);
    drag._ptrUp = (e) => handlePointerUp(e);
    window.addEventListener('pointermove', drag._ptrMove);
    window.addEventListener('pointerup', drag._ptrUp);

    drag._ptrCancel = (e) => handlePointerUp(e);
    window.addEventListener('pointercancel', drag._ptrCancel);

    drag._touchPrevent = (e) => { if (drag.isDragging && drag.activePointers.size <= 1) e.preventDefault(); };
    canvas.addEventListener('touchmove', drag._touchPrevent, { passive: false });
}

function cleanupDragListeners() {
    const canvas = cutRefs.renderer?.domElement;

    if (canvas && drag._ptrDown) canvas.removeEventListener('pointerdown', drag._ptrDown, true);
    if (drag._ptrMove) window.removeEventListener('pointermove', drag._ptrMove);
    if (drag._ptrUp) window.removeEventListener('pointerup', drag._ptrUp);
    if (drag._ptrCancel) window.removeEventListener('pointercancel', drag._ptrCancel);
    if (canvas && drag._touchPrevent) canvas.removeEventListener('touchmove', drag._touchPrevent);

    drag._ptrDown = null;
    drag._ptrMove = null;
    drag._ptrUp = null;
    drag._ptrCancel = null;
    drag._touchPrevent = null;

    drag.activePointers.clear();
    drag.isDragging = false;
    drag.helperPlane = null;

    if (cutRefs.renderer?.domElement) cutRefs.renderer.domElement.style.cursor = '';

    _setControlsForDrag(true);
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
        b.classList.toggle('enabled', enabledAxes[axis]);
        b.classList.toggle('active', axis === activeAxis);
    });

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
    const bounds = _store.getState('cutting3d.axisBounds');
    const newValues = {};
    ['x', 'y', 'z'].forEach(axis => {
        newValues[axis] = (bounds[axis].min + bounds[axis].max) / 2;
        enabledAxes[axis] = false;
    });
    _store.setState('cutting3d.axisValues', newValues);

    _store.setState('cutting3d.invertedAxes', { x: false, y: false, z: false });
    _store.setState('cutting3d.activeAxis', null);

    axisBtns.forEach(b => { b.classList.remove('active'); b.classList.remove('enabled'); });

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
        _store = api.store;
        cutRefs.scene = api.scene;
        cutRefs.model = api.model;
        cutRefs.renderer = api.renderer;
        cutRefs.camera = api.camera;
        cutRefs.controls = api.controls;

        if (!api.scene || !api.model) return;

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
        startVisibilitySync();

        return () => {
            stopVisibilitySync();
        };
    },

    destroy() {
        stopVisibilitySync();
        disableCutting();
        removeVisiblePlane();
        cleanupDragListeners();
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

            axisBtns.forEach(btn => {
                const handler = () => {
                    if (!_store.getState('cutting3d.isActive')) return;

                    const clickedAxis = btn.dataset.axis;
                    const currentAxis = _store.getState('cutting3d.activeAxis');

                    if (currentAxis === clickedAxis) {
                        enabledAxes[clickedAxis] = false;

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
                        _store.setState('cutting3d.activeAxis', clickedAxis);
                        createVisiblePlane(clickedAxis);
                        drag.isVisible = true;
                        updateVisibilityButton(visibilityBtn);
                    } else {
                        enabledAxes[clickedAxis] = true;
                        _store.setState('cutting3d.activeAxis', clickedAxis);

                        createVisiblePlane(clickedAxis);
                        drag.isVisible = true;
                        updateVisibilityButton(visibilityBtn);
                        applyClippingPlanes();
                    }

                    updateAxisUI(axisBtns, visibilityBtn);

                    if (invertBtn) {
                        const ax = _store.getState('cutting3d.activeAxis');
                        invertBtn.disabled = !ax;
                        invertBtn.classList.toggle('active', ax ? _store.getState('cutting3d.invertedAxes')[ax] : false);
                    }
                };
                btn.addEventListener('click', handler);
                _boundUIHandlers.push({ el: btn, type: 'click', handler });
            });

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

            if (resetBtn) {
                const handler = () => resetCutting(axisBtns, visibilityBtn);
                resetBtn.addEventListener('click', handler);
                _boundUIHandlers.push({ el: resetBtn, type: 'click', handler });
            }

            if (_store.getState('cutting3d.activeAxis')) {
                const axis = _store.getState('cutting3d.activeAxis');
                createVisiblePlane(axis);
                updateAxisUI(axisBtns, visibilityBtn);
                updateVisibilityButton(visibilityBtn);
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
