/**
 * model-cut.js
 * Модуль для создания сечений 3D модели с твёрдыми заглушками (solid caps)
 * Интегрирован с store для управления состоянием
 */

import * as THREE from 'three';
import { store } from '../store.js';

// ============================================================
// КОНСТАНТЫ И НАСТРОЙКИ
// ============================================================

const capOptions = {
    color: null,           // null = использовать цвет модели
    metalness: 0.1,
    roughness: 0.75,
    planeSize: 100,
    useModelColor: true
};

// Кэш материалов и геометрий
const originalMaterials = new WeakMap();
const materialCache = new Map();

// ============================================================
// СОСТОЯНИЕ МОДУЛЯ (ссылки на Three.js объекты)
// ============================================================

const refs = {
    scene: null,
    model: null,
    renderer: null
};

const cuttingObjects = {
    stencilGroups: [],
    capPlanes: [],
    capPlaneGroups: [],
    clippingPlanes: { x: null, y: null, z: null }
};

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

/**
 * Вычисляет границы модели и обновляет store
 */
function computeModelBounds() {
    if (!refs.model) return;

    const box = new THREE.Box3().setFromObject(refs.model);
    const axes = ['x', 'y', 'z'];

    const bounds = {};
    const initialValues = {};

    axes.forEach(axis => {
        bounds[axis] = {
            min: box.min[axis],
            max: box.max[axis]
        };
        initialValues[axis] = box.max[axis];
    });

    // Обновляем store
    store.setState('cutting3d.axisBounds', bounds);
    store.setState('cutting3d.axisValues', initialValues);

    // Вычисляем размер плоскости заглушки
    const size = new THREE.Vector3();
    box.getSize(size);
    capOptions.planeSize = Math.max(size.x, size.y, size.z) * 1.5;

    console.log('Model bounds calculated:', bounds);
}

/**
 * Получает основной цвет модели
 */
function getModelBaseColor() {
    if (!refs.model) return 0xCCCCCC;

    let baseColor = 0xCCCCCC;

    refs.model.traverse((node) => {
        if (node.isMesh && node.material && baseColor === 0xCCCCCC) {
            if (Array.isArray(node.material)) {
                baseColor = node.material[0]?.color?.getHex() || baseColor;
            } else if (node.material.color) {
                baseColor = node.material.color.getHex();
            }
        }
    });

    return baseColor;
}

/**
 * Создаёт группу для stencil-рендеринга
 */
function createPlaneStencilGroup(geometry, plane, renderOrder) {
    const group = new THREE.Group();

    const cacheKey = `stencil-${renderOrder}`;
    let baseMaterial = materialCache.get(cacheKey);

    if (!baseMaterial) {
        baseMaterial = new THREE.MeshBasicMaterial({
            depthWrite: false,
            depthTest: false,
            colorWrite: false,
            stencilWrite: true,
            stencilFunc: THREE.AlwaysStencilFunc
        });
        materialCache.set(cacheKey, baseMaterial);
    }

    const backMaterial = baseMaterial.clone();
    Object.assign(backMaterial, {
        side: THREE.BackSide,
        clippingPlanes: [plane],
        stencilFail: THREE.IncrementWrapStencilOp,
        stencilZFail: THREE.IncrementWrapStencilOp,
        stencilZPass: THREE.IncrementWrapStencilOp
    });

    const frontMaterial = baseMaterial.clone();
    Object.assign(frontMaterial, {
        side: THREE.FrontSide,
        clippingPlanes: [plane],
        stencilFail: THREE.DecrementWrapStencilOp,
        stencilZFail: THREE.DecrementWrapStencilOp,
        stencilZPass: THREE.DecrementWrapStencilOp
    });

    const backMesh = new THREE.Mesh(geometry, backMaterial);
    const frontMesh = new THREE.Mesh(geometry, frontMaterial);

    backMesh.renderOrder = frontMesh.renderOrder = renderOrder;

    group.add(backMesh, frontMesh);
    return group;
}

/**
 * Создаёт плоскость-заглушку
 */
function createCapPlane(plane, renderOrder, otherPlanes) {
    const capColor = capOptions.useModelColor
        ? (capOptions.color || getModelBaseColor())
        : (capOptions.color || 0xCCCCCC);

    const material = new THREE.MeshStandardMaterial({
        color: capColor,
        metalness: capOptions.metalness,
        roughness: capOptions.roughness,
        clippingPlanes: otherPlanes,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
        side: THREE.DoubleSide
    });

    const geometry = new THREE.PlaneGeometry(capOptions.planeSize, capOptions.planeSize);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = renderOrder + 0.1;

    mesh.onAfterRender = () => {
        if (refs.renderer) {
            refs.renderer.clearStencil();
        }
    };

    return mesh;
}

/**
 * Обновляет позицию плоскости заглушки
 */
function updateCapPlanePosition(capPlane, plane) {
    if (!capPlane || !plane) return;

    plane.coplanarPoint(capPlane.position);

    const targetPoint = new THREE.Vector3(
        capPlane.position.x - plane.normal.x,
        capPlane.position.y - plane.normal.y,
        capPlane.position.z - plane.normal.z
    );
    capPlane.lookAt(targetPoint);
}

/**
 * Рекурсивно удаляет геометрии и материалы группы
 */
function disposeGroup(group) {
    group.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach(m => m.dispose());
        }
    });
}

// ============================================================
// ОСНОВНЫЕ ФУНКЦИИ
// ============================================================

/**
 * Включает режим сечения
 */
export function enableCutting() {
    if (!refs.model || store.getState('cutting3d.isActive')) return;

    store.setState('cutting3d.isActive', true);

    const bounds = store.getState('cutting3d.axisBounds');

    // Инициализируем плоскости сечения
    cuttingObjects.clippingPlanes = {
        x: new THREE.Plane(new THREE.Vector3(-1, 0, 0), bounds.x.max),
        y: new THREE.Plane(new THREE.Vector3(0, -1, 0), bounds.y.max),
        z: new THREE.Plane(new THREE.Vector3(0, 0, -1), bounds.z.max)
    };

    // Собираем все геометрии в мировых координатах
    const worldGeometries = [];

    refs.model.traverse((node) => {
        if (!node.isMesh) return;

        if (!originalMaterials.has(node)) {
            originalMaterials.set(node, node.material);
        }

        const createClippingMaterial = (material) => {
            if (!material) return material;
            const newMaterial = material.clone();
            newMaterial.clippingPlanes = [];
            newMaterial.clipShadows = true;
            newMaterial.shadowSide = THREE.DoubleSide;
            return newMaterial;
        };

        node.material = Array.isArray(node.material)
            ? node.material.map(createClippingMaterial)
            : createClippingMaterial(node.material);

        if (node.geometry) {
            const worldGeom = node.geometry.clone();
            node.updateWorldMatrix(true, false);
            worldGeom.applyMatrix4(node.matrixWorld);
            worldGeometries.push(worldGeom);
        }
    });

    // Создаём stencil группы и заглушки для каждой оси
    const allPlanes = [
        cuttingObjects.clippingPlanes.x,
        cuttingObjects.clippingPlanes.y,
        cuttingObjects.clippingPlanes.z
    ];
    const axes = ['x', 'y', 'z'];

    axes.forEach((axis, index) => {
        const stencilGroup = new THREE.Group();
        stencilGroup.name = `stencil-${axis}`;

        worldGeometries.forEach(geometry => {
            stencilGroup.add(createPlaneStencilGroup(geometry, allPlanes[index], index + 1));
        });

        refs.scene.add(stencilGroup);
        cuttingObjects.stencilGroups.push(stencilGroup);

        const otherPlanes = allPlanes.filter((_, i) => i !== index);
        const capPlane = createCapPlane(allPlanes[index], index + 1, otherPlanes);
        capPlane.name = `cap-${axis}`;

        const capGroup = new THREE.Group();
        capGroup.add(capPlane);
        refs.scene.add(capGroup);

        cuttingObjects.capPlanes.push(capPlane);
        cuttingObjects.capPlaneGroups.push(capGroup);
    });

    applyClippingPlanes();
}

/**
 * Отключает режим сечения
 */
export function disableCutting() {
    if (!refs.model || !store.getState('cutting3d.isActive')) return;

    store.setState('cutting3d.isActive', false);

    // Восстанавливаем оригинальные материалы
    refs.model.traverse((node) => {
        if (originalMaterials.has(node)) {
            node.material = originalMaterials.get(node);
        }
    });

    // Удаляем все временные группы
    [...cuttingObjects.stencilGroups, ...cuttingObjects.capPlaneGroups].forEach(group => {
        refs.scene.remove(group);
        disposeGroup(group);
    });

    // Очищаем массивы
    cuttingObjects.stencilGroups = [];
    cuttingObjects.capPlanes = [];
    cuttingObjects.capPlaneGroups = [];
    cuttingObjects.clippingPlanes = { x: null, y: null, z: null };

    // Сбрасываем состояние в store
    store.setState('cutting3d.isActive', false);
    store.setState('cutting3d.activeAxis', null);
}

/**
 * Применяет текущие плоскости отсечения к модели
 */
function applyClippingPlanes() {
    if (!refs.model || !store.getState('cutting3d.isActive')) return;

    const axisValues = store.getState('cutting3d.axisValues');
    const invertedAxes = store.getState('cutting3d.invertedAxes');
    const bounds = store.getState('cutting3d.axisBounds');

    const activePlanes = [];
    const activeAxes = [];

    ['x', 'y', 'z'].forEach(axis => {
        const plane = cuttingObjects.clippingPlanes[axis];
        if (!plane) return;

        const isActive = Math.abs(axisValues[axis] - bounds[axis].max) > 0.001;

        if (isActive) {
            const sign = invertedAxes[axis] ? 1 : -1;
            plane.normal.set(
                axis === 'x' ? sign : 0,
                axis === 'y' ? sign : 0,
                axis === 'z' ? sign : 0
            );
            plane.constant = invertedAxes[axis] ? -axisValues[axis] : axisValues[axis];

            activePlanes.push(plane);
            activeAxes.push(axis);
        }
    });

    applyClippingToAllObjects(refs.model, activePlanes);
    updateCapPlanes(activeAxes, activePlanes);
}

/**
 * Применяет плоскости отсечения ко всем объектам
 */
function applyClippingToAllObjects(root, activePlanes) {
    root?.traverse((node) => {
        if (node.isMesh || node.isLine || node.isLineSegments || node.isLineLoop) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];

            materials.forEach(material => {
                if (material) {
                    material.clippingPlanes = activePlanes.slice();
                    material.clipShadows = true;
                    material.needsUpdate = true;
                }
            });
        }
    });
}

/**
 * Обновляет состояние заглушек
 */
function updateCapPlanes(activeAxes, activePlanes) {
    const allPlanes = [
        cuttingObjects.clippingPlanes.x,
        cuttingObjects.clippingPlanes.y,
        cuttingObjects.clippingPlanes.z
    ];
    const axes = ['x', 'y', 'z'];

    axes.forEach((axis, index) => {
        const capPlane = cuttingObjects.capPlanes[index];
        const stencilGroup = cuttingObjects.stencilGroups[index];

        if (!capPlane || !stencilGroup) return;

        const isActive = activeAxes.includes(axis);

        stencilGroup.visible = isActive;
        capPlane.visible = isActive;

        if (isActive) {
            updateCapPlanePosition(capPlane, allPlanes[index]);

            const otherActivePlanes = activePlanes.filter((_, idx) => activeAxes[idx] !== axis);
            capPlane.material.clippingPlanes = otherActivePlanes;
            capPlane.material.needsUpdate = true;
        }
    });
}

// ============================================================
// UI КОМПОНЕНТЫ
// ============================================================

/**
 * Создаёт панель управления
 */
function createCuttingPanel() {
    if (document.getElementById('cutting-panel-wrapper')) return;

    const container = document.getElementById('model-container') || document.body;

    const wrapper = document.createElement('div');
    wrapper.id = 'cutting-panel-wrapper';
    wrapper.className = 'cutting-panel-wrapper';

    wrapper.innerHTML = `
        <button id="cutting-toggle" class="cutting-toggle">
            <svg><use xlink:href="assets/icons/sprite.svg#slice-fill"></use></svg>
        </button>
        <div id="cutting-panel" class="cutting-panel">
            <div class="cutting-axes">
                <button class="cutting-axis-btn axis-x" data-axis="x">X</button>
                <button class="cutting-axis-btn axis-y" data-axis="y">Y</button>
                <button class="cutting-axis-btn axis-z" data-axis="z">Z</button>
            </div>
            <div class="cutting-slider-container">
                <input type="range" id="cut-slider" class="cutting-slider" min="0" max="1" step="0.01" value="0" disabled>
            </div>
            <div class="cutting-actions">
                <button id="cutting-invert" class="cutting-invert-btn">
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-right-arrow-left"></use></svg>
                </button>
                <button id="cutting-reset" class="cutting-reset-btn">
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-rotate-left"></use></svg>
                </button>
            </div>
        </div>
    `;

    container.appendChild(wrapper);
}

/**
 * Настраивает обработчики событий для панели
 */
function setupCuttingControls() {
    const elements = {
        toggleBtn: document.getElementById('cutting-toggle'),
        panel: document.getElementById('cutting-panel'),
        axisBtns: document.querySelectorAll('.cutting-axis-btn'),
        slider: document.getElementById('cut-slider'),
        resetBtn: document.getElementById('cutting-reset'),
        invertBtn: document.getElementById('cutting-invert')
    };

    if (Object.values(elements).some(el => !el)) return;

    const { toggleBtn, panel, axisBtns, slider, resetBtn, invertBtn } = elements;

    // Открытие/закрытие панели
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        if (!panel.classList.contains('expanded')) {
            openPanel(panel, toggleBtn, axisBtns, slider, invertBtn);
        } else {
            closePanel(panel, toggleBtn, axisBtns, slider, invertBtn);
        }
    });

    // Выбор оси
    axisBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (!store.getState('cutting3d.isActive')) return;

            const axis = btn.dataset.axis;
            store.setState('cutting3d.activeAxis', axis);
            updateAxisUI(axisBtns, invertBtn, slider);
        });
    });

    // Слайдер
    slider.addEventListener('input', (e) => {
        const activeAxis = store.getState('cutting3d.activeAxis');
        if (!activeAxis || !store.getState('cutting3d.isActive')) return;

        updateAxisValueFromSlider(parseFloat(e.target.value));
        applyClippingPlanes();
    });

    // Инверсия
    invertBtn.addEventListener('click', () => {
        const activeAxis = store.getState('cutting3d.activeAxis');
        if (!activeAxis || !store.getState('cutting3d.isActive')) return;

        const currentInverted = store.getState('cutting3d.invertedAxes');
        store.setState('cutting3d.invertedAxes', { ...currentInverted, [activeAxis]: !currentInverted[activeAxis] });
        const newInverted = store.getState('cutting3d.invertedAxes');
        invertBtn.classList.toggle('active', newInverted[activeAxis]);
        updateSliderFromAxisValue(slider);
        applyClippingPlanes();
    });

    // Сброс
    resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetCutting(axisBtns, slider, invertBtn);
    });

    // Подписка на изменения store
    store.subscribe('cutting3d.isActive', (isActive) => {
        if (!isActive) {
            closePanel(panel, toggleBtn, axisBtns, slider, invertBtn);
        }
    });
}

/**
 * Открывает панель и включает сечение
 */
function openPanel(panel, toggleBtn, axisBtns, slider, invertBtn) {
    panel.classList.add('expanded');
    toggleBtn.classList.add('active');

    enableCutting();

    const activeAxis = store.getState('cutting3d.activeAxis');
    if (activeAxis) {
        updateAxisUI(axisBtns, invertBtn, slider);
    }
}

/**
 * Закрывает панель и отключает сечение
 */
function closePanel(panel, toggleBtn, axisBtns, slider, invertBtn) {
    panel.classList.remove('expanded');
    toggleBtn.classList.remove('active');

    disableCutting();

    axisBtns.forEach(btn => btn.classList.remove('active'));
    slider.disabled = true;
    invertBtn.disabled = true;
    invertBtn.classList.remove('active');
}

/**
 * Обновляет UI при выборе оси
 */
function updateAxisUI(axisBtns, invertBtn, slider) {
    const activeAxis = store.getState('cutting3d.activeAxis');

    axisBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.axis === activeAxis);
    });

    slider.disabled = false;
    invertBtn.disabled = false;
    invertBtn.classList.toggle('active', store.getState('cutting3d.invertedAxes')[activeAxis]);
    updateSliderFromAxisValue(slider);
}

/**
 * Обновляет значение слайдера из текущего значения оси
 */
function updateSliderFromAxisValue(slider) {
    const activeAxis = store.getState('cutting3d.activeAxis');
    if (!activeAxis) return;

    const bounds = store.getState('cutting3d.axisBounds')[activeAxis];
    const axisValues = store.getState('cutting3d.axisValues');
    const value = axisValues[activeAxis];
    const invertedAxes = store.getState('cutting3d.invertedAxes');
    const inverted = invertedAxes[activeAxis];

    const percent = inverted
        ? (value - bounds.min) / (bounds.max - bounds.min)
        : (bounds.max - value) / (bounds.max - bounds.min);

    slider.value = Math.max(0, Math.min(1, percent));
}

/**
 * Обновляет значение оси из слайдера
 */
function updateAxisValueFromSlider(percent) {
    const activeAxis = store.getState('cutting3d.activeAxis');
    if (!activeAxis) return;

    const bounds = store.getState('cutting3d.axisBounds')[activeAxis];
    const inverted = store.getState('cutting3d.invertedAxes')[activeAxis];

    const value = inverted
        ? bounds.min + percent * (bounds.max - bounds.min)
        : bounds.max - percent * (bounds.max - bounds.min);

        store.setState('cutting3d.axisValues', { ...store.getState('cutting3d.axisValues'), [activeAxis]: value });
}

/**
 * Сбрасывает все настройки сечения
 */
function resetCutting(axisBtns, slider, invertBtn) {
    const bounds = store.getState('cutting3d.axisBounds');

    ['x', 'y', 'z'].forEach(axis => {
        store.setState('cutting3d.axisValues', { ...store.getState('cutting3d.axisValues'), [axis]: bounds[axis].max });
        const currentInverted = store.getState('cutting3d.invertedAxes');
        if (currentInverted[axis]) {
            store.setState('cutting3d.invertedAxes', { ...currentInverted, [axis]: false });
        }
    });

    // Принудительно устанавливаем false для всех осей
    store.setState('cutting3d.invertedAxes', { x: false, y: false, z: false });

    invertBtn.classList.remove('active');

    store.setState('cutting3d.activeAxis', null);
    axisBtns.forEach(btn => btn.classList.remove('active'));
    slider.disabled = true;
    invertBtn.disabled = true;

    applyClippingPlanes();
}

// ============================================================
// ПУБЛИЧНЫЙ API
// ============================================================

/**
 * Инициализирует инструмент сечения
 */
export function initCuttingTool(scene, model, renderer = null) {
    if (!scene || !model) {
        console.error('Scene or model not provided for cutting tool');
        return;
    }

    refs.scene = scene;
    refs.model = model;

    if (renderer) {
        refs.renderer = renderer;
        renderer.localClippingEnabled = true;
        if (!renderer.capabilities.stencilBuffer) {
            console.warn('Renderer does not support stencil buffer. Caps may not work correctly.');
        }
    }

    computeModelBounds();
    createCuttingPanel();
    setupCuttingControls();
}

/**
 * Устанавливает параметры заглушки
 */
export function setCapOptions(options = {}) {
    Object.assign(capOptions, options);
}

/**
 * Обновляет границы модели
 */
export function updateModelBounds() {
    computeModelBounds();
}

/**
 * Устанавливает рендерер
 */
export function setRenderer(renderer) {
    refs.renderer = renderer;
    if (renderer) {
        renderer.localClippingEnabled = true;
    }
}

/**
 * Возвращает текущие плоскости сечения
 */
export function getClippingPlanes() {
    return cuttingObjects.clippingPlanes;
}

/**
 * Проверяет, активно ли сечение
 */
export function isCuttingActive() {
    return store.getState('cutting3d.isActive');
}

/**
 * Обновляет цвет заглушек
 */
export function updateCapColor() {
    if (!store.getState('cutting3d.isActive')) return;

    const newColor = capOptions.useModelColor
        ? getModelBaseColor()
        : (capOptions.color || 0xCCCCCC);

    cuttingObjects.capPlanes.forEach(plane => {
        if (plane.material) {
            plane.material.color.setHex(newColor);
        }
    });
}

// Экспорт по умолчанию
export default {
    initCuttingTool,
    enableCutting,
    disableCutting,
    updateModelBounds,
    setRenderer,
    setCapOptions,
    getClippingPlanes,
    isCuttingActive,
    updateCapColor
};
