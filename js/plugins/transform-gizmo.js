/**
 * Плагин: Перемещение / Поворот элементов через гизмо (3D)
 *
 * Возможности:
 * - Множественный выбор мешей кликом (повторный клик снимает выделение)
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
let highlightState = new Map();
const HIGHLIGHT_EMISSIVE = 0x1a3a6a;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let _boundHandlers = [];
let _modelLoadedHandler = null;
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
let _floatingRAF = null;
let _floatDropEl = null;
let _floatRotEl = null;

function _resetHierarchy() {
    hierarchyRoot = null;
    hierarchyStack = [];
    originalSelection = null;
    hierarchyDirection = 'up';
}

function _cleanup() {
    restoreOriginalState();
    for (const { el, type, handler } of _boundHandlers) {
        el.removeEventListener(type, handler);
    }
    _boundHandlers = [];
    if (_modelLoadedHandler) {
        window.removeEventListener('modelLoaded', _modelLoadedHandler);
        _modelLoadedHandler = null;
    }

    // ВАЖНО: снимаем внутренние слушатели TransformControls ДО dispose и
    // принудительно возвращаем OrbitControls в активное состояние.
    // Без этого на телефоне после деактивации плагина controls.enabled
    // мог оставаться false (если гизмо было в состоянии dragging или если
    // dispose не выстрелил dragging-changed с value:false) — и тогда
    // обработчики тач-событий OrbitControls выходили без preventDefault(),
    // передавая жесты браузеру (пинч → зум страницы, свайп → скролл страницы).
    if (transformControls) {
        transformControls.removeEventListener('dragging-changed', onDraggingChanged);
        transformControls.removeEventListener('objectChange', onObjectChange);
    }
    isDragging = false;
    if (controls) {
        controls.enabled = true;
    }

    destroyAll();
}

const HIERARCHY_ICON_UP = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M8 11V3m0 0L4 7m4-4l4 4"/><path d="M2 14h12"/></svg>`;
const HIERARCHY_ICON_DOWN = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M8 5v8m0 0l4-4m-4 4L4 9"/><path d="M2 2h12"/></svg>`;

function getSelectableMeshes() {
    const meshes = [];
    if (!model) return meshes;
    model.traverse(child => {
        if (child.isMesh) meshes.push(child);
    });
    return meshes;
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

    if (Array.isArray(obj.material)) {
        obj.material = obj.material.map(m => {
            if (!m) return m;
            const clone = m.clone();
            if (clone.emissive) clone.emissive.setHex(HIGHLIGHT_EMISSIVE);
            return clone;
        });
    } else if (obj.material.emissive) {
        obj.material = obj.material.clone();
        obj.material.emissive.setHex(HIGHLIGHT_EMISSIVE);
    } else {
        return;
    }

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
    obj.material = state.originalMaterials;
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

    // Если общий предок — сама сцена или не найден, используем первый
    // непромежуточный родитель (выше scene)
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
        pivot.rotation.set(0, 0, 0);
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
    pivot.name = '__transform_gizmo_pivot__';
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

    if (event.value) {
        saveDragStartState();
    } else {
        if (dragStartState && showTrail && currentMode === 'translate') {
            updateTrailRealTime();
        }
        dragStartState = null;
        _gizmoJustReleased = true;
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

    if (showTrail && currentMode === 'translate' && dragStartState) {
        updateTrailRealTime();
    }

    updateTrailVisuals();
}

function updateTrailRealTime() {
    if (!dragStartState) return;

    // Если выделена сборка через иерархию (hierarchyRoot) —
    // одна траектория на всю сборку, независимо от вложенности.
    // Иначе группируем по прямому родителю каждого меша.
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
        // Вычисляем центр группы — стартовую позицию траектории
        const startPos = new THREE.Vector3();
        for (const item of items) {
            startPos.add(item.pos);
        }
        startPos.divideScalar(items.length);

        // Вычисляем текущий центр группы
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
    const moveBtn = document.getElementById('gizmo-move-btn');
    const rotBtn = document.getElementById('gizmo-rotate-btn');
    if (moveBtn) moveBtn.classList.toggle('active', currentMode === 'translate');
    if (rotBtn) rotBtn.classList.toggle('active', currentMode === 'rotate');
}

function updateTrailButton() {
    const btn = document.getElementById('gizmo-trail-btn');
    if (btn) btn.classList.toggle('active', showTrail);
}

function updateSelectUpButton() {
    const btn = document.getElementById('gizmo-select-up-btn');
    if (btn) btn.classList.toggle('active', !!hierarchyRoot);
}

function updateSelectUpIcon() {
    const btn = document.getElementById('gizmo-select-up-btn');
    if (!btn) return;
    const isDown = hierarchyDirection === 'down';
    btn.innerHTML = isDown ? HIERARCHY_ICON_DOWN : HIERARCHY_ICON_UP;
    btn.title = isDown ? 'Сузить выделение' : 'Выделить родителя';
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

    // Already going down — keep going down
    if (hierarchyDirection === 'down') {
        goDownHierarchy();
        return;
    }

    // Going up — find the next ancestor that actually expands the selection
    const startNode = hierarchyRoot || selectedObjects[0];
    let targetParent = startNode.parent;

    while (targetParent && targetParent !== scene) {
        let meshCount = 0;
        targetParent.traverse(child => { if (child.isMesh) meshCount++; });
        if (meshCount > selectedObjects.length) break;
        targetParent = targetParent.parent;
    }

    // Can't go further up — switch to down direction
    if (!targetParent || targetParent === scene) {
        hierarchyDirection = 'down';
        goDownHierarchy();
        return;
    }

    // Save original selection on first expansion
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

    // Drop-to-floor button (translate mode)
    const dropBtn = document.createElement('button');
    dropBtn.id = 'gizmo-float-drop';
    dropBtn.title = 'Опустить на пол';
    dropBtn.style.cssText = _floatBtnBaseStyle();
    dropBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 2v9m0 0L5 7.5M8 11l3-3.5"/><path d="M2 14h12"/></svg>';
    const dropHandler = () => dropToFloor();
    dropBtn.addEventListener('click', dropHandler);
    _boundHandlers.push({ el: dropBtn, type: 'click', handler: dropHandler });
    _floatingContainer.appendChild(dropBtn);

    // Rotation axis buttons (rotate mode)
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

    // Position update loop
    (function loop() {
        _floatingRAF = requestAnimationFrame(loop);
        if (!_floatingContainer || !transformControls) return;

        const gizmoObj = transformControls.object;
        if (!gizmoObj || selectedObjects.length === 0 || isDragging) {
            _floatingContainer.style.opacity = '0';
            _floatingContainer.style.pointerEvents = 'none';
            return;
        }

        const worldPos = new THREE.Vector3();
        gizmoObj.getWorldPosition(worldPos);
        const projected = worldPos.clone().project(camera);

        if (projected.z > 1) {
            _floatingContainer.style.opacity = '0';
            return;
        }

        const rect = renderer.domElement.getBoundingClientRect();
        _floatingContainer.style.left = ((projected.x * 0.5 + 0.5) * rect.width + rect.left) + 'px';
        _floatingContainer.style.top = ((-projected.y * 0.5 + 0.5) * rect.height + rect.top) + 'px';
        _floatingContainer.style.opacity = '1';
        _floatingContainer.style.pointerEvents = 'auto';

        // Toggle button groups by current mode
        if (_floatDropEl) _floatDropEl.style.display = currentMode === 'translate' ? 'flex' : 'none';
        if (_floatRotEl) _floatRotEl.style.display = currentMode === 'rotate' ? 'flex' : 'none';
    })();
}

function _destroyFloatingButtons() {
    if (_floatingRAF) { cancelAnimationFrame(_floatingRAF); _floatingRAF = null; }
    if (_floatingContainer && _floatingContainer.parentElement) {
        _floatingContainer.parentElement.removeChild(_floatingContainer);
    }
    _floatingContainer = null;
    _floatDropEl = null;
    _floatRotEl = null;
}

function dropToFloor() {
    if (selectedObjects.length === 0) return;

    // Combined world AABB of all selected objects
    const selBBox = new THREE.Box3();
    for (const obj of selectedObjects) selBBox.expandByObject(obj);
    const bottomY = selBBox.min.y;

    // Floor = bottom of the model's world bounding box (not local zero)
    let targetY = model ? new THREE.Box3().setFromObject(model).min.y : 0;
    const nonSelected = getSelectableMeshes().filter(m => !selectedObjects.includes(m));

    for (const mesh of nonSelected) {
        const mb = new THREE.Box3().setFromObject(mesh);
        // Check XZ overlap and that obstacle is below selection bottom
        if (mb.max.x >= selBBox.min.x && mb.min.x <= selBBox.max.x &&
            mb.max.z >= selBBox.min.z && mb.min.z <= selBBox.max.z &&
            mb.max.y <= bottomY) {
            targetY = Math.max(targetY, mb.max.y);
        }
    }

    const delta = bottomY - targetY;
    if (delta <= 0.001) return; // Already resting

    // Если у выбранных деталей есть общий родитель (не сцена) —
    // двигаем родительский узел целиком, чтобы детали не разъезжались
    const commonParent = selectedObjects.length > 1 ? findCommonParent(selectedObjects) : null;
    if (commonParent && commonParent !== scene) {
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
    // Ensure right-handed basis (x × y = z)
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

    // Если у выбранных деталей есть общий родитель (не сцена) —
    // выравниваем/вращаем родительский узел целиком.
    // При этом сдвигаем позицию родителя, чтобы ось поворота
    // следовала за центром выделенных объектов (а не оставалась на старом месте).
    const commonParent = selectedObjects.length > 1 ? findCommonParent(selectedObjects) : null;
    if (commonParent && commonParent !== scene) {
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

        // Сдвигаем позицию родителя: P_new = C + R * (P_old - C)
        const newParentPos = wp.clone().sub(center).applyQuaternion(rotQuat).add(center);

        setWorldPosition(commonParent, newParentPos);
        setWorldQuaternion(commonParent, newQuat);

        updateGizmoAttachment();
        return;
    }

    // Rotation center: pivot for multi-selection, object center for single
    const center = new THREE.Vector3();
    if (pivot) {
        pivot.getWorldPosition(center);
    } else if (selectedObjects.length === 1) {
        selectedObjects[0].getWorldPosition(center);
    } else {
        center.copy(computeSelectionCenter());
    }

    // Decide: snap to world or rotate 90°
    const firstQuat = new THREE.Quaternion();
    selectedObjects[0].getWorldQuaternion(firstQuat);
    const needsSnap = !_isAlignedToWorld(firstQuat);

    for (const obj of selectedObjects) {
        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        obj.getWorldPosition(wp);
        obj.getWorldQuaternion(wq);

        if (needsSnap) {
            // Snap local CS to nearest world-aligned orientation
            setWorldQuaternion(obj, _snapToWorld(wq));
        } else {
            // Already aligned — rotate 90° around the axis
            const rot = new THREE.Quaternion().setFromAxisAngle(axisVec, Math.PI / 2);
            const rel = wp.clone().sub(center).applyQuaternion(rot);
            setWorldPosition(obj, rel.add(center));
            setWorldQuaternion(obj, rot.clone().multiply(wq));
        }
    }

    updateGizmoAttachment();
}

function setMode(mode) {
    currentMode = mode;
    if (transformControls) transformControls.setMode(mode);
    updateModeButtons();
}

function toggleTrail() {
    showTrail = !showTrail;
    if (trailGroup) trailGroup.visible = showTrail;
    updateTrailButton();
    if (showTrail) updateTrailVisuals();
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
    clearSelection();
    clearTrail();
    if (trailGroup) {
        scene.remove(trailGroup);
        trailGroup = null;
    }
    if (transformControls) {
        // Снимаем слушатели ещё раз на случай прямого вызова destroyAll() без _cleanup()
        transformControls.removeEventListener('dragging-changed', onDraggingChanged);
        transformControls.removeEventListener('objectChange', onObjectChange);
        scene.remove(transformControls._root);
        transformControls.dispose();
        transformControls = null;
    }
    removePivot();
    selectedObjects = [];
    for (const [, state] of highlightState) {
        const cloned = Array.isArray(state.clonedMaterials) ? state.clonedMaterials : [state.clonedMaterials];
        for (const m of cloned) {
            if (m && typeof m.dispose === 'function') m.dispose();
        }
    }
    highlightState.clear();
    dragStartState = null;
    if (_cameraMoveTimer) { clearTimeout(_cameraMoveTimer); _cameraMoveTimer = null; }
    _cameraMoved = false;
    _initialCamPos = null;
    _initialCamTarget = null;
    originalStateSnapshot = null;
    _resetHierarchy();

    // Гарантия: OrbitControls всегда возвращается в активное состояние
    // после деактивации плагина (фикс бага на телефоне: pinch/scroll страницы
    // вместо зума/вращения модели).
    isDragging = false;
    if (controls) {
        controls.enabled = true;
    }

    // ВАЖНО: TransformControls.dispose() сбрасывает inline-стиль
    // `touch-action: none`, который он сам выставлял на canvas в connect().
    // CSS-правило для #viewer тоже задаёт touch-action: none, но inline-стиль
    // имеет приоритет — после сброса в '' правило снова применится. Чтобы
    // перестраховаться (на случай если TransformControls оставит мусор),
    // явно восстанавливаем inline-стиль.
    if (renderer?.domElement) {
        renderer.domElement.style.touchAction = 'none';
    }
}

PluginManager.register({
    id: 'transform-gizmo',
    name: 'Перемещение',
    icon: 'cubes',
    module: '3d-viewer',

    condition: (pluginApi) => !!(pluginApi && pluginApi.model),

    init(pluginApi) {
        scene = pluginApi.scene;
        camera = pluginApi.camera;
        renderer = pluginApi.renderer;
        controls = pluginApi.controls;
        model = pluginApi.model;

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

        const controlsStartHandler = () => {
            _initialCamPos = camera.position.clone();
            _initialCamTarget = controls.target.clone();
        };
        const controlsChangeHandler = () => {
            if (!_initialCamPos || !_initialCamTarget) return;
            if (!camera.position.equals(_initialCamPos) || !controls.target.equals(_initialCamTarget)) {
                _cameraMoved = true;
                if (_cameraMoveTimer) clearTimeout(_cameraMoveTimer);
                _cameraMoveTimer = setTimeout(() => { _cameraMoved = false; }, 150); // Было 300
            }
            if (showTrail) {
                updateTrailVisuals();
            }
        };
        controls.addEventListener('start', controlsStartHandler);
        controls.addEventListener('change', controlsChangeHandler);
        _boundHandlers.push({ el: controls, type: 'start', handler: controlsStartHandler });
        _boundHandlers.push({ el: controls, type: 'change', handler: controlsChangeHandler });

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

        _modelLoadedHandler = () => {
            model = pluginApi.model;
            clearSelection();
            clearTrail();
            showTrail = false;
            if (trailGroup) trailGroup.visible = false;
            updateTrailButton();
            saveOriginalStateSnapshot();
        };
        window.addEventListener('modelLoaded', _modelLoadedHandler);

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
            </div>
            <div class="gizmo-divider plugin-pill-divider"></div>
            <div class="gizmo-group plugin-pill-group">
                <button class="gizmo-btn plugin-pill-btn" id="gizmo-select-up-btn" title="Выделить родителя">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                        <path d="M8 11V3m0 0L4 7m4-4l4 4"/>
                        <path d="M2 14h12"/>
                    </svg>
                </button>
                <button class="gizmo-btn plugin-pill-btn" id="gizmo-trail-btn" title="Траектория">
                    <svg><use xlink:href="assets/icons/sprite.svg#route-fill"></use></svg>
                </button>
                <button class="gizmo-btn plugin-pill-btn" id="gizmo-reset-btn" title="Сброс">
                    <svg><use xlink:href="assets/icons/sprite.svg#close"></use></svg>
                </button>
            </div>
        `,

        onMount(toolbar) {
            const moveBtn = document.getElementById('gizmo-move-btn');
            const rotBtn = document.getElementById('gizmo-rotate-btn');
            const selectUpBtn = document.getElementById('gizmo-select-up-btn');
            const trailBtn = document.getElementById('gizmo-trail-btn');
            const resetBtn = document.getElementById('gizmo-reset-btn');

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
        },

        onUnmount() { }
    }
});