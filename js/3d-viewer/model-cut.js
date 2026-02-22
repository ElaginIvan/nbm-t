// model-cut.js
// Модуль для создания сечений 3D модели с твёрдыми заглушками (solid caps)

// ==================== СОСТОЯНИЕ МОДУЛЯ ====================
const state = {
    // Флаги и ссылки
    isCuttingEnabled: false,
    activeAxis: null,
    modelRef: null,
    sceneRef: null,
    rendererRef: null,

    // Данные осей
    axisValues: { x: 0, y: 0, z: 0 },
    axisBounds: { x: { min: -1, max: 1 }, y: { min: -1, max: 1 }, z: { min: -1, max: 1 } },
    invertedAxes: { x: false, y: false, z: false },
    clippingPlanes: { x: null, y: null, z: null },

    // Последние значения (для восстановления)
    lastState: {
        axisValues: { x: 0, y: 0, z: 0 },
        invertedAxes: { x: false, y: false, z: false },
        activeAxis: null
    },

    // Группы объектов
    stencilGroups: [],
    capPlanes: [],
    capPlaneGroups: []
};

// ==================== НАСТРОЙКИ ====================
const capOptions = {
    color: null,           // null = использовать цвет модели или укажите другой цвет
    metalness: 0.1,
    roughness: 0.75,
    planeSize: 100,
    useModelColor: true
};

// ==================== ВСПОМОГАТЕЛЬНЫЕ СТРУКТУРЫ ====================
const originalMaterials = new WeakMap();  // Для восстановления материалов
const materialCache = new Map();          // Кэш для stencil материалов

// ==================== ОСНОВНЫЕ ФУНКЦИИ ====================

/**
 * Инициализирует инструмент сечения
 * @param {THREE.Scene} scene - Сцена Three.js
 * @param {THREE.Object3D} model - Модель для сечения
 * @param {THREE.WebGLRenderer} renderer - Рендерер (должен поддерживать stencil)
 */
export function initCuttingTool(scene, model, renderer = null) {
    if (!scene || !model) {
        console.error('Scene or model not provided for cutting tool');
        return;
    }

    state.sceneRef = scene;
    state.modelRef = model;

    if (renderer) {
        state.rendererRef = renderer;
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
 * @param {Object} options - Параметры заглушки
 */
export function setCapOptions(options = {}) {
    Object.assign(capOptions, options);
}

// ==================== РАБОТА С МОДЕЛЬЮ ====================

/**
 * Вычисляет границы модели и обновляет размер плоскости
 */
function computeModelBounds() {
    if (!state.modelRef) return;

    const box = new THREE.Box3().setFromObject(state.modelRef);
    const axes = ['x', 'y', 'z'];

    // Обновляем границы для всех осей
    axes.forEach(axis => {
        state.axisBounds[axis] = {
            min: box.min[axis],
            max: box.max[axis]
        };
        // Устанавливаем начальные значения на максимум
        state.axisValues[axis] = box.max[axis];
    });

    // Вычисляем размер плоскости заглушки
    const size = new THREE.Vector3();
    box.getSize(size);
    capOptions.planeSize = Math.max(size.x, size.y, size.z) * 1.5;

    // Сохраняем начальные значения
    Object.assign(state.lastState.axisValues, state.axisValues);

    console.log('Model bounds calculated:', state.axisBounds);
}

/**
 * Получает основной цвет модели (первый найденный mesh)
 * @returns {number} - Цвет в формате HEX
 */
function getModelBaseColor() {
    if (!state.modelRef) return 0xCCCCCC;

    let baseColor = 0xCCCCCC;

    state.modelRef.traverse((node) => {
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

// ==================== STENCIL И ЗАГЛУШКИ ====================

/**
 * Создаёт группу для stencil-рендеринга (определяет область сечения)
 */
function createPlaneStencilGroup(geometry, plane, renderOrder) {
    const group = new THREE.Group();

    // Используем кэшированный базовый материал
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

    // Задние грани (увеличивают счётчик stencil)
    const backMaterial = baseMaterial.clone();
    Object.assign(backMaterial, {
        side: THREE.BackSide,
        clippingPlanes: [plane],
        stencilFail: THREE.IncrementWrapStencilOp,
        stencilZFail: THREE.IncrementWrapStencilOp,
        stencilZPass: THREE.IncrementWrapStencilOp
    });

    // Передние грани (уменьшают счётчик stencil)
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
 * Создаёт плоскость-заглушку с цветом модели
 */
function createCapPlane(plane, renderOrder, otherPlanes) {
    // Определяем цвет
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
        side: THREE.DoubleSide  // Видна с обеих сторон
    });

    const geometry = new THREE.PlaneGeometry(capOptions.planeSize, capOptions.planeSize);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = renderOrder + 0.1;

    // Очищаем stencil после рендера заглушки
    mesh.onAfterRender = () => {
        if (state.rendererRef) {
            state.rendererRef.clearStencil();
        }
    };

    return mesh;
}

/**
 * Обновляет позицию плоскости заглушки
 */
function updateCapPlanePosition(capPlane, plane) {
    if (!capPlane || !plane) return;

    // Устанавливаем позицию на плоскость сечения
    plane.coplanarPoint(capPlane.position);

    // Ориентируем перпендикулярно плоскости
    const targetPoint = new THREE.Vector3(
        capPlane.position.x - plane.normal.x,
        capPlane.position.y - plane.normal.y,
        capPlane.position.z - plane.normal.z
    );
    capPlane.lookAt(targetPoint);
}

// ==================== ВКЛЮЧЕНИЕ/ОТКЛЮЧЕНИЕ ====================

/**
 * Включает режим сечения
 */
export function enableCutting() {
    if (!state.modelRef || state.isCuttingEnabled) return;

    state.isCuttingEnabled = true;
    const model = state.modelRef;

    // Инициализируем плоскости сечения
    const { x, y, z } = state.axisBounds;
    state.clippingPlanes = {
        x: new THREE.Plane(new THREE.Vector3(-1, 0, 0), x.max),
        y: new THREE.Plane(new THREE.Vector3(0, -1, 0), y.max),
        z: new THREE.Plane(new THREE.Vector3(0, 0, -1), z.max)
    };

    // Собираем все геометрии в мировых координатах
    const worldGeometries = [];

    model.traverse((node) => {
        if (!node.isMesh) return;

        // Сохраняем оригинальные материалы
        if (!originalMaterials.has(node)) {
            originalMaterials.set(node, node.material);
        }

        // Создаём материалы с поддержкой отсечения
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

        // Клонируем геометрию и трансформируем в мировые координаты
        if (node.geometry) {
            const worldGeom = node.geometry.clone();
            node.updateWorldMatrix(true, false);
            worldGeom.applyMatrix4(node.matrixWorld);
            worldGeometries.push(worldGeom);
        }
    });

    // Создаём stencil группы и заглушки для каждой оси
    const allPlanes = [state.clippingPlanes.x, state.clippingPlanes.y, state.clippingPlanes.z];
    const axes = ['x', 'y', 'z'];

    axes.forEach((axis, index) => {
        // Stencil группа
        const stencilGroup = new THREE.Group();
        stencilGroup.name = `stencil-${axis}`;

        worldGeometries.forEach(geometry => {
            stencilGroup.add(createPlaneStencilGroup(geometry, allPlanes[index], index + 1));
        });

        state.sceneRef.add(stencilGroup);
        state.stencilGroups.push(stencilGroup);

        // Заглушка
        const otherPlanes = allPlanes.filter((_, i) => i !== index);
        const capPlane = createCapPlane(allPlanes[index], index + 1, otherPlanes);
        capPlane.name = `cap-${axis}`;

        const capGroup = new THREE.Group();
        capGroup.add(capPlane);
        state.sceneRef.add(capGroup);

        state.capPlanes.push(capPlane);
        state.capPlaneGroups.push(capGroup);
    });

    applyClippingPlanes();
}

/**
 * Отключает режим сечения
 */
export function disableCutting() {
    if (!state.modelRef || !state.isCuttingEnabled) return;

    state.isCuttingEnabled = false;
    const model = state.modelRef;

    // Восстанавливаем оригинальные материалы
    model.traverse((node) => {
        if (originalMaterials.has(node)) {
            node.material = originalMaterials.get(node);
        }
    });

    // Удаляем все временные группы
    [...state.stencilGroups, ...state.capPlaneGroups].forEach(group => {
        state.sceneRef.remove(group);
        disposeGroup(group);
    });

    // Очищаем массивы
    state.stencilGroups = [];
    state.capPlanes = [];
    state.capPlaneGroups = [];
    state.clippingPlanes = { x: null, y: null, z: null };
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

// ==================== ПРИМЕНЕНИЕ СЕЧЕНИЙ ====================

/**
 * Применяет текущие плоскости отсечения к модели
 */
function applyClippingPlanes() {
    if (!state.modelRef || !state.isCuttingEnabled) return;

    // Собираем активные плоскости
    const activePlanes = [];
    const activeAxes = [];

    ['x', 'y', 'z'].forEach(axis => {
        const plane = state.clippingPlanes[axis];
        if (!plane) return;

        const bounds = state.axisBounds[axis];
        const isActive = Math.abs(state.axisValues[axis] - bounds.max) > 0.001;

        if (isActive) {
            const sign = state.invertedAxes[axis] ? 1 : -1;
            plane.normal.set(
                axis === 'x' ? sign : 0,
                axis === 'y' ? sign : 0,
                axis === 'z' ? sign : 0
            );
            plane.constant = state.invertedAxes[axis] ? -state.axisValues[axis] : state.axisValues[axis];

            activePlanes.push(plane);
            activeAxes.push(axis);
        }
    });

    // Применяем ко всем объектам модели
    applyClippingToAllObjects(state.modelRef, activePlanes);

    // Обновляем видимость и позиции заглушек
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
 * Обновляет состояние заглушек (видимость и позиции)
 */
function updateCapPlanes(activeAxes, activePlanes) {
    const allPlanes = [state.clippingPlanes.x, state.clippingPlanes.y, state.clippingPlanes.z];
    const axes = ['x', 'y', 'z'];

    axes.forEach((axis, index) => {
        const capPlane = state.capPlanes[index];
        const stencilGroup = state.stencilGroups[index];

        if (!capPlane || !stencilGroup) return;

        const isActive = activeAxes.includes(axis);

        stencilGroup.visible = isActive;
        capPlane.visible = isActive;

        if (isActive) {
            updateCapPlanePosition(capPlane, allPlanes[index]);

            // Для заглушки оставляем только плоскости других активных осей
            const otherActivePlanes = activePlanes.filter((_, idx) => activeAxes[idx] !== axis);
            capPlane.material.clippingPlanes = otherActivePlanes;
            capPlane.material.needsUpdate = true;
        }
    });
}

// ==================== UI КОМПОНЕНТЫ ====================

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
            if (!state.isCuttingEnabled) return;

            state.activeAxis = btn.dataset.axis;
            updateAxisUI(axisBtns, invertBtn, slider);
        });
    });

    // Слайдер
    slider.addEventListener('input', (e) => {
        if (!state.activeAxis || !state.isCuttingEnabled) return;

        updateAxisValueFromSlider(parseFloat(e.target.value));
        applyClippingPlanes();
    });

    // Инверсия
    invertBtn.addEventListener('click', () => {
        if (!state.activeAxis || !state.isCuttingEnabled) return;

        state.invertedAxes[state.activeAxis] = !state.invertedAxes[state.activeAxis];
        invertBtn.classList.toggle('active', state.invertedAxes[state.activeAxis]);
        updateSliderFromAxisValue(slider);
        applyClippingPlanes();
    });

    // Сброс
    resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetCutting(axisBtns, slider, invertBtn);
    });
}

/**
 * Открывает панель и включает сечение
 */
function openPanel(panel, toggleBtn, axisBtns, slider, invertBtn) {
    panel.classList.add('expanded');
    toggleBtn.classList.add('active');

    // Восстанавливаем последнее состояние
    Object.assign(state.axisValues, state.lastState.axisValues);
    Object.assign(state.invertedAxes, state.lastState.invertedAxes);

    enableCutting();

    if (state.lastState.activeAxis) {
        state.activeAxis = state.lastState.activeAxis;
        updateAxisUI(axisBtns, invertBtn, slider);
    }
}

/**
 * Закрывает панель и отключает сечение
 */
function closePanel(panel, toggleBtn, axisBtns, slider, invertBtn) {
    panel.classList.remove('expanded');
    toggleBtn.classList.remove('active');

    // Сохраняем текущее состояние
    Object.assign(state.lastState.axisValues, state.axisValues);
    Object.assign(state.lastState.invertedAxes, state.invertedAxes);
    state.lastState.activeAxis = state.activeAxis;

    disableCutting();

    // Сбрасываем UI
    axisBtns.forEach(btn => btn.classList.remove('active'));
    state.activeAxis = null;
    slider.disabled = true;
    invertBtn.disabled = true;
    invertBtn.classList.remove('active');
}

/**
 * Обновляет UI при выборе оси
 */
function updateAxisUI(axisBtns, invertBtn, slider) {
    axisBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.axis === state.activeAxis);
    });

    slider.disabled = false;
    invertBtn.disabled = false;
    invertBtn.classList.toggle('active', state.invertedAxes[state.activeAxis]);
    updateSliderFromAxisValue(slider);
}

/**
 * Обновляет значение слайдера из текущего значения оси
 */
function updateSliderFromAxisValue(slider) {
    if (!state.activeAxis) return;

    const bounds = state.axisBounds[state.activeAxis];
    const value = state.axisValues[state.activeAxis];
    const inverted = state.invertedAxes[state.activeAxis];

    const percent = inverted
        ? (value - bounds.min) / (bounds.max - bounds.min)
        : (bounds.max - value) / (bounds.max - bounds.min);

    slider.value = Math.max(0, Math.min(1, percent));
}

/**
 * Обновляет значение оси из слайдера
 */
function updateAxisValueFromSlider(percent) {
    if (!state.activeAxis) return;

    const bounds = state.axisBounds[state.activeAxis];
    const inverted = state.invertedAxes[state.activeAxis];

    state.axisValues[state.activeAxis] = inverted
        ? bounds.min + percent * (bounds.max - bounds.min)
        : bounds.max - percent * (bounds.max - bounds.min);
}

/**
 * Сбрасывает все настройки сечения
 */
function resetCutting(axisBtns, slider, invertBtn) {
    ['x', 'y', 'z'].forEach(axis => {
        state.axisValues[axis] = state.axisBounds[axis].max;
        state.invertedAxes[axis] = false;
    });

    invertBtn.classList.remove('active');

    if (state.activeAxis) {
        slider.value = 0;
    }

    state.activeAxis = null;
    axisBtns.forEach(btn => btn.classList.remove('active'));
    slider.disabled = true;
    invertBtn.disabled = true;

    applyClippingPlanes();
}

// ==================== ПУБЛИЧНЫЙ API ====================

/**
 * Обновляет границы модели (после изменений модели)
 */
export function updateModelBounds() {
    computeModelBounds();
}

/**
 * Устанавливает рендерер
 */
export function setRenderer(renderer) {
    state.rendererRef = renderer;
    if (renderer) {
        renderer.localClippingEnabled = true;
    }
}

/**
 * Возвращает текущие плоскости сечения
 */
export function getClippingPlanes() {
    return state.clippingPlanes;
}

/**
 * Проверяет, активно ли сечение
 */
export function isCuttingActive() {
    return state.isCuttingEnabled;
}

/**
 * Обновляет цвет заглушек (после изменения цвета модели)
 */
export function updateCapColor() {
    if (!state.isCuttingEnabled) return;

    const newColor = capOptions.useModelColor
        ? getModelBaseColor()
        : (capOptions.color || 0xCCCCCC);

    state.capPlanes.forEach(plane => {
        if (plane.material) {
            plane.material.color.setHex(newColor);
        }
    });
}

// Экспорт по умолчанию для удобства
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