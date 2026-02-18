// model-cut.js
// Модуль для создания сечений 3D модели – панель выезжает слева от кнопки

let isCuttingEnabled = false;
let clippingPlanes = { x: null, y: null, z: null };
const originalMaterials = new WeakMap();

let activeAxis = null;
let axisValues = { x: 0, y: 0, z: 0 };
let axisBounds = { x: { min: -1, max: 1 }, y: { min: -1, max: 1 }, z: { min: -1, max: 1 } };
let modelRef = null;
let sceneRef = null;

// Флаг инверсии для каждой оси
let invertedAxes = { x: false, y: false, z: false };

// Сохраняем последние значения для восстановления
let lastAxisValues = { x: 0, y: 0, z: 0 };
let lastInvertedAxes = { x: false, y: false, z: false };
let lastActiveAxis = null;

/**
 * Инициализирует инструмент сечения
 * @param {THREE.Scene} scene - Сцена Three.js
 * @param {THREE.Object3D} model - Модель для сечения
 */
export function initCuttingTool(scene, model) {
    if (!scene || !model) {
        console.error('Scene or model not provided for cutting tool');
        return;
    }
    sceneRef = scene;
    modelRef = model;

    // Вычисляем bounding box модели для корректного диапазона сечения
    computeModelBounds(model);
    
    createCuttingPanel();
    setupCuttingControls();
}

/**
 * Вычисляет границы модели для настройки диапазона сечения
 * @param {THREE.Object3D} model - Модель
 */
function computeModelBounds(model) {
    if (!model) return;
    
    // Создаем bounding box для модели
    const box = new THREE.Box3().setFromObject(model);
    
    // Устанавливаем границы для каждой оси
    axisBounds = {
        x: { min: box.min.x, max: box.max.x },
        y: { min: box.min.y, max: box.max.y },
        z: { min: box.min.z, max: box.max.z }
    };
    
    // Инициализируем значения по умолчанию (максимум - модель видна полностью)
    axisValues = {
        x: axisBounds.x.max,
        y: axisBounds.y.max,
        z: axisBounds.z.max
    };
    
    // Сохраняем начальные значения
    lastAxisValues = { ...axisValues };
    
    console.log('Model bounds calculated:', axisBounds);
}

function createCuttingPanel() {
    if (document.getElementById('cutting-panel-wrapper')) return;

    const container = document.getElementById('model-container');
    if (!container) return;

    // Создаем обертку для панели
    const wrapper = document.createElement('div');
    wrapper.id = 'cutting-panel-wrapper';
    wrapper.className = 'cutting-panel-wrapper';
    container.appendChild(wrapper);

    // Кнопка включения (всегда на одном месте)
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'cutting-toggle';
    toggleBtn.className = 'cutting-toggle ri-slice-fill';
    toggleBtn.title = 'Сечение модели';
    wrapper.appendChild(toggleBtn);

    // Панель с элементами управления (выезжает слева)
    const panel = document.createElement('div');
    panel.id = 'cutting-panel';
    panel.className = 'cutting-panel';
    panel.innerHTML = `
        <div class="cutting-axes">
            <button class="cutting-axis-btn" data-axis="x">X</button>
            <button class="cutting-axis-btn" data-axis="y">Y</button>
            <button class="cutting-axis-btn" data-axis="z">Z</button>
        </div>
        <div class="cutting-slider-container">
            <input type="range" id="cut-slider" class="cutting-slider" min="0" max="1" step="0.01" value="0" disabled>
        </div>
        <div class="cutting-actions">
            <button id="cutting-invert" class="cutting-invert-btn" title="Инвертировать" disabled>↔</button>
            <button id="cutting-reset" class="cutting-reset-btn" title="Сбросить">↺</button>
        </div>
    `;
    wrapper.appendChild(panel);
}

function setupCuttingControls() {
    const toggleBtn = document.getElementById('cutting-toggle');
    const panel = document.getElementById('cutting-panel');
    const axisBtns = document.querySelectorAll('.cutting-axis-btn');
    const slider = document.getElementById('cut-slider');
    const resetBtn = document.getElementById('cutting-reset');
    const invertBtn = document.getElementById('cutting-invert');

    if (!toggleBtn || !panel || !slider || !resetBtn || !invertBtn) return;

    // Открытие/закрытие панели по клику на кнопку включения
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isExpanded = panel.classList.contains('expanded');
        
        if (!isExpanded) {
            // Открываем панель (выезжает слева)
            panel.classList.add('expanded');
            toggleBtn.classList.add('active');
            
            // Восстанавливаем сохраненные значения
            axisValues = { ...lastAxisValues };
            invertedAxes = { ...lastInvertedAxes };
            
            enableCutting(modelRef);
            
            if (lastActiveAxis) {
                activeAxis = lastActiveAxis;
                axisBtns.forEach(btn => {
                    if (btn.dataset.axis === lastActiveAxis) {
                        btn.classList.add('active');
                    }
                });
                slider.disabled = false;
                invertBtn.disabled = false;
                invertBtn.classList.toggle('active', invertedAxes[lastActiveAxis]);
                updateSliderFromAxisValue();
            }
        } else {
            // Закрываем панель
            closePanel();
        }
    });

    // Выбор оси
    axisBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isCuttingEnabled) return;

            const axis = btn.dataset.axis;
            
            axisBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeAxis = axis;
            slider.disabled = false;
            invertBtn.disabled = false;
            
            updateSliderFromAxisValue();
            invertBtn.classList.toggle('active', invertedAxes[activeAxis]);
        });
    });

    // Изменение ползунка
    slider.addEventListener('input', (e) => {
        e.stopPropagation();
        if (!activeAxis || !isCuttingEnabled) return;
        
        const percentValue = parseFloat(e.target.value);
        updateAxisValueFromSlider(percentValue);
        applyClippingPlanes(modelRef);
    });

    // Инвертирование направления разреза
    invertBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activeAxis || !isCuttingEnabled) return;
        
        invertedAxes[activeAxis] = !invertedAxes[activeAxis];
        invertBtn.classList.toggle('active', invertedAxes[activeAxis]);
        updateSliderFromAxisValue();
        applyClippingPlanes(modelRef);
    });

    // Сброс всех осей
    resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        
        axisValues = {
            x: axisBounds.x.max,
            y: axisBounds.y.max,
            z: axisBounds.z.max
        };
        
        invertedAxes = { x: false, y: false, z: false };
        invertBtn.classList.remove('active');
        
        if (activeAxis) {
            slider.value = 0;
        }
        
        axisBtns.forEach(b => b.classList.remove('active'));
        activeAxis = null;
        slider.disabled = true;
        invertBtn.disabled = true;
        applyClippingPlanes(modelRef);
    });

    function closePanel() {
        panel.classList.remove('expanded');
        toggleBtn.classList.remove('active');
        
        lastAxisValues = { ...axisValues };
        lastInvertedAxes = { ...invertedAxes };
        lastActiveAxis = activeAxis;
        
        disableCutting(modelRef);
        
        axisBtns.forEach(btn => btn.classList.remove('active'));
        activeAxis = null;
        slider.disabled = true;
        invertBtn.disabled = true;
        invertBtn.classList.remove('active');
    }
}

/**
 * Обновляет значение ползунка на основе текущего значения оси
 */
function updateSliderFromAxisValue() {
    if (!activeAxis) return;
    
    const axisBound = axisBounds[activeAxis];
    const slider = document.getElementById('cut-slider');
    
    if (axisBound && slider) {
        let percentValue;
        
        if (invertedAxes[activeAxis]) {
            percentValue = (axisValues[activeAxis] - axisBound.min) / (axisBound.max - axisBound.min);
        } else {
            percentValue = (axisBound.max - axisValues[activeAxis]) / (axisBound.max - axisBound.min);
        }
        
        slider.value = Math.max(0, Math.min(1, percentValue));
    }
}

/**
 * Обновляет значение оси на основе положения ползунка
 */
function updateAxisValueFromSlider(percentValue) {
    if (!activeAxis) return;
    
    const axisBound = axisBounds[activeAxis];
    
    if (axisBound) {
        if (invertedAxes[activeAxis]) {
            axisValues[activeAxis] = axisBound.min + percentValue * (axisBound.max - axisBound.min);
        } else {
            axisValues[activeAxis] = axisBound.max - percentValue * (axisBound.max - axisBound.min);
        }
    } else {
        axisValues[activeAxis] = 0;
    }
}

function enableCutting(model) {
    if (!model || isCuttingEnabled) return;
    isCuttingEnabled = true;

    model.traverse((node) => {
        if (node.isMesh || node.isLineSegments) {
            if (!originalMaterials.has(node)) {
                originalMaterials.set(node, node.material);
            }

            if (Array.isArray(node.material)) {
                node.material = node.material.map(mat => {
                    const newMat = mat.clone();
                    newMat.clippingPlanes = [];
                    newMat.clipShadows = true;
                    return newMat;
                });
            } else if (node.material) {
                const newMat = node.material.clone();
                newMat.clippingPlanes = [];
                newMat.clipShadows = true;
                node.material = newMat;
            }
        }
    });

    clippingPlanes = {
        x: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
        y: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
        z: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
    };

    applyClippingPlanes(model);
}

function disableCutting(model) {
    if (!model || !isCuttingEnabled) return;
    isCuttingEnabled = false;

    model.traverse((node) => {
        if ((node.isMesh || node.isLine || node.isLineSegments || node.isLineLoop) && 
            originalMaterials.has(node)) {
            node.material = originalMaterials.get(node);
        }
    });

    clippingPlanes = { x: null, y: null, z: null };
}

function applyClippingPlanes(model) {
    if (!model || !isCuttingEnabled) return;

    const activePlanes = [];
    
    if (clippingPlanes.x) {
        if (invertedAxes.x) {
            clippingPlanes.x.normal.set(1, 0, 0);
            clippingPlanes.x.constant = -axisValues.x;
        } else {
            clippingPlanes.x.normal.set(-1, 0, 0);
            clippingPlanes.x.constant = axisValues.x;
        }
        if (axisValues.x < axisBounds.x.max) activePlanes.push(clippingPlanes.x);
    }
    
    if (clippingPlanes.y) {
        if (invertedAxes.y) {
            clippingPlanes.y.normal.set(0, 1, 0);
            clippingPlanes.y.constant = -axisValues.y;
        } else {
            clippingPlanes.y.normal.set(0, -1, 0);
            clippingPlanes.y.constant = axisValues.y;
        }
        if (axisValues.y < axisBounds.y.max) activePlanes.push(clippingPlanes.y);
    }
    
    if (clippingPlanes.z) {
        if (invertedAxes.z) {
            clippingPlanes.z.normal.set(0, 0, 1);
            clippingPlanes.z.constant = -axisValues.z;
        } else {
            clippingPlanes.z.normal.set(0, 0, -1);
            clippingPlanes.z.constant = axisValues.z;
        }
        if (axisValues.z < axisBounds.z.max) activePlanes.push(clippingPlanes.z);
    }

    applyClippingToAllObjects(model, activePlanes);
}

function applyClippingToAllObjects(root, activePlanes) {
    if (!root) return;
    
    root.traverse((node) => {
        if (node.isMesh || node.isLine || node.isLineSegments || node.isLineLoop) {
            if (Array.isArray(node.material)) {
                node.material.forEach(mat => {
                    mat.clippingPlanes = activePlanes;
                    mat.clipShadows = true;
                    mat.needsUpdate = true;
                });
            } else if (node.material) {
                node.material.clippingPlanes = activePlanes;
                node.material.clipShadows = true;
                node.material.needsUpdate = true;
            }
        }
    });
}

export function updateModelBounds() {
    computeModelBounds(modelRef);
}

export default {
    initCuttingTool,
    enableCutting,
    disableCutting,
    updateModelBounds
};