/**
 * Плагин «Перемещение»: 3D-гизмо для перемещения/поворота мешей с множественным
 * выбором, иерархическим выделением, точным вводом (Ф1), опусканием на пол,
 * поворотом на 90° и траекторией движения.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/TransformControls.js';
import PluginManager from '../plugin-system.js';

let scene, camera, renderer, controls, model;
let transformControls = null;
let selectedObjects = [];
let currentMode = 'translate';
let isDragging = false;
let showTrail = false;
let pivot = null;
let dragStartState = null;
let trailGroup = null;
let objectTrails = new Map();

const MAX_SEGMENTS_PER_OBJECT = 50;
const COLLINEARITY_SIN_THRESHOLD = 0.01;
const HIGHLIGHT_EMISSIVE = 0x1a3a6a;

let highlightState = new Map();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let _boundHandlers = [];
let _toolbarEl = null;      // скоуп-поиск кнопок панели вместо глобальных id
let _panelsContainer = null; // .plugin-panels — родитель для всплывающих панелей (как в view-display)
let _cleanedUp = false;     // защита от двойного вызова cleanup+destroy
let _originalTouchAction = '';
let _cameraMoved = false;
let _cameraMoveTimer = null;
let _initialCamPos = null;
let _initialCamTarget = null;
let originalStateSnapshot = null;
let _gizmoJustReleased = false;

let hierarchyRoot = null;
let hierarchyStack = [];
let originalSelection = null;
let hierarchyDirection = 'up';

let _floatingContainer = null;
// E6: обновление по событиям, без вечного rAF-поллинга
let _floatUpdatePending = false;      // коалисция нескольких событий в один кадр
let _floatWorldPos = null;            // переиспользуемый вектор (без аллокаций на событие)
let _floatDropEl = null;
let _floatRotEl = null;
// Фоновый режим: гизмо, траектория и подсветка выделения спрятаны onPause,
// чтобы не отвлекать поверх чужого плагина. Флаг отличает «спрятали мы» от
// «пользователь скрыл сам» и гарантирует возврат только того, что прятали.
// selectedObjects при этом НЕ чистится — выделение как данные переживает паузу,
// при onResume подсветка восстанавливается по этому списку.
let _visualsHiddenByPause = false;

// ============================================================
// Ф1: Точный ввод смещения / поворота
// Поля показывают смещение (мм) или угол (°) при перетаскивании гизмо;
// ручной ввод + Enter применяет значение по мировым осям.
// Единицы: UI=мм/градусы, сцена=метры (×1000). Порядок осей 'YXZ'.
// ============================================================
const PRECISE_STORAGE_KEY = 'transformGizmo.preciseInput';
const PRECISE_UNIT_LABEL = 'мм';
const PRECISE_MM_PER_UNIT = 1000; // glTF 2.0: 1 единица сцены = 1 метр
const PRECISE_DEG2RAD = Math.PI / 180;
const PRECISE_RAD2DEG = 180 / Math.PI;
const PRECISE_MAX_ABS = 1e6;   // санитарный предел ввода расстояния, мм
const PRECISE_MAX_DEG = 36000; // санитарный предел ввода угла, ° (100 оборотов)
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
let preciseMode = _readPreciseModeFlag();
let _precisePanelEl = null;
let _preciseInputs = null;   // { x, y, z } — поля ввода
let _preciseDistEl = null;   // итог «Расстояние» — длина вектора смещения
let _preciseUnitEl = null;   // подпись единицы в панели: «мм» или «°»
let _preciseLastDisplayed = { x: 0, y: 0, z: 0 }; // последние показанные значения (Esc — отмена правки)
let _preciseEditing = false; // фокус в поле ввода — живые обновления не затирают ручной ввод
let _preciseInvalidTimer = null;
// Применяются только dirty-поля: значения читout (прошлый жест) не повторяются.
let _preciseDirty = { x: false, y: false, z: false };

function _resetHierarchy() {
    hierarchyRoot = null;
    hierarchyStack = [];
    originalSelection = null;
    hierarchyDirection = 'up';
}

function _cleanup() {
    if (_cleanedUp) return;
    _cleanedUp = true;
    restoreOriginalState();
    _notifyModelTransformed();
    for (const { el, type, handler, opts } of _boundHandlers) {
        el.removeEventListener(type, handler, opts); // opts нужен capture-слушателям
    }
    _boundHandlers = [];
    destroyAll();
}

const HIERARCHY_ICON_UP = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M8 11V3m0 0L4 7m4-4l4 4"/><path d="M2 14h12"/></svg>`;
const HIERARCHY_ICON_DOWN = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M8 5v8m0 0l4-4m-4 4L4 9"/><path d="M2 2h12"/></svg>`;

function getSelectableMeshes() {
    const meshes = [];
    if (!model) return meshes;
    model.traverse(child => {
        if (!child.isMesh) return;
        // raycast не видит .visible===false — фильтруем по цепочке предков
        let cur = child;
        while (cur) {
            if (cur.visible === false) return;
            cur = cur.parent;
        }
        meshes.push(child);
    });
    return meshes;
}

/** Событие «модель сдвинута/повернута» — плагины с кэшами мировой геометрии сбрасывают кэши. */
function _notifyModelTransformed() {
    window.dispatchEvent(new CustomEvent('model-transformed'));
    _scheduleFloatingUpdate(); // E6: модель сдвинута — позиция кнопок изменилась
}

function setWorldPosition(obj, worldPos) {
    const parent = obj.parent;
    if (!parent) { obj.position.copy(worldPos); return; }
    obj.position.copy(parent.worldToLocal(worldPos.clone()));
}

function setWorldQuaternion(obj, worldQuat) {
    const parent = obj.parent;
    if (!parent) { obj.quaternion.copy(worldQuat); return; }
    const parentQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(parentQuat);
    obj.quaternion.copy(parentQuat.clone().invert().multiply(worldQuat));
}

function calculateScale() {
    if (!model) return 1;
    const bbox = new THREE.Box3().setFromObject(model);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim === 0) return 1;
    const dist = camera.position.distanceTo(controls.target);
    const baseScale = dist / 10;
    return Math.max(0.001, Math.min(baseScale, maxDim / 10));
}

function getTrailScale() {
    const scale = calculateScale();
    return Math.max(0.001, scale * 0.15);
}

function updateTrailVisuals() {
    const trailScale = getTrailScale();
    const dashSize = Math.max(0.01, trailScale * 0.5);
    const gapSize = Math.max(0.005, trailScale * 0.3);
    for (const [, trail] of objectTrails) {
        for (const line of trail.segmentLines) {
            line.material.dashSize = dashSize;
            line.material.gapSize = gapSize;
            line.material.needsUpdate = true;
            line.computeLineDistances();
        }
    }
}

function highlightObject(obj) {
    if (!obj.material || highlightState.has(obj)) return;
    const originals = Array.isArray(obj.material) ? [...obj.material] : obj.material;
    let swapped = false;
    if (Array.isArray(obj.material)) {
        obj.material = obj.material.map(m => {
            if (!m) return m;
            const clone = m.clone();
            if (clone.emissive) clone.emissive.setHex(HIGHLIGHT_EMISSIVE);
            return clone;
        });
        swapped = true;
    } else if (obj.material.emissive) {
        obj.material = obj.material.clone();
        obj.material.emissive.setHex(HIGHLIGHT_EMISSIVE);
        swapped = true;
    }
    if (!swapped) return;
    // КОНТРАКТ ВЛАДЕНИЯ МАТЕРИАЛАМИ: подмена пишется в стек userData.materialOwners,
    // владелец восстанавливает оригинал при снятии; порядок снятия подмен не критичен.
    const stack = obj.userData.materialOwners || (obj.userData.materialOwners = []);
    stack.push({ owner: 'transform-gizmo', saved: originals });
    highlightState.set(obj, {
        originalMaterials: originals,
        clonedMaterials: Array.isArray(obj.material) ? [...obj.material] : obj.material
    });
}

function unhighlightObject(obj) {
    if (!highlightState.has(obj)) return;
    const state = highlightState.get(obj);
    const cloned = Array.isArray(state.clonedMaterials) ? state.clonedMaterials : [state.clonedMaterials];
    for (const m of cloned) {
        if (m && typeof m.dispose === 'function') m.dispose();
    }
    // Возврат по контракту: только если наша подмена верхняя (LIFO), иначе чужой владелец вернёт свою.
    const stack = obj.userData?.materialOwners;
    const idx = stack ? stack.findIndex(e => e.owner === 'transform-gizmo') : -1;
    if (stack && idx !== -1) {
        if (idx === stack.length - 1) obj.material = state.originalMaterials;
        stack.splice(idx, 1);
        if (stack.length === 0) delete obj.userData.materialOwners;
    } else {
        obj.material = state.originalMaterials;
    }
    highlightState.delete(obj);
}

function toggleSelectObject(obj) {
    const idx = selectedObjects.indexOf(obj);
    if (idx !== -1) {
        selectedObjects.splice(idx, 1);
        unhighlightObject(obj);
    } else {
        selectedObjects.push(obj);
        highlightObject(obj);
    }
    _resetHierarchy();
    updateGizmoAttachment();
    updateSelectUpButton();
    updateSelectUpIcon();
    // Ф1: новое выделение — поля смещения с нуля, панель по правилам видимости
    if (preciseMode) resetPreciseFields();
    _updatePrecisePanel();
}

function clearSelection() {
    for (const obj of selectedObjects) {
        unhighlightObject(obj);
    }
    selectedObjects = [];
    _resetHierarchy();
    detachGizmo();
    updateSelectUpButton();
    updateSelectUpIcon();
    _scheduleFloatingUpdate(); // E6: выделение снято — прячем кнопки
    if (preciseMode) resetPreciseFields(); // Ф1
    _updatePrecisePanel();
}

function findCommonParent(objects) {
    if (objects.length === 0) return null;
    function getPathToRoot(obj) {
        const path = [];
        let node = obj;
        while (node) {
            path.unshift(node);
            node = node.parent;
        }
        return path;
    }
    const paths = objects.map(getPathToRoot);
    let lca = null;
    for (let i = 0; i < paths[0].length; i++) {
        const candidate = paths[0][i];
        if (paths.every(p => p[i] === candidate)) {
            lca = candidate;
        } else {
            break;
        }
    }
    if (!lca || lca === scene) {
        return scene;
    }
    return lca;
}

function updateGizmoAttachment() {
    if (selectedObjects.length === 0) {
        detachGizmo();
        return;
    }
    if (selectedObjects.length === 1) {
        removePivot();
        attachGizmoTo(selectedObjects[0]);
    } else {
        ensurePivot();
        const center = computeSelectionCenter();
        pivot.position.copy(center);
        pivot.quaternion.identity();
        attachGizmoTo(pivot);
    }
}

function computeSelectionCenter() {
    const center = new THREE.Vector3();
    for (const obj of selectedObjects) {
        const wp = new THREE.Vector3();
        obj.getWorldPosition(wp);
        center.add(wp);
    }
    center.divideScalar(selectedObjects.length);
    return center;
}

function attachGizmoTo(obj) {
    if (!transformControls) return;
    transformControls.attach(obj);
    transformControls.setMode(currentMode);
}

function detachGizmo() {
    if (transformControls) transformControls.detach();
    removePivot();
}

function ensurePivot() {
    if (pivot) return;
    pivot = new THREE.Object3D();
    pivot.name = 'transform_gizmo_pivot';
    scene.add(pivot);
}

function removePivot() {
    if (!pivot) return;
    if (transformControls && transformControls.object === pivot) {
        transformControls.detach();
    }
    scene.remove(pivot);
    pivot = null;
}

function onDraggingChanged(event) {
    controls.enabled = !event.value;
    isDragging = event.value;
    _scheduleFloatingUpdate(); // E6: начало драга прячет кнопки, конец — возвращает
    if (event.value) {
        saveDragStartState();
        // Ф1: новый жест — отсчёт с нуля, панель подсвечена (смещение и поворот)
        if (preciseMode) {
            resetPreciseFields();
            if (_precisePanelEl) _precisePanelEl.classList.add('dragging');
        }
    } else {
        if (dragStartState && showTrail && currentMode === 'translate') {
            updateTrailRealTime();
        }
        // Ф1: финальная величина остается в полях до следующего жеста
        if (preciseMode) {
            _updatePreciseFromDrag(); // вызов ДО сброса dragStartState
            if (_precisePanelEl) _precisePanelEl.classList.remove('dragging');
        }
        dragStartState = null;
        _gizmoJustReleased = true;
        // Флаг сбросится сам через 250 мс — иначе проглотится следующий легитимный клик
        setTimeout(() => { _gizmoJustReleased = false; }, 250);
        // Модель сдвинута — уведомляем плагины с кэшами мировой геометрии
        _notifyModelTransformed();
    }
}

function saveDragStartState() {
    if (selectedObjects.length === 0) return;
    const isPivotMode = selectedObjects.length > 1;
    const target = isPivotMode ? pivot : selectedObjects[0];
    dragStartState = {
        pivotPos: target.position.clone(),
        pivotQuat: target.quaternion.clone(),
        isPivotMode,
        objects: selectedObjects.map(obj => {
            const wp = new THREE.Vector3();
            const wq = new THREE.Quaternion();
            obj.getWorldPosition(wp);
            obj.getWorldQuaternion(wq);
            return { obj, pos: wp, quat: wq };
        })
    };
}

function onObjectChange() {
    if (!isDragging || !dragStartState) return;
    if (dragStartState.isPivotMode) {
        const target = pivot;
        const currentPos = target.position;
        const currentQuat = target.quaternion;
        const deltaPos = currentPos.clone().sub(dragStartState.pivotPos);
        const deltaQuat = currentQuat.clone().multiply(dragStartState.pivotQuat.clone().invert());
        for (const item of dragStartState.objects) {
            if (currentMode === 'translate') {
                const newWorldPos = item.pos.clone().add(deltaPos);
                setWorldPosition(item.obj, newWorldPos);
            } else if (currentMode === 'rotate') {
                const relPos = item.pos.clone().sub(dragStartState.pivotPos);
                relPos.applyQuaternion(deltaQuat);
                const newWorldPos = relPos.add(dragStartState.pivotPos);
                setWorldPosition(item.obj, newWorldPos);
                const newWorldQuat = deltaQuat.clone().multiply(item.quat);
                setWorldQuaternion(item.obj, newWorldQuat);
            }
        }
    }
    if (showTrail && currentMode === 'translate') {
        updateTrailRealTime();
    }
    updateTrailVisuals();
    // Ф1: живой читout величины смещения в панели точного ввода
    if (preciseMode) _updatePreciseFromDrag();
}

/**
 * Содержит ли узел меши вне выделения — проверка перед трансформацией
 * общего родителя: иначе двигаются/поворачиваются и невыбранные детали.
 */
function _canMoveCommonParent(parent) {
    if (!parent || parent === scene) return false;
    let allSelected = true;
    parent.traverse(child => {
        if (child.isMesh && !selectedObjects.includes(child)) allSelected = false;
    });
    return allSelected;
}

function updateTrailRealTime() {
    if (!dragStartState) return;
    const groups = new Map();
    const groupKey = hierarchyRoot || null;
    for (const item of dragStartState.objects) {
        const key = groupKey || (item.obj.parent || item.obj);
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(item);
    }
    for (const [key, items] of groups) {
        const startPos = new THREE.Vector3();
        for (const item of items) {
            startPos.add(item.pos);
        }
        startPos.divideScalar(items.length);
        const currentPos = new THREE.Vector3();
        for (const item of items) {
            const wp = new THREE.Vector3();
            item.obj.getWorldPosition(wp);
            currentPos.add(wp);
        }
        currentPos.divideScalar(items.length);
        let trail = objectTrails.get(key);
        if (!trail) {
            trail = createObjectTrail(startPos, currentPos);
            objectTrails.set(key, trail);
        } else {
            updateObjectTrail(trail, currentPos);
        }
    }
}

function createObjectTrail(startPos, currentPos) {
    const trail = {
        points: [startPos, currentPos],
        segmentLines: []
    };
    const segLine = createSegmentLine(startPos, currentPos);
    trail.segmentLines.push(segLine);
    trailGroup.add(segLine);
    return trail;
}

function updateObjectTrail(trail, newPos) {
    const points = trail.points;
    if (points.length < 2) return;
    const lastIdx = points.length - 1;
    const lastPoint = points[lastIdx];
    const prevPoint = points[lastIdx - 1];
    const lastSegVec = new THREE.Vector3().subVectors(lastPoint, prevPoint);
    const newVec = new THREE.Vector3().subVectors(newPos, lastPoint);
    const lastSegLen = lastSegVec.length();
    const newLen = newVec.length();
    if (newLen < 0.0001) return;
    let isCollinear = false;
    if (lastSegLen < 1e-6) {
        isCollinear = true;
    } else {
        const cross = new THREE.Vector3().crossVectors(lastSegVec, newVec);
        const sinAngle = cross.length() / (lastSegLen * newLen);
        isCollinear = sinAngle < COLLINEARITY_SIN_THRESHOLD;
    }
    if (isCollinear) {
        points[lastIdx].copy(newPos);
        updateSegmentLine(trail.segmentLines[lastIdx - 1], prevPoint, newPos);
    } else {
        if (trail.segmentLines.length >= MAX_SEGMENTS_PER_OBJECT) {
            mergeOldestSegment(trail);
        }
        const segLine = createSegmentLine(lastPoint, newPos);
        trail.segmentLines.push(segLine);
        trailGroup.add(segLine);
        points.push(newPos);
    }
}

function mergeOldestSegment(trail) {
    if (trail.segmentLines.length < 2) return;
    const oldLine = trail.segmentLines.shift();
    trailGroup.remove(oldLine);
    oldLine.geometry.dispose();
    oldLine.material.dispose();
    trail.points.shift();
}

function createSegmentLine(from, to) {
    const trailScale = getTrailScale();
    const dashSize = Math.max(0.01, trailScale * 0.5);
    const gapSize = Math.max(0.005, trailScale * 0.3);
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = new THREE.LineDashedMaterial({
        color: 0xa29bfe,
        dashSize: dashSize,
        gapSize: gapSize,
        transparent: true,
        opacity: 0.8,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    return line;
}

function updateSegmentLine(line, from, to) {
    const positions = line.geometry.attributes.position.array;
    positions[0] = from.x; positions[1] = from.y; positions[2] = from.z;
    positions[3] = to.x; positions[4] = to.y; positions[5] = to.z;
    line.geometry.attributes.position.needsUpdate = true;
    line.computeLineDistances();
}

function disposeObjectTrail(trail) {
    for (const line of trail.segmentLines) {
        trailGroup.remove(line);
        line.geometry.dispose();
        line.material.dispose();
    }
}

function clearTrail() {
    for (const [, trail] of objectTrails) {
        disposeObjectTrail(trail);
    }
    objectTrails.clear();
}

function updateModeButtons() {
    const moveBtn = _btnById('gizmo-move-btn');
    const rotBtn = _btnById('gizmo-rotate-btn');
    if (moveBtn) moveBtn.classList.toggle('active', currentMode === 'translate');
    if (rotBtn) rotBtn.classList.toggle('active', currentMode === 'rotate');
}

function updateTrailButton() {
    const btn = _btnById('gizmo-trail-btn');
    if (btn) btn.classList.toggle('active', showTrail);
}

function updateSelectUpButton() {
    const btn = _btnById('gizmo-select-up-btn');
    if (btn) btn.classList.toggle('active', !!hierarchyRoot);
}

function updateSelectUpIcon() {
    const btn = _btnById('gizmo-select-up-btn');
    if (!btn) return;
    const isDown = hierarchyDirection === 'down';
    btn.innerHTML = isDown ? HIERARCHY_ICON_DOWN : HIERARCHY_ICON_UP;
    btn.title = isDown ? 'Сузить выделение' : 'Выделить родителя';
}

/** Скоуп-поиск кнопки: сначала внутри своей панели инструментов, затем
 * глобально (защита от конкуренции id с 200-мс удалением старого тулбара). */
function _btnById(id) {
    if (_toolbarEl) {
        const scoped = _toolbarEl.querySelector('#' + id);
        if (scoped) return scoped;
    }
    return document.getElementById(id);
}

function applyHierarchySelection() {
    for (const obj of selectedObjects) unhighlightObject(obj);
    selectedObjects = [];
    hierarchyRoot.traverse(child => {
        if (child.isMesh) {
            selectedObjects.push(child);
            highlightObject(child);
        }
    });
    updateGizmoAttachment();
    updateSelectUpButton();
    updateSelectUpIcon();
    _scheduleFloatingUpdate(); // E6: выделение изменилось — позиция/видимость кнопок
    if (preciseMode) resetPreciseFields(); // Ф1: иерархия сменилась — отсчет заново
    _updatePrecisePanel();
}

function goDownHierarchy() {
    if (hierarchyStack.length > 0) {
        hierarchyRoot = hierarchyStack.pop();
        applyHierarchySelection();
    } else if (originalSelection) {
        for (const obj of selectedObjects) unhighlightObject(obj);
        selectedObjects = [...originalSelection];
        for (const obj of selectedObjects) highlightObject(obj);
        _resetHierarchy();
        updateGizmoAttachment();
        updateSelectUpButton();
        updateSelectUpIcon();
    }
}

function selectUpHierarchy() {
    if (selectedObjects.length === 0) return;
    if (hierarchyDirection === 'down') {
        goDownHierarchy();
        return;
    }
    const startNode = hierarchyRoot || selectedObjects[0];
    let targetParent = startNode.parent;
    while (targetParent && targetParent !== scene) {
        let meshCount = 0;
        targetParent.traverse(child => { if (child.isMesh) meshCount++; });
        if (meshCount > selectedObjects.length) break;
        targetParent = targetParent.parent;
    }
    if (!targetParent || targetParent === scene) {
        hierarchyDirection = 'down';
        goDownHierarchy();
        return;
    }
    if (!hierarchyRoot && !originalSelection) {
        originalSelection = [...selectedObjects];
    }
    if (hierarchyRoot) {
        hierarchyStack.push(hierarchyRoot);
    }
    hierarchyRoot = targetParent;
    applyHierarchySelection();
}

// --- Floating action buttons above gizmo ---
function _floatBtnBaseStyle() {
    return 'pointer-events:auto;width:30px;height:30px;border:none;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;background:rgba(20,22,30,0.88);color:rgba(255,255,255,0.9);box-shadow:0 2px 8px rgba(0,0,0,0.35);transition:background 0.15s;font-family:inherit;outline:none;';
}

function _createFloatingButtons() {
    _floatingContainer = document.createElement('div');
    _floatingContainer.style.cssText = 'position:fixed;pointer-events:none;z-index:1000;display:flex;gap:5px;transform:translate(-50%,calc(-100% - 100px));opacity:0;';
    const dropBtn = document.createElement('button');
    dropBtn.id = 'gizmo-float-drop';
    dropBtn.title = 'Опустить на пол';
    dropBtn.style.cssText = _floatBtnBaseStyle();
    dropBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 2v9m0 0L5 7.5M8 11l3-3.5"/><path d="M2 14h12"/></svg>';
    const dropHandler = () => dropToFloor();
    dropBtn.addEventListener('click', dropHandler);
    _boundHandlers.push({ el: dropBtn, type: 'click', handler: dropHandler });
    _floatingContainer.appendChild(dropBtn);
    const rotGroup = document.createElement('div');
    rotGroup.id = 'gizmo-float-rot';
    rotGroup.style.cssText = 'display:none;gap:5px;';
    const axes = [
        { key: 'x', label: 'X', color: '#ef4444' },
        { key: 'y', label: 'Y', color: '#22c55e' },
        { key: 'z', label: 'Z', color: '#3b82f6' },
    ];
    for (const { key, label, color } of axes) {
        const btn = document.createElement('button');
        btn.className = 'gizmo-float-btn';
        btn.title = `Повернуть 90\u00B0 по ${label}`;
        btn.style.cssText = _floatBtnBaseStyle() + `color:${color};font-size:13px;font-weight:700;`;
        btn.textContent = label;
        const h = () => rotateBy90(key);
        btn.addEventListener('click', h);
        _boundHandlers.push({ el: btn, type: 'click', handler: h });
        rotGroup.appendChild(btn);
    }
    _floatingContainer.appendChild(rotGroup);
    _floatDropEl = dropBtn;
    _floatRotEl = rotGroup;
    document.body.appendChild(_floatingContainer);
    _floatWorldPos = new THREE.Vector3();
    // E6: обновления — событийные через _scheduleFloatingUpdate, без вечного rAF.
}

function _hideFloatingButtons() {
    if (!_floatingContainer) return;
    _floatingContainer.style.opacity = '0';
    _floatingContainer.style.pointerEvents = 'none';
}

/** E6: обновление позиции/видимости плавающих кнопок (вместо вечного rAF-поллинга). */
function _updateFloatingButtons() {
    // Ф1: панель точного ввода обновляется по тем же событиям, но живет
    // по своим правилам видимости (не зависит от камеры/драга)
    if (_precisePanelEl) _updatePrecisePanel();
    if (!_floatingContainer || !transformControls) return;
    const gizmoObj = transformControls.object;
    // Фоновый режим: контейнер живёт в document.body вне оверлей-трекинга
    // plugin-system — скрываем и деактивируем клики по общему контракту
    if (PluginManager.isPluginPaused('transform-gizmo') ||
        !gizmoObj || selectedObjects.length === 0 || isDragging) {
        _hideFloatingButtons();
        return;
    }
    // Свежие матрицы: событие приходит между кадрами рендера
    gizmoObj.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    const projected = gizmoObj.getWorldPosition(_floatWorldPos).project(camera);
    if (projected.z > 1) {
        _hideFloatingButtons(); // pointerEvents: none — невидимые кнопки не ловят клики позади камеры
        return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    _floatingContainer.style.left = ((projected.x * 0.5 + 0.5) * rect.width + rect.left) + 'px';
    _floatingContainer.style.top = ((-projected.y * 0.5 + 0.5) * rect.height + rect.top) + 'px';
    _floatingContainer.style.opacity = '1';
    _floatingContainer.style.pointerEvents = 'auto';
    if (_floatDropEl) _floatDropEl.style.display = currentMode === 'translate' ? 'flex' : 'none';
    if (_floatRotEl) _floatRotEl.style.display = currentMode === 'rotate' ? 'flex' : 'none';
}

/** Коалисция событий в один кадр: несколько 'change' подряд → одно обновление. */
function _scheduleFloatingUpdate() {
    if (_floatUpdatePending) return;
    _floatUpdatePending = true;
    requestAnimationFrame(() => {
        _floatUpdatePending = false;
        _updateFloatingButtons();
    });
}

/** E6: ловим переход активный/фоновый — capture + setTimeout(0) ждёт обработки клика менеджером. */
function _onDocClickCapture() {
    setTimeout(() => {
        if (!_floatingContainer) return;
        if (PluginManager.isPluginPaused('transform-gizmo')) {
            _hideFloatingButtons();
        } else if (selectedObjects.length > 0 && transformControls?.object) {
            _scheduleFloatingUpdate();
        }
    }, 0);
}

function _destroyFloatingButtons() {
    if (_floatingContainer && _floatingContainer.parentElement) {
        _floatingContainer.parentElement.removeChild(_floatingContainer);
    }
    _floatingContainer = null;
    _floatDropEl = null;
    _floatRotEl = null;
    _floatWorldPos = null;
    _floatUpdatePending = false;
}

function dropToFloor() {
    if (selectedObjects.length === 0) return;
    const selBBox = new THREE.Box3();
    for (const obj of selectedObjects) selBBox.expandByObject(obj);
    const bottomY = selBBox.min.y;
    let targetY = model ? new THREE.Box3().setFromObject(model).min.y : 0;
    const nonSelected = getSelectableMeshes().filter(m => !selectedObjects.includes(m));
    for (const mesh of nonSelected) {
        const mb = new THREE.Box3().setFromObject(mesh);
        if (mb.max.x >= selBBox.min.x && mb.min.x <= selBBox.max.x &&
            mb.max.z >= selBBox.min.z && mb.min.z <= selBBox.max.z &&
            mb.max.y <= bottomY) {
            targetY = Math.max(targetY, mb.max.y);
        }
    }
    const delta = bottomY - targetY;
    if (delta <= 0.001) return;
    // Общего родителя двигаем только если под ним нет невыбранных мешей —
    // иначе опускаются и нетронутые детали
    const commonParent = selectedObjects.length > 1 ? findCommonParent(selectedObjects) : null;
    if (commonParent && _canMoveCommonParent(commonParent)) {
        const wp = new THREE.Vector3();
        commonParent.getWorldPosition(wp);
        wp.y -= delta;
        setWorldPosition(commonParent, wp);
    } else {
        for (const obj of selectedObjects) {
            const wp = new THREE.Vector3();
            obj.getWorldPosition(wp);
            wp.y -= delta;
            setWorldPosition(obj, wp);
        }
        if (pivot) pivot.position.y -= delta;
    }
    updateGizmoAttachment();
    _notifyModelTransformed();
    if (preciseMode) resetPreciseFields(); // Ф1: позиция изменилась вне жеста — поля обнуляем
}

// --- Local CS alignment helpers ---
function _snapAxis(v) {
    const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
    if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(v.x), 0, 0);
    if (ay >= ax && ay >= az) return new THREE.Vector3(0, Math.sign(v.y), 0);
    return new THREE.Vector3(0, 0, Math.sign(v.z));
}

function _isAlignedToWorld(quat, threshold) {
    threshold = threshold || 0.02;
    const m = new THREE.Matrix4().makeRotationFromQuaternion(quat);
    for (let i = 0; i < 3; i++) {
        const v = new THREE.Vector3().setFromMatrixColumn(m, i);
        const comps = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)].sort((a, b) => b - a);
        if (comps[0] < 1 - threshold || comps[1] > threshold) return false;
    }
    return true;
}

function _snapToWorld(quat) {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(quat);
    const sx = _snapAxis(new THREE.Vector3().setFromMatrixColumn(m, 0));
    const sy = _snapAxis(new THREE.Vector3().setFromMatrixColumn(m, 1));
    const sz = _snapAxis(new THREE.Vector3().setFromMatrixColumn(m, 2));
    const testZ = new THREE.Vector3().crossVectors(sx, sy);
    if (testZ.dot(sz) < 0) sy.negate();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(sx, sy, sz));
}

function rotateBy90(axis) {
    if (selectedObjects.length === 0) return;
    const axisVec = new THREE.Vector3(
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0
    );
    // Общего родителя вращаем только если под ним нет невыбранных мешей —
    // иначе поворачиваются и нетронутые детали
    const commonParent = selectedObjects.length > 1 ? findCommonParent(selectedObjects) : null;
    if (commonParent && _canMoveCommonParent(commonParent)) {
        const wq = new THREE.Quaternion();
        commonParent.getWorldQuaternion(wq);
        const wp = new THREE.Vector3();
        commonParent.getWorldPosition(wp);
        const center = computeSelectionCenter();
        const needsSnap = !_isAlignedToWorld(wq);
        let newQuat, rotQuat;
        if (needsSnap) {
            newQuat = _snapToWorld(wq);
            rotQuat = newQuat.clone().multiply(wq.clone().invert());
        } else {
            rotQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, Math.PI / 2);
            newQuat = rotQuat.clone().multiply(wq);
        }
        const newParentPos = wp.clone().sub(center).applyQuaternion(rotQuat).add(center);
        setWorldPosition(commonParent, newParentPos);
        setWorldQuaternion(commonParent, newQuat);
        updateGizmoAttachment();
        _notifyModelTransformed();
        if (preciseMode) resetPreciseFields(); // Ф1
        return;
    }
    const center = new THREE.Vector3();
    if (pivot) {
        pivot.getWorldPosition(center);
    } else if (selectedObjects.length === 1) {
        selectedObjects[0].getWorldPosition(center);
    } else {
        center.copy(computeSelectionCenter());
    }
    const firstQuat = new THREE.Quaternion();
    selectedObjects[0].getWorldQuaternion(firstQuat);
    const needsSnap = !_isAlignedToWorld(firstQuat);
    for (const obj of selectedObjects) {
        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        obj.getWorldPosition(wp);
        obj.getWorldQuaternion(wq);
        if (needsSnap) {
            setWorldQuaternion(obj, _snapToWorld(wq));
        } else {
            const rot = new THREE.Quaternion().setFromAxisAngle(axisVec, Math.PI / 2);
            const rel = wp.clone().sub(center).applyQuaternion(rot);
            setWorldPosition(obj, rel.add(center));
            setWorldQuaternion(obj, rot.clone().multiply(wq));
        }
    }
    updateGizmoAttachment();
    _notifyModelTransformed();
    if (preciseMode) resetPreciseFields(); // Ф1
}

function setMode(mode) {
    const changed = currentMode !== mode;
    currentMode = mode;
    if (transformControls) transformControls.setMode(mode);
    updateModeButtons();
    _scheduleFloatingUpdate(); // E6: видимость групп Drop/Rotate зависит от режима
    if (changed) resetPreciseFields(); // Ф1: сменилась семантика полей (мм ↔ °)
    _syncPrecisePanelMode(); // Ф1: единицы/тултипы панели под текущий режим
    _updatePrecisePanel(); // Ф1: панель — в режимах «Перемещение» и «Поворот»
}

function toggleTrail() {
    showTrail = !showTrail;
    if (trailGroup) trailGroup.visible = showTrail;
    updateTrailButton();
    if (showTrail) updateTrailVisuals();
}

// ============================================================
// Ф1: Точный ввод смещения / поворота — панель над док-панелью.
// ============================================================

function _readPreciseModeFlag() {
    try {
        return localStorage.getItem(PRECISE_STORAGE_KEY) === '1';
    } catch (e) {
        return false;
    }
}

function updatePreciseButton() {
    const btn = _btnById('gizmo-precise-btn');
    if (btn) btn.classList.toggle('active', preciseMode);
}

function togglePreciseMode() {
    preciseMode = !preciseMode;
    try {
        localStorage.setItem(PRECISE_STORAGE_KEY, preciseMode ? '1' : '0');
    } catch (e) { /* приватный режим — просто не сохраняем */ }
    updatePreciseButton();
    if (preciseMode) resetPreciseFields();
    _syncPrecisePanelMode(); // Ф1: панель могла создаться/жить в другом режиме гизмо
    _updatePrecisePanel();
}

/** Форматирование величины: до 2 знаков, без хвостовых нулей и «-0». */
function _fmtPrecise(v) {
    if (!isFinite(v)) return '0';
    if (Math.abs(v) < 0.005) v = 0;
    return String(Math.round(v * 100) / 100);
}

/** Парсинг ввода: точка и запятая равнозначны, пробелы игнорируются. */
function _parsePrecise(str) {
    const s = String(str).trim().replace(/\s+/g, '').replace(',', '.');
    if (s === '' || s === '-' || s === '.') return NaN;
    const v = Number(s);
    return isFinite(v) ? v : NaN;
}

/** Запись значений в поля (поле в фокусе не трогаем) и итог «Расстояние». */
function setPreciseFields(dx, dy, dz) {
    _preciseLastDisplayed = { x: dx, y: dy, z: dz };
    if (_preciseInputs) {
        if (document.activeElement !== _preciseInputs.x) _preciseInputs.x.value = _fmtPrecise(dx);
        if (document.activeElement !== _preciseInputs.y) _preciseInputs.y.value = _fmtPrecise(dy);
        if (document.activeElement !== _preciseInputs.z) _preciseInputs.z.value = _fmtPrecise(dz);
    }
    if (_preciseDistEl) {
        _preciseDistEl.textContent = _fmtPrecise(Math.hypot(dx, dy, dz));
    }
}

function resetPreciseFields() {
    setPreciseFields(0, 0, 0);
    _resetPreciseDirty(); // новый жест/выделение — прежний ввод аннулируется
}

/** Живой читout при перетаскивании: среднее смещение выделения (мм) или дельта-угол (°) относительно начала жеста. */
function _updatePreciseFromDrag() {
    if (!preciseMode || !dragStartState || dragStartState.objects.length === 0) return;
    if (currentMode === 'translate') {
        const tmp = new THREE.Vector3();
        let dx = 0, dy = 0, dz = 0;
        for (const item of dragStartState.objects) {
            item.obj.getWorldPosition(tmp);
            dx += tmp.x - item.pos.x;
            dy += tmp.y - item.pos.y;
            dz += tmp.z - item.pos.z;
        }
        const n = dragStartState.objects.length;
        setPreciseFields(
            (dx / n) * PRECISE_MM_PER_UNIT,
            (dy / n) * PRECISE_MM_PER_UNIT,
            (dz / n) * PRECISE_MM_PER_UNIT
        );
    } else if (currentMode === 'rotate') {
        // Стартовый кватернион: пивот — ребёнок сцены (локальный = мировому), одиночный — dragStartState.objects[0].quat.
        let startQuat, curObj;
        if (dragStartState.isPivotMode) {
            if (!pivot) return;
            curObj = pivot;
            startQuat = dragStartState.pivotQuat;
        } else {
            curObj = dragStartState.objects[0].obj;
            startQuat = dragStartState.objects[0].quat;
        }
        const curQuat = new THREE.Quaternion();
        curObj.getWorldQuaternion(curQuat);
        const delta = curQuat.multiply(startQuat.clone().invert());
        // 'YXZ': Y/Z — ±180°, средняя ось X — ±90° (без branch-переключений).
        const eul = new THREE.Euler().setFromQuaternion(delta, 'YXZ');
        setPreciseFields(
            eul.x * PRECISE_RAD2DEG,
            eul.y * PRECISE_RAD2DEG,
            eul.z * PRECISE_RAD2DEG
        );
    }
}

/** Применяет введённое смещение (мм → м) по мировым осям; только dirty-поля, после — показ применённой величины. */
function applyPreciseMove() {
    if (!preciseMode || selectedObjects.length === 0 || !_preciseInputs) return;
    const dx = _preciseDirty.x ? _parsePrecise(_preciseInputs.x.value) : 0;
    const dy = _preciseDirty.y ? _parsePrecise(_preciseInputs.y.value) : 0;
    const dz = _preciseDirty.z ? _parsePrecise(_preciseInputs.z.value) : 0;
    if (!isFinite(dx) || !isFinite(dy) || !isFinite(dz)) {
        _flashPreciseInvalid();
        return;
    }
    const clamp = (v) => Math.max(-PRECISE_MAX_ABS, Math.min(PRECISE_MAX_ABS, v));
    const DX = clamp(dx), DY = clamp(dy), DZ = clamp(dz);
    if (DX === 0 && DY === 0 && DZ === 0) return; // ничего не введено / нулевое смещение
    const delta = new THREE.Vector3(
        DX / PRECISE_MM_PER_UNIT,
        DY / PRECISE_MM_PER_UNIT,
        DZ / PRECISE_MM_PER_UNIT
    );
    for (const obj of selectedObjects) {
        const wp = new THREE.Vector3();
        obj.getWorldPosition(wp);
        setWorldPosition(obj, wp.add(delta));
    }
    // Пивот (мультивыделение) следует за выделением; updateGizmoAttachment
    // пересчитает его центр по фактическим позициям мешей
    if (pivot) pivot.position.add(delta);
    updateGizmoAttachment();
    setPreciseFields(DX, DY, DZ);
    _resetPreciseDirty(); // введённое применено — следующий ввод считается заново
    // Модель сдвинута — контракты: кэши мировой геометрии плагинов + плавающие кнопки
    _notifyModelTransformed();
}

/** Применяет поворот на введённые углы (°) вокруг мировых X/Y/Z; R = Ry·Rx·Rz (как в читout 'YXZ'), вокруг точки гизмо. */
function applyPreciseRotate() {
    if (!preciseMode || selectedObjects.length === 0 || !_preciseInputs) return;
    const rx = _preciseDirty.x ? _parsePrecise(_preciseInputs.x.value) : 0;
    const ry = _preciseDirty.y ? _parsePrecise(_preciseInputs.y.value) : 0;
    const rz = _preciseDirty.z ? _parsePrecise(_preciseInputs.z.value) : 0;
    if (!isFinite(rx) || !isFinite(ry) || !isFinite(rz)) {
        _flashPreciseInvalid();
        return;
    }
    const clampDeg = (v) => Math.max(-PRECISE_MAX_DEG, Math.min(PRECISE_MAX_DEG, v));
    const RX = clampDeg(rx), RY = clampDeg(ry), RZ = clampDeg(rz);
    if (RX === 0 && RY === 0 && RZ === 0) return; // ничего не введено / нулевой поворот
    const deltaQuat = new THREE.Quaternion()
        .setFromAxisAngle(AXIS_Y, RY * PRECISE_DEG2RAD);
    deltaQuat.multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, RX * PRECISE_DEG2RAD));
    deltaQuat.multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Z, RZ * PRECISE_DEG2RAD));
    // Точка вращения — как у гизмо
    const center = new THREE.Vector3();
    if (pivot) {
        pivot.getWorldPosition(center);
    } else if (selectedObjects.length === 1) {
        selectedObjects[0].getWorldPosition(center);
    } else {
        center.copy(computeSelectionCenter());
    }
    for (const obj of selectedObjects) {
        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        obj.getWorldPosition(wp);
        obj.getWorldQuaternion(wq);
        const rel = wp.clone().sub(center).applyQuaternion(deltaQuat).add(center);
        setWorldPosition(obj, rel);
        setWorldQuaternion(obj, deltaQuat.clone().multiply(wq));
    }
    updateGizmoAttachment();
    setPreciseFields(RX, RY, RZ);
    _resetPreciseDirty(); // введённое применено — следующий ввод считается заново
    _notifyModelTransformed();
}

/** Enter / кнопка «✓»: диспетчеризация по режиму гизмо. */
function applyPreciseInput() {
    if (currentMode === 'rotate') applyPreciseRotate();
    else applyPreciseMove();
}

function _resetPreciseDirty() {
    _preciseDirty.x = false;
    _preciseDirty.y = false;
    _preciseDirty.z = false;
}

/** Класс невалидного ввода вешается на обёртку-лейбл (её стилизует CSS). */
function _setPreciseFieldInvalid(inp, on) {
    const wrap = inp.closest('.gizmo-precise-field') || inp;
    wrap.classList.toggle('invalid', on);
}

function _flashPreciseInvalid() {
    if (!_preciseInputs) return;
    for (const key of ['x', 'y', 'z']) {
        const inp = _preciseInputs[key];
        if (!isFinite(_parsePrecise(inp.value))) _setPreciseFieldInvalid(inp, true);
    }
    if (_preciseInvalidTimer) clearTimeout(_preciseInvalidTimer);
    _preciseInvalidTimer = setTimeout(() => {
        _preciseInvalidTimer = null;
        if (!_preciseInputs) return;
        for (const key of ['x', 'y', 'z']) _setPreciseFieldInvalid(_preciseInputs[key], false);
    }, 900);
}

/** Esc — отмена правки: копия значений → blur активного поля → форс-запись по копии. */
function _cancelPreciseEdit() {
    const restore = { ..._preciseLastDisplayed };
    const active = document.activeElement;
    if (active && active !== document.body && _precisePanelEl?.contains(active)) {
        active.blur();
    }
    _preciseLastDisplayed = restore; // blur мог подменить значения — вераем копию
    setPreciseFields(restore.x, restore.y, restore.z);
}

/** Blur: валидный ввод нормализуем (запятая → точка, clamp по режиму), невалидный — откатываем. */
function _finalizePreciseField(inp, axis) {
    _setPreciseFieldInvalid(inp, false);
    const v = _parsePrecise(inp.value);
    if (isFinite(v)) {
        const maxAbs = currentMode === 'rotate' ? PRECISE_MAX_DEG : PRECISE_MAX_ABS;
        const c = Math.max(-maxAbs, Math.min(maxAbs, v));
        inp.value = _fmtPrecise(c);
        _preciseLastDisplayed[axis] = c;
    } else {
        inp.value = _fmtPrecise(_preciseLastDisplayed[axis]);
    }
}

/** Видимость панели: режим включён + есть выделение + не в фоне (в драге — остаётся видимой). */
function _updatePrecisePanel() {
    if (!_precisePanelEl) return;
    const show = preciseMode
        && (currentMode === 'translate' || currentMode === 'rotate')
        && selectedObjects.length > 0
        && !!transformControls?.object
        && !PluginManager.isPluginPaused('transform-gizmo');
    _precisePanelEl.classList.toggle('visible', show);
    _precisePanelEl.style.pointerEvents = show ? 'auto' : 'none';
    if (!show) _precisePanelEl.classList.remove('dragging');
}

/** Синхронизация панели с режимом гизмо: единица («мм»/«°»), тултипы.
 * Вызывается из setMode/togglePreciseMode/создания панели. */
function _syncPrecisePanelMode() {
    if (!_precisePanelEl) return;
    const rot = currentMode === 'rotate';
    _precisePanelEl.dataset.mode = rot ? 'rotate' : 'translate';
    if (_preciseUnitEl) _preciseUnitEl.textContent = rot ? '°' : PRECISE_UNIT_LABEL;
    const titleEl = _precisePanelEl.querySelector('.gizmo-precise-title');
    if (titleEl) {
        titleEl.title = rot
            ? 'Точный ввод: введите углы поворота вокруг мировых осей (в градусах) и нажмите Enter. При перетаскивании гизмо поля показывают угол поворота.'
            : 'Точный ввод: введите смещение по осям (в мм) и нажмите Enter. При перетаскивании гизмо поля показывают величину смещения.';
    }
    const distEl = _precisePanelEl.querySelector('.gizmo-precise-dist');
    if (distEl) distEl.title = rot ? 'Суммарная величина поворота' : 'Суммарная величина смещения';
    for (const axis of ['x', 'y', 'z']) {
        const wrap = _precisePanelEl.querySelector('.axis-' + axis);
        if (!wrap) continue;
        wrap.title = rot
            ? `Поворот вокруг оси ${axis.toUpperCase()}, градусы`
            : `Смещение по оси ${axis.toUpperCase()}, мм`;
        const inp = wrap.querySelector('input');
        if (inp) {
            inp.setAttribute('aria-label', rot
                ? `Поворот вокруг оси ${axis.toUpperCase()}`
                : `Смещение по оси ${axis.toUpperCase()}`);
        }
    }
    const applyBtn = _precisePanelEl.querySelector('.gizmo-precise-apply');
    if (applyBtn) {
        applyBtn.title = rot ? 'Применить поворот (Enter)' : 'Применить смещение (Enter)';
        applyBtn.setAttribute('aria-label', rot ? 'Применить поворот' : 'Применить смещение');
    }
}

function _createPrecisePanel() {
    _precisePanelEl = document.createElement('div');
    _precisePanelEl.id = 'gizmo-precise-panel';
    _precisePanelEl.className = 'gizmo-precise-panel';
    _precisePanelEl.dataset.mode = currentMode; // 'translate' | 'rotate'
    _precisePanelEl.innerHTML = `
        <div class="gizmo-precise-head">
            <span class="gizmo-precise-title"
                  title="Точный ввод: введите значения и нажмите Enter. При перетаскивании гизмо поля показывают величину смещения/угла.">Точный ввод</span>
            <span class="gizmo-precise-dist" title="Суммарная величина"><b id="gizmo-precise-dist">0</b><i class="gizmo-precise-unit">${PRECISE_UNIT_LABEL}</i></span>
        </div>
        <div class="gizmo-precise-fields">
            <label class="gizmo-precise-field axis-x" title="Смещение по оси X, ${PRECISE_UNIT_LABEL}">
                <span>X</span>
                <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="0" aria-label="Смещение по X">
            </label>
            <label class="gizmo-precise-field axis-y" title="Смещение по оси Y, ${PRECISE_UNIT_LABEL}">
                <span>Y</span>
                <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="0" aria-label="Смещение по Y">
            </label>
            <label class="gizmo-precise-field axis-z" title="Смещение по оси Z, ${PRECISE_UNIT_LABEL}">
                <span>Z</span>
                <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="0" aria-label="Смещение по Z">
            </label>
            <button type="button" class="gizmo-precise-apply" title="Применить (Enter)" aria-label="Применить">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M2.5 8.5l3.5 3.5 7.5-8.5"/></svg>
            </button>
        </div>`;
    // Привязка к .plugin-panels (как vd-sun-panel в view-display): панель живёт
    // внутри контейнера плагина, позиционируется над тулбаром, а не в document.body.
    const container = _panelsContainer
        || document.querySelector('.plugin-panels')
        || document.getElementById('model-container')
        || document.body;
    container.appendChild(_precisePanelEl);
    _preciseInputs = {
        x: _precisePanelEl.querySelector('.axis-x input'),
        y: _precisePanelEl.querySelector('.axis-y input'),
        z: _precisePanelEl.querySelector('.axis-z input'),
    };
    _preciseDistEl = _precisePanelEl.querySelector('#gizmo-precise-dist');
    _preciseUnitEl = _precisePanelEl.querySelector('.gizmo-precise-unit');
    _syncPrecisePanelMode(); // тултипы/единицы под актуальный режим гизмо

    for (const axis of ['x', 'y', 'z']) {
        const inp = _preciseInputs[axis];
        const onFocus = () => {
            _preciseEditing = true;
            _setPreciseFieldInvalid(inp, false);
            inp.select();
        };
        const onInput = () => {
            _preciseDirty[axis] = true; // пользователь ввёл значение — подлежит применению
            _setPreciseFieldInvalid(inp, false);
        };
        const onBlur = () => {
            _preciseEditing = false;
            _finalizePreciseField(inp, axis);
        };
        const onKeyDown = (e) => {
            // Не отдаём нажатия наружу — глобальные хоткеи не срабатывают в поле
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                applyPreciseInput(); // смещение (мм) или поворот (°) — по режиму
                inp.select();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                _cancelPreciseEdit();
            }
        };
        inp.addEventListener('focus', onFocus);
        inp.addEventListener('input', onInput);
        inp.addEventListener('blur', onBlur);
        inp.addEventListener('keydown', onKeyDown);
        _boundHandlers.push({ el: inp, type: 'focus', handler: onFocus });
        _boundHandlers.push({ el: inp, type: 'input', handler: onInput });
        _boundHandlers.push({ el: inp, type: 'blur', handler: onBlur });
        _boundHandlers.push({ el: inp, type: 'keydown', handler: onKeyDown });
    }

    const applyBtn = _precisePanelEl.querySelector('.gizmo-precise-apply');
    const applyHandler = (e) => {
        e.preventDefault();
        applyPreciseInput(); // смещение (мм) или поворот (°) — по режиму
    };
    applyBtn.addEventListener('click', applyHandler);
    _boundHandlers.push({ el: applyBtn, type: 'click', handler: applyHandler });
}

function _destroyPrecisePanel() {
    if (_preciseInvalidTimer) {
        clearTimeout(_preciseInvalidTimer);
        _preciseInvalidTimer = null;
    }
    if (_precisePanelEl && _precisePanelEl.parentElement) {
        _precisePanelEl.parentElement.removeChild(_precisePanelEl);
    }
    _precisePanelEl = null;
    _preciseInputs = null;
    _preciseDistEl = null;
    _preciseUnitEl = null;
    _preciseEditing = false;
}

function saveOriginalStateSnapshot() {
    if (!model) return;
    const snapshot = [];
    model.traverse(child => {
        if (child.isMesh) {
            const wp = new THREE.Vector3();
            const wq = new THREE.Quaternion();
            const ws = new THREE.Vector3();
            child.getWorldPosition(wp);
            child.getWorldQuaternion(wq);
            child.getWorldScale(ws);
            snapshot.push({
                obj: child,
                position: wp,
                quaternion: wq,
                scale: ws
            });
        }
    });
    originalStateSnapshot = snapshot;
}

function restoreOriginalState() {
    if (!originalStateSnapshot) return;
    for (const item of originalStateSnapshot) {
        setWorldPosition(item.obj, item.position);
        setWorldQuaternion(item.obj, item.quaternion);
        const parent = item.obj.parent;
        if (!parent) {
            item.obj.scale.copy(item.scale);
        } else {
            const parentScale = new THREE.Vector3();
            parent.getWorldScale(parentScale);
            item.obj.scale.set(
                item.scale.x / parentScale.x,
                item.scale.y / parentScale.y,
                item.scale.z / parentScale.z
            );
        }
    }
}

function resetAll() {
    restoreOriginalState();
    _notifyModelTransformed();
    clearSelection();
    clearTrail();
    showTrail = false;
    _resetHierarchy();
    if (trailGroup) trailGroup.visible = false;
    updateTrailButton();
    updateModeButtons();
    updateSelectUpButton();
}

function destroyAll() {
    _destroyFloatingButtons();
    _destroyPrecisePanel(); // Ф1
    clearSelection();
    clearTrail();
    if (trailGroup) {
        scene.remove(trailGroup);
        trailGroup = null;
    }
    if (transformControls) {
        transformControls.removeEventListener('dragging-changed', onDraggingChanged);
        transformControls.removeEventListener('objectChange', onObjectChange);
        scene.remove(transformControls.getHelper());
        transformControls.dispose();
        transformControls = null;
    }
    removePivot();
    dragStartState = null;
    if (_cameraMoveTimer) { clearTimeout(_cameraMoveTimer); _cameraMoveTimer = null; }
    _cameraMoved = false;
    _initialCamPos = null;
    _initialCamTarget = null;
    originalStateSnapshot = null;
    isDragging = false;
    if (controls) {
        controls.enabled = true;
    }
    if (renderer?.domElement) {
        // Восстанавливаем исходное touchAction вместо жёсткого 'none'
        renderer.domElement.style.touchAction = _originalTouchAction;
    }
}

PluginManager.register({
    id: 'transform-gizmo',
    name: 'Перемещение',
    icon: 'cubes',
    // module — не указывается; привязку к модулю задаёт администратор
    // в js/plugins/registry.js через PluginManager.bindModules().
    condition: (pluginApi) => !!(pluginApi && pluginApi.model),

    init(pluginApi) {
        _cleanedUp = false;
        _visualsHiddenByPause = false; // на случай повторного init после destroy в фоне
        scene = pluginApi.scene;
        camera = pluginApi.camera;
        renderer = pluginApi.renderer;
        controls = pluginApi.controls;
        model = pluginApi.model;
        _originalTouchAction = renderer?.domElement?.style.touchAction || '';

        transformControls = new TransformControls(camera, renderer.domElement);
        transformControls.setSize(0.8);
        transformControls.showXY = false;
        transformControls.showXZ = false;
        transformControls.showYZ = false;
        scene.add(transformControls.getHelper());
        transformControls.addEventListener('dragging-changed', onDraggingChanged);
        transformControls.addEventListener('objectChange', onObjectChange);

        trailGroup = new THREE.Group();
        trailGroup.name = '__transform_gizmo_trail__';
        trailGroup.visible = showTrail;
        scene.add(trailGroup);

        saveOriginalStateSnapshot();
        _createFloatingButtons();
        _createPrecisePanel(); // Ф1: панель точного ввода смещения

        const controlsStartHandler = () => {
            _initialCamPos = camera.position.clone();
            _initialCamTarget = controls.target.clone();
        };
        const controlsChangeHandler = () => {
            _scheduleFloatingUpdate(); // E6: камера сдвинулась — кнопки следуют за гизмо
            if (!_initialCamPos || !_initialCamTarget) return;
            if (!camera.position.equals(_initialCamPos) || !controls.target.equals(_initialCamTarget)) {
                _cameraMoved = true;
                if (_cameraMoveTimer) clearTimeout(_cameraMoveTimer);
                _cameraMoveTimer = setTimeout(() => { _cameraMoved = false; }, 150);
            }
            if (showTrail) {
                updateTrailVisuals();
            }
        };
        controls.addEventListener('start', controlsStartHandler);
        controls.addEventListener('change', controlsChangeHandler);
        _boundHandlers.push({ el: controls, type: 'start', handler: controlsStartHandler });
        _boundHandlers.push({ el: controls, type: 'change', handler: controlsChangeHandler });

        // E6: ресайз меняет rect канваса — переобновляем позицию кнопок
        const resizeHandler = () => _scheduleFloatingUpdate();
        window.addEventListener('resize', resizeHandler);
        _boundHandlers.push({ el: window, type: 'resize', handler: resizeHandler });
        // E6: фиксация переходов активный/фоновый плагина (см. _onDocClickCapture)
        document.addEventListener('click', _onDocClickCapture, true);
        _boundHandlers.push({ el: document, type: 'click', handler: _onDocClickCapture, opts: true });

        const onClickHandler = (e) => {
            if (!transformControls || transformControls.dragging) return;
            if (_cameraMoved) { _cameraMoved = false; return; }
            if (_gizmoJustReleased) { _gizmoJustReleased = false; return; }
            if (e.button !== undefined && e.button !== 0) return;
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointer, camera);
            const meshes = getSelectableMeshes();
            const hits = raycaster.intersectObjects(meshes, false);
            if (hits.length > 0) {
                toggleSelectObject(hits[0].object);
            } else {
                clearSelection();
            }
        };
        renderer.domElement.addEventListener('click', onClickHandler);
        _boundHandlers.push({ el: renderer.domElement, type: 'click', handler: onClickHandler });

        return () => _cleanup();
    },

    destroy() {
        _cleanup();
    },

    panel: {
        className: 'gizmo-panel plugin-pill',
        html: `
            <div class="gizmo-group plugin-pill-group">
                <button class="gizmo-btn plugin-pill-btn active" id="gizmo-move-btn" title="Перемещение">
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-right-arrow-left"></use></svg>
                </button>
                <button class="gizmo-btn plugin-pill-btn" id="gizmo-rotate-btn" title="Поворот">
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-rotate-left"></use></svg>
                </button>
                <button class="gizmo-btn plugin-pill-btn" id="gizmo-precise-btn" title="Точный ввод смещения/поворота">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.2" y="5.2" width="13.6" height="5.6" rx="1.2" style="fill:none"/><path d="M4.3 5.2v2.3M7.1 5.2v2.3M9.9 5.2v2.3M12.7 5.2v2.3" style="fill:none"/></svg>
                </button>
            </div>
            <div class="gizmo-divider plugin-pill-divider"></div>
            <div class="gizmo-group plugin-pill-group">
                <button class="gizmo-btn plugin-pill-btn" id="gizmo-select-up-btn" title="Выделить родителя"></button>
                <button class="gizmo-btn plugin-pill-btn" id="gizmo-trail-btn" title="Траектория">
                    <svg><use xlink:href="assets/icons/sprite.svg#route-fill"></use></svg>
                </button>
                <button class="gizmo-btn plugin-pill-btn" id="gizmo-reset-btn" title="Сброс">
                    <svg><use xlink:href="assets/icons/sprite.svg#close"></use></svg>
                </button>
            </div>
        `,
        onMount(toolbar) {
            // Скоуп-поиск кнопок внутри своей панели: старый тулбар удаляется
            // с задержкой 200 мс, и document.getElementById может вернуть
            // ЕГО кнопки — обработчики вешались мимо новой панели
            _toolbarEl = toolbar;
            // Скоуп-контейнер для всплывающих панелей (как в view-display):
            // панель «Точный ввод» привязывается к .plugin-panels, а не к document.body.
            _panelsContainer = toolbar?.closest('.plugin-panels') || null;
            const moveBtn = _btnById('gizmo-move-btn');
            const rotBtn = _btnById('gizmo-rotate-btn');
            const preciseBtn = _btnById('gizmo-precise-btn');
            const selectUpBtn = _btnById('gizmo-select-up-btn');
            const trailBtn = _btnById('gizmo-trail-btn');
            const resetBtn = _btnById('gizmo-reset-btn');
            if (moveBtn) {
                const h = () => setMode('translate');
                moveBtn.addEventListener('click', h);
                _boundHandlers.push({ el: moveBtn, type: 'click', handler: h });
            }
            if (rotBtn) {
                const h = () => setMode('rotate');
                rotBtn.addEventListener('click', h);
                _boundHandlers.push({ el: rotBtn, type: 'click', handler: h });
            }
            if (preciseBtn) {
                const h = () => togglePreciseMode();
                preciseBtn.addEventListener('click', h);
                _boundHandlers.push({ el: preciseBtn, type: 'click', handler: h });
            }
            if (selectUpBtn) {
                const h = () => selectUpHierarchy();
                selectUpBtn.addEventListener('click', h);
                _boundHandlers.push({ el: selectUpBtn, type: 'click', handler: h });
            }
            if (trailBtn) {
                const h = () => toggleTrail();
                trailBtn.addEventListener('click', h);
                _boundHandlers.push({ el: trailBtn, type: 'click', handler: h });
            }
            if (resetBtn) {
                const h = () => resetAll();
                resetBtn.addEventListener('click', h);
                _boundHandlers.push({ el: resetBtn, type: 'click', handler: h });
            }
            updateModeButtons();
            updateTrailButton();
            updateSelectUpButton();
            updateSelectUpIcon();
            updatePreciseButton(); // Ф1: восстановить состояние кнопки из localStorage
        },

        // При переключении на другой плагин — закрыть панель «Точный ввод»
        // и спрятать 3D-гизмо + траекторию, чтобы они не висели поверх чужого
        // активного плагина. Сам режим preciseMode сбрасываем (как при клике
        // по кнопке), чтобы при возврате панель не висела раскрытой поверх
        // чужого тулбара. Выделение, режим гизмо (move/rotate) и позиция
        // сохраняются — плагин остаётся самодостаточным, возврат через onResume.
        onPause() {
            if (preciseMode) {
                preciseMode = false;
                try {
                    localStorage.setItem(PRECISE_STORAGE_KEY, '0');
                } catch (e) { /* noop */ }
                updatePreciseButton();
                _syncPrecisePanelMode();
                _updatePrecisePanel();
            }
            // Прячем визуал плагина: 3D-гизмо (helper.visible=false убирает рукоятки,
            // не трогая attach/detach), траекторию и подсветку выделения (emissive).
            // Сами selectedObjects НЕ чистим — выделение как данные переживает паузу,
            // при onResume подсветка восстанавливается по этому списку.
            if (!_visualsHiddenByPause) {
                if (transformControls?.object) {
                    const helper = transformControls.getHelper();
                    if (helper) helper.visible = false;
                }
                if (trailGroup?.visible) trailGroup.visible = false;
                for (const obj of selectedObjects) unhighlightObject(obj);
                _visualsHiddenByPause = true;
            }
            // На всякий случай прячем и плавающие кнопки (дублирует защиту
            // через isPluginPaused в _updateFloatingButtons — но onPause зовётся
            // синхронно, без ожидания rAF).
            _hideFloatingButtons();
        },

        // Возврат из фона в активное состояние: показываем гизмо, траекторию и
        // подсветку выделения обратно. Видимость восстанавливается по источникам
        // истины:
        //   helper.visible = true  — гизмо рисуется, если есть attach (иначе всё
        //                            равно не виден — внутри TransformControls
        //                            спрячет рукоятки при отсутствии object);
        //   trailGroup.visible = showTrail — флаг режима «Траектория»;
        //   highlightObject(obj) для каждого obj из selectedObjects — подсветка
        //                            emissive возвращается по пережившему паузу списку.
        // Сами selectedObjects и режим гизмо (move/rotate) не трогаем — они пережили паузу.
        onResume() {
            if (_visualsHiddenByPause) {
                if (transformControls?.object) {
                    const helper = transformControls.getHelper();
                    if (helper) helper.visible = true;
                }
                if (trailGroup) trailGroup.visible = showTrail;
                for (const obj of selectedObjects) highlightObject(obj);
                _visualsHiddenByPause = false;
            }
            // Плавающие кнопки и панель точного ввода обновятся по событиям
            // (isPluginPaused уже false), но проще дернуть обновление явно —
            // позиция кнопок зависит от текущей камеры/выделения, которые могли
            // измениться, пока плагин был в фоне.
            _scheduleFloatingUpdate();
            _updatePrecisePanel();
        },

        onUnmount() {
            _toolbarEl = null;
            _panelsContainer = null;
        }
    }
});