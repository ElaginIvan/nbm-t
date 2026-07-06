/**
 * 3D Engine Module
 * Ядро 3D движка: камера, свет, сетка, геометрия
 *
 * Выделено из 3d-viewer — содержит базовые компоненты рендеринга сцены:
 * - setupCamera — создание камеры, рендерера и OrbitControls
 * - setupLights / updateCameraLightPosition — освещение сцены
 * - createAdaptiveGrid / updateGridPosition / checkCameraOrientation — адаптивная сетка
 * - addEdgesToObject — рёбра объектов
 * - handleWindowResize / initResizeListener — обработка ресайза
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

// ============================================================
// КАМЕРА
// ============================================================

function setupCamera(container, canvas) {
    const camera = new THREE.PerspectiveCamera(26, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(5, 5, 5);

    const renderer = new THREE.WebGLRenderer({
        canvas, antialias: true, alpha: true,
        stencil: true, depth: true, powerPreference: 'high-performance'
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    return { camera, renderer, controls };
}

// ============================================================
// СВЕТ
// ============================================================

let cameraLight = null;

function setupLights(scene) {
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight.position.set(0, 50, 0);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 1.3);
    fillLight.position.set(0, -10, 0);
    scene.add(fillLight);

    cameraLight = new THREE.DirectionalLight(0xffffff, 1.2);
    cameraLight.position.set(0, 0, 0);
    cameraLight.castShadow = true;
    cameraLight.shadow.mapSize.width = 4096;
    cameraLight.shadow.mapSize.height = 4096;
    cameraLight.shadow.camera.near = 1;
    cameraLight.shadow.camera.far = 500;
    cameraLight.shadow.bias = 0.0000;
    cameraLight.shadow.normalBias = 0.02;
    cameraLight.shadow.radius = 5;
    scene.add(cameraLight);
}

function updateCameraLightPosition(camera, target) {
    if (!cameraLight || !camera || !target) return;

    const targetPos = new THREE.Vector3();
    target.getWorldPosition(targetPos);
    const cameraPos = new THREE.Vector3();
    camera.getWorldPosition(cameraPos);

    const lightOffset = new THREE.Vector3(-3, 3, 10);
    lightOffset.applyQuaternion(camera.quaternion.clone());

    cameraLight.position.copy(cameraPos.clone().add(lightOffset));
    cameraLight.lookAt(targetPos);
    cameraLight.shadow.camera.updateProjectionMatrix();
}

// ============================================================
// СЕТКА
// ============================================================

const GRID_OPACITY = 0.5;

function createAdaptiveGrid(scene) {
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
    planeX.receiveShadow = false;
    axesGroup.add(planeX);

    const planeZ = new THREE.Mesh(
        new THREE.PlaneGeometry(axisWidth, axisLength * 2),
        new THREE.MeshBasicMaterial({ color: 0x0000ff, transparent: true, opacity: GRID_OPACITY, side: THREE.DoubleSide })
    );
    planeZ.rotation.x = -Math.PI / 2;
    planeZ.receiveShadow = false;
    axesGroup.add(planeZ);

    axesGroup.position.y = 0.001;

    const gridHelper = new THREE.Group();
    gridHelper.name = 'adaptiveGrid';
    gridHelper.add(mainGrid);
    gridHelper.add(axesGroup);
    scene.add(gridHelper);
    return gridHelper;
}

function updateGridPosition(model, gridHelper) {
    if (!gridHelper || !model) return;
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    gridHelper.position.set(center.x, box.min.y - 0.01, center.z);
    const modelSize = Math.max(size.x, size.z);
    const gridScale = Math.max(modelSize * 1.5, 10);
    gridHelper.scale.set(gridScale / 100, 1, gridScale / 100);
}

/**
 * Проверяет ориентацию камеры относительно сетки и обновляет её прозрачность.
 * Возвращает новое значение видимости сетки (true = видима снизу, false = скрыта).
 * @param {THREE.GridHelper} gridHelper
 * @param {THREE.Camera} camera
 * @param {number} originalGridOpacity — исходная прозрачность сетки
 * @returns {boolean} — видима ли сетка при текущей ориентации камеры
 */
function checkCameraOrientation(gridHelper, camera, originalGridOpacity) {
    if (!gridHelper || !camera) return true;
    const cameraDir = new THREE.Vector3();
    camera.getWorldDirection(cameraDir);
    const gridNormal = new THREE.Vector3(0, -1, 0);
    const angle = cameraDir.angleTo(gridNormal);
    const visible = angle < Math.PI / 2;
    
    if (visible) {
        gridHelper.visible = true;
        gridHelper.traverse(child => { if (child.material) child.material.opacity = originalGridOpacity; });
    } else {
        gridHelper.visible = false;
    }
    
    return visible;
}

// ============================================================
// ГЕОМЕТРИЯ
// ============================================================

function addEdgesToObject(object, edgeColor = 0x808080) {
    object.traverse(child => {
        if (child.isMesh) {
            const edgesGeometry = new THREE.EdgesGeometry(child.geometry, 35);
            const edgesMaterial = new THREE.LineBasicMaterial({ color: edgeColor });
            edgesMaterial.clippingPlanes = [];
            edgesMaterial.clipShadows = true;
            const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
            edges.matrix.copy(child.matrix);
            edges.matrixWorld.copy(child.matrixWorld);
            child.add(edges);
            child.userData.isHighlightable = true;
        }
    });
}

// ============================================================
// RESIZE (обработка изменения размеров контейнера)
// ============================================================

/**
 * Обновляет размеры рендерера и камеры.
 * @param {THREE.Camera} camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Group} gridHelper
 * @param {THREE.Object3D} model
 * @param {Function} [onResize] — колбэк, вызываемый после ресайза (для установки _sceneDirty и т.п.)
 */
function handleWindowResize(camera, renderer, gridHelper, model, onResize) {
    const container = document.getElementById('model-container');
    if (!container || !camera || !renderer) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    if (gridHelper && model) updateGridPosition(model, gridHelper);
    if (typeof onResize === 'function') onResize();
}

/**
 * Добавляет слушатель resize на window, возвращает функцию очистки.
 * @param {THREE.Camera} camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Group} gridHelper
 * @param {THREE.Object3D} model
 * @param {Function} [onResize]
 * @returns {Function} cleanup — функция для снятия слушателя
 */
function initResizeListener(camera, renderer, gridHelper, model, onResize) {
    const handler = () => handleWindowResize(camera, renderer, gridHelper, model, onResize);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
}

// ============================================================
// ЭКСПОРТ
// ============================================================

export {
    // Камера
    setupCamera,
    // Свет
    setupLights,
    updateCameraLightPosition,
    // Сетка
    GRID_OPACITY,
    createAdaptiveGrid,
    updateGridPosition,
    checkCameraOrientation,
    // Геометрия
    addEdgesToObject,
    // Resize
    handleWindowResize,
    initResizeListener
};