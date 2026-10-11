/**
 * Плагин «Вид»: контроль отображения 3D-сцены.
 * Тени (DirectionalLight + ShadowMaterial), солнце (азимут/высота/плотность),
 * виртуальные стены для AR, адаптивная сетка, рёбра модели, HSV-цвет.
 * Состояние сохраняется в localStorage; при деактивации объекты удаляются.
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';

// ============================================================
// КОНСТАНТЫ
// ============================================================

const STORAGE_KEY = 'pluginViewDisplay';
const GRID_OPACITY = 0.5;

/** Состояние по умолчанию при первом запуске (дефолты стен — в литерале _walls) */
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

// Границы виртуальных стен
const WALL_DISTANCE_MIN = 0.3, WALL_DISTANCE_MAX = 3.0;
const FLOOR_HEIGHT_MIN = -1, FLOOR_HEIGHT_MAX = 1;
const WALL_HEIGHT_FACTOR = 3;  // высота стены = высота модели × 3
const WALL_WIDTH_FACTOR = 3;   // ширина стены = max(ширина, глубина) × 3
const FLOOR_DEFAULT_SIZE_FACTOR = 4;  // размер пола без стен = max размер модели × 4
const FLOOR_MIN_SIZE = 20;            // минимальный размер пола
const SHADOW_FIT_MARGIN = 1.08;       // запас автоподгонки тени под модель (PCF-размытие + normalBias)
const WALLS_ROTATION_MIN = 0, WALLS_ROTATION_MAX = 360;  // диапазон слайдера поворота

/**
 * Базовая ориентация стен (до поворота). PlaneGeometry лежит в XY (нормаль +Z);
 * direction — единичный вектор к стене в XZ; rotationY поворачивает нормаль к модели.
 * Эффективная ориентация: _wallsBaseYaw (фиксируется при включении) + _wallsRotation (слайдер),
 * см. _getWallAxis.
 */
const WALL_AXES_BASE = {
    back:  { direction: new THREE.Vector3(0, 0, -1), rotationY: 0 },
    right: { direction: new THREE.Vector3(1, 0, 0),  rotationY: -Math.PI / 2 },
    left:  { direction: new THREE.Vector3(-1, 0, 0), rotationY:  Math.PI / 2 },
};

const PRESETS = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db'];

// ============================================================
// ВЫЧИСЛЕНИЕ АЗИМУТА КАМЕРЫ ДЛЯ СТЕН
// ============================================================

/**
 * Вычисляет азимут камеры в градусах (0-360) относительно центра модели.
 * Азимут = угол направления «от модели к камере» в XZ-плоскости,
 * отсчитываемый от +Z по часовой стрелке (при взгляде сверху).
 *
 * Fallback при фиксации базы стен: используется при почти вертикальном взгляде,
 * когда проекция направления взгляда на XZ вырождена (см. _getWallsBaseYaw).
 */
function _getCameraAzimuthDeg() {
    if (!_api?.camera || !_api?.model) return 0;
    const targetPos = new THREE.Vector3();
    _api.model.getWorldPosition(targetPos);
    const cameraPos = new THREE.Vector3();
    _api.camera.getWorldPosition(cameraPos);
    const dx = cameraPos.x - targetPos.x;
    const dz = cameraPos.z - targetPos.z;
    // atan2(dx, dz) даёт угол от +Z по часовой стрелке (при взгляде сверху)
    let deg = THREE.MathUtils.radToDeg(Math.atan2(dx, dz));
    if (deg < 0) deg += 360;
    return deg;
}

/**
 * Эффективный поворот стен (в радианах) = база, зафиксированная в момент
 * включения стен (_wallsBaseYaw), + доворот слайдером (_wallsRotation).
 */
function _getEffectiveWallsRotationRad() {
    return _wallsBaseYaw + THREE.MathUtils.degToRad(_wallsRotation);
}

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

// Сторонние источники света, созданные в engine.js (setupLights):
// AmbientLight и FillLight «заливают» тень светом, поэтому при opacity=1
// тень на модели выглядит полупрозрачной (остаётся ~70% освещённости).
// Чтобы тень на модели визуально соответствовала тени на полу (которая
// через ShadowMaterial становится полностью чёрной), мы компенсируем
// эти источники пропорционально shadowOpacity.
let _ambientLight = null;
let _ambientLightBaseIntensity = 0;
let _fillLight = null;
let _fillLightBaseIntensity = 0;

// === Виртуальные стены (для AR: ловят тень модели, не отбрасывают свою) ===
// Стена = receiver (ShadowMaterial) + floorLine (золотистая линия на полу).
// Пол обрезается по границам включённых стен, стены упираются друг в друга
// (см. _updateFloorBounds, _positionWall).
let _walls = {
    back:  { enabled: false, distance: 1.0, receiver: null, floorLine: null },
    right: { enabled: false, distance: 1.0, receiver: null, floorLine: null },
    left:  { enabled: false, distance: 1.0, receiver: null, floorLine: null },
};
// Опорная база стен фиксируется в момент включения первой стены (_ensureWallReference):
// центр/размеры модели + базовый yaw (перпендикулярно оси камеры).
// После фиксации поворот модели и движение камеры стены не двигают.
let _wallRef = null;    // { center: THREE.Vector3, size: THREE.Vector3, minY: number } | null
let _wallsBaseYaw = 0;  // базовый yaw стен в радианах (зафиксирован при включении)
let _wallsRotation = 0; // доворот стен слайдером вокруг модели (градусы, 0-360)
let _floorHeightOffset = 0;
let _wallPanelEl = null;
let _wallPanelVisible = false;
let _wallOutsideClickHandler = null;

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

// E13: drag-слушатели документа висят только во время перетаскивания слайдеров цвета/металла.
let _activeDragDetach = null; // сниматель текущего drag (вызывается и в _cleanup)

// Контейнер всплывающих панелей: собственная панель инструментов, а не глобальный .plugin-panels.
let _panelsContainer = null;

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
    // E13: дебаунс 250 мс — слайдеры 'input' не пишут localStorage на каждый пиксель.
    if (_saveStateTimer !== null) return;
    _saveStateTimer = setTimeout(() => { _saveStateTimer = null; _saveStateNow(); }, 250);
}

let _saveStateTimer = null;

function _saveStateNow() {
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
            roughness: _roughness,
            walls: {
                back:  { enabled: _walls.back.enabled,  distance: _walls.back.distance  },
                right: { enabled: _walls.right.enabled, distance: _walls.right.distance },
                left:  { enabled: _walls.left.enabled,  distance: _walls.left.distance  },
            },
            wallsRotation: _wallsRotation,
            floorHeightOffset: _floorHeightOffset
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
    // Только #rrggbb — короткий формат давал бы мусорные каналы.
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return { r: 204, g: 204, b: 204 };
    }
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
    // near/far — стартовые значения, пересчитываются в _updateSunPosition.
    _cameraLight.shadow.camera.near = 0.5;
    _cameraLight.shadow.camera.far = 500;
    _cameraLight.shadow.bias = 0;
    _cameraLight.shadow.normalBias = 0.02;
    _cameraLight.shadow.radius = 4;
    // Плотность тени на мешах модели: по умолчанию 1.0 (полная тень).
    // Устанавливаем из сохранённого состояния — иначе при первом включении
    // плагина тень на модели была бы полной (1.0), а на полу — _shadowOpacity.
    if (typeof _cameraLight.shadow.intensity === 'number') {
        _cameraLight.shadow.intensity = _shadowOpacity;
    }
    _api.scene.add(_cameraLight);
    // .target обязательно в сцену — иначе DirectionalLight целит в мировой origin (lookAt no-op).
    _cameraLight.target.position.set(0, 0, 0);
    _api.scene.add(_cameraLight.target);
}

function _removeCameraLight() {
    if (_cameraLight && _api && _api.scene) {
        _api.scene.remove(_cameraLight);
        _api.scene.remove(_cameraLight.target);
        _cameraLight.dispose && _cameraLight.dispose();
    }
    _cameraLight = null;
}

/**
 * Находим в сцене сторонние источники света (созданные в engine.js setupLights),
 * которые «заливают» тень на модели светом:
 *   - AmbientLight (1.4) — равномерный фоновый свет, видимый в тени;
 *   - DirectionalLight снизу (1.3, position (0,-10,0)) — fillLight, освещает
 *     нижнюю часть модели и также виден в тени.
 *
 * Без компенсации этих источников тень на мешах модели при shadowOpacity=1
 * остаётся полупрозрачной (остаётся ~70% освещённости), тогда как тень на полу
 * (через ShadowMaterial) становится полностью чёрной. Это создаёт визуальное
 * несоответствие, описанное пользователем.
 *
 * Решение: при росте shadowOpacity пропорционально уменьшать интенсивность
 * этих источников, чтобы тень на модели визуально соответствовала тени на полу.
 * При shadowOpacity=0 — исходная интенсивность; при shadowOpacity=1 — 25%
 * от исходной (тень становится тёмной, но не абсолютно чёрной — иначе сцена
 * выглядит неестественно).
 */
function _discoverAmbientLights() {
    if (!_api || !_api.scene) return;
    _ambientLight = null;
    _ambientLightBaseIntensity = 0;
    _fillLight = null;
    _fillLightBaseIntensity = 0;

    _api.scene.traverse(obj => {
        if (obj.isAmbientLight && !_ambientLight) {
            _ambientLight = obj;
            _ambientLightBaseIntensity = obj.intensity;
        } else if (obj.isDirectionalLight && obj !== _cameraLight) {
            // FillLight в engine.js имеет position (0,-10,0) — направление вверх.
            // Основной DirectionalLight в engine.js имеет position (0,50,0) — направление вниз.
            // Компенсируем fillLight (тот, что светит снизу), потому что он сильнее
            // всего «заливает» тень на нижних гранях модели. Основной DirectionalLight
            // сверху не так критичен — он не заливает тень от _cameraLight, потому что
            // их направления различны.
            if (obj.position.y < 0 && !_fillLight) {
                _fillLight = obj;
                _fillLightBaseIntensity = obj.intensity;
            }
        }
    });
}

/**
 * Коэффициент компенсации фоновых источников света в зависимости от плотности тени.
 * При shadowOpacity=0 → k=1.0 (без компенсации, исходная яркость).
 * При shadowOpacity=1 → k=0.25 (яркость падает до 25%, тень становится тёмной).
 * Нелинейная (квадратичная) кривая: компенсация ощутима только при высоких
 * значениях плотности, чтобы при 0-30% ползунка сцена оставалась хорошо освещённой.
 */
function _ambientCompensation(shadowOpacity) {
    // k = 1 - opacity^1.5 * 0.75
    // При opacity=0: k=1.0
    // При opacity=0.5: k=1 - 0.354*0.75 = 0.735 (близко к исходному)
    // При opacity=1.0: k=0.25 (тень становится тёмной)
    return 1.0 - Math.pow(shadowOpacity, 1.5) * 0.75;
}

// E12: переиспользуемые объекты горячего пути солнца (раньше создавались на каждый вызов).
const _sunTargetPos = new THREE.Vector3();
const _sunCameraPos = new THREE.Vector3();
const _sunOffset = new THREE.Vector3();
const _sunQuat = new THREE.Quaternion();
const _sunBox = new THREE.Box3();
const _sunSize = new THREE.Vector3();
const _sunCorner = new THREE.Vector3();

// E13: кэш геометрической части солнца (radius AABB, modelMaxXZ, modelSize, heightAboveFloor).
// Зависит только от модели/пола; камеры/стены пересчитывают дешёвую часть.
// Инвалидация: _onModelTransformed и при изменении высоты пола.
let _sunGeomCache = null;
function _invalidateSunGeomCache() { _sunGeomCache = null; }

/** E2: запрашивает один проход карты теней перед следующим рендером (autoUpdate=false). */
function _requestShadowUpdate() {
    if (_api && _api.renderer) _api.renderer.shadowMap.needsUpdate = true;
}

/** Пересчёт солнца/тени + мгновенный рендер (для слайдеров стен/пола, тумблера тени). */
function _refreshShadowing() {
    if (_shadowEnabled) _updateSunPosition(); // внутри — _requestShadowUpdate()
    _renderOnce();
}

// ============================================================
// ПОЗИЦИОНИРОВАНИЕ СОЛНЦА: азимут + высота (стабильная технология оригинала)
// ============================================================

function _updateSunPosition() {
    if (!_cameraLight || !_api.camera || !_api.model) return;

    const targetPos = _sunTargetPos;
    _api.model.getWorldPosition(targetPos);
    const cameraPos = _sunCameraPos;
    _api.camera.getWorldPosition(cameraPos);

    // Смещение света от камеры по азимуту/высоте (в локальном пространстве камеры)
    const az = THREE.MathUtils.degToRad(_shadowAzimuth);
    const el = THREE.MathUtils.degToRad(_shadowElevation);
    const dist = Math.max(cameraPos.distanceTo(targetPos) * 0.5, 8);

    const lightOffset = _sunOffset.set(
        Math.cos(el) * Math.cos(az),
        Math.sin(el),
        Math.cos(el) * Math.sin(az)
    ).multiplyScalar(dist);

    // Поворачиваем смещение вместе с камерой (как в оригинале)
    lightOffset.applyQuaternion(_sunQuat.copy(_api.camera.quaternion));

    _cameraLight.position.copy(cameraPos).add(lightOffset);
    // Целимся через light.target: для DirectionalLight направление света/тени
    // берётся из target.matrixWorld — lookAt на самом свете не влияет
    _cameraLight.target.position.copy(targetPos);
    _cameraLight.target.updateMatrixWorld();

    // Фрустум автоподгоняется под модель: radius = макс. расстояние от прицела света
    // до углов AABB. Полразмер radius накрывает всю модель и её тень при любом азимуте/высоте.
    // E13: обход модели (Box3 + 8 углов) только при отсутствии кэша.
    if (!_sunGeomCache) {
        const box = _sunBox.setFromObject(_api.model);
        const size = box.getSize(_sunSize);

        let radius = 0;
        let heightAboveFloor = 0;
        if (!box.isEmpty()) {
            const corner = _sunCorner;
            for (let i = 0; i < 8; i++) {
                corner.set(
                    (i & 1) ? box.max.x : box.min.x,
                    (i & 2) ? box.max.y : box.min.y,
                    (i & 4) ? box.max.z : box.min.z
                );
                const d = corner.distanceTo(targetPos);
                if (d > radius) radius = d;
            }
            // Высота цели света над полом; глубина до пола вдоль оси света считается ниже.
            const floorY = box.min.y + _floorHeightOffset;
            heightAboveFloor = Math.max(targetPos.y - floorY, 0);
        }
        _sunGeomCache = {
            radius,
            heightAboveFloor,
            modelMaxXZ: Math.max(size.x, size.z),
            modelSize: size.length(),
        };
    }
    const { radius, heightAboveFloor, modelMaxXZ, modelSize } = _sunGeomCache;

    // Стены расширяют фрустум (AR: тень на стене). E13: дешёвый расчёт без обхода модели.
    let wallExtent = 0;
    for (const id of ['back', 'right', 'left']) {
        if (_walls[id]?.enabled) {
            const wd = Math.max(modelMaxXZ * 0.5, 1) * _walls[id].distance;
            if (wd > wallExtent) wallExtent = wd;
        }
    }

    const shadowCam = _cameraLight.shadow.camera;
    const axisDist = Math.max(_cameraLight.position.distanceTo(targetPos), 0.5);
    const dirY = Math.abs(_cameraLight.position.y - targetPos.y) / axisDist;    // синус высоты оси
    const dirXZ = Math.hypot(_cameraLight.position.x - targetPos.x,
                             _cameraLight.position.z - targetPos.z) / axisDist; // косинус высоты

    const frustumSize = Math.max(radius * SHADOW_FIT_MARGIN + wallExtent, 5);
    shadowCam.left = -frustumSize;
    shadowCam.right = frustumSize;
    shadowCam.top = frustumSize;
    shadowCam.bottom = -frustumSize;
    // near/far по фактической оси «свет → модель».
    shadowCam.near = Math.max(0.5, axisDist - radius * 2);
    // Знаменатель ограничен снизу 0.2 — иначе far улетает в бесконечность у горизонта.
    shadowCam.far = axisDist + radius * 2 + heightAboveFloor / Math.max(dirY, 0.2)
                  + wallExtent / Math.max(dirXZ, 0.2);
    shadowCam.updateProjectionMatrix();

    // Адаптивный bias: вблизи — 0 (тень плотная), вдалеке — -0.0004 (нет мерцания)
    const d = cameraPos.distanceTo(targetPos);
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

    _requestShadowUpdate();
}

function _applyShadowOpacity() {
    // 1. Тень на полу и стенах: это отдельные плоскости с ShadowMaterial,
    //    их прозрачность регулируется через material.opacity.
    if (_shadowPlane?.material) _shadowPlane.material.opacity = _shadowOpacity;
    for (const id of ['back', 'right', 'left']) {
        if (_walls[id]?.receiver?.material) _walls[id].receiver.material.opacity = _shadowOpacity;
    }
    // 2. Тень на самой модели (мешы с receiveShadow:true): её плотность
    //    определяется не материалом меша, а интенсивностью тени в shadow map.
    //    Начиная с three.js r155 у LightShadow появилось свойство `intensity`
    //    (по умолчанию 1.0) — оно управляет mix(1.0, shadow, intensity) в шейдере
    //    и применяется ко всем объектам, получающим тень, включая саму модель.
    //    Именно поэтому ранее ползунок «Плотность» менял тень на полу, но не
    //    менял тень, которую модель бросает сама на себя (на своих мешах).
    if (_cameraLight?.shadow) {
        _cameraLight.shadow.intensity = _shadowOpacity;
    }
    // 3. Компенсация фоновых источников света (AmbientLight, FillLight):
    //    при shadowOpacity=1 тень на модели через shadow.intensity становится
    //    «математически полной», но визуально остаётся полупрозрачной, потому
    //    что AmbientLight и FillLight заливают тень светом (~70% освещённости).
    //    Уменьшаем их пропорционально, чтобы тень на модели стала сравнимо
    //    тёмной с тенью на полу. Используем нелинейную кривую, чтобы при малых
    //    значениях ползунка (0-30%) компенсация была минимальной и сцена
    //    оставалась хорошо освещённой.
    const k = _ambientCompensation(_shadowOpacity);
    if (_ambientLight) _ambientLight.intensity = _ambientLightBaseIntensity * k;
    if (_fillLight)    _fillLight.intensity    = _fillLightBaseIntensity    * k;
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
    // Геометрия создаётся/пересоздаётся в _updateFloorBounds — там же позиция.
    const planeMat = new THREE.ShadowMaterial({ opacity: 0.35, color: 0x000000 });
    planeMat.depthWrite = false;
    _shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
    _shadowPlane.rotation.x = -Math.PI / 2;
    _shadowPlane.receiveShadow = true;
    _shadowPlane.visible = _shadowEnabled;
    _api.scene.add(_shadowPlane);
    _updateFloorBounds();
}

function _removeShadowPlane() {
    if (_shadowPlane && _api && _api.scene) {
        _api.scene.remove(_shadowPlane);
        _shadowPlane.geometry.dispose();
        _shadowPlane.material.dispose();
    }
    _shadowPlane = null;
}

/**
 * Пересчитывает границы пола по текущим стенам.
 * Пол — прямоугольник, выровненный по осям стен; включённая стена обрезает пол по своей
 * внутренней грани (тень стены падает вне пола). Без стен — большой квадрат.
 * Ориентация/позиция определяются базой стен (_wallRef); до фиксации — следует за моделью.
 */
function _updateFloorBounds() {
    if (!_shadowPlane || !_api?.model) return;

    const m = _getWallMetrics();
    const size = m.size;
    const maxDim = Math.max(size.x, size.y, size.z);
    const modelMaxXZ = Math.max(size.x, size.z);

    // Базовый (большой) размер пола — когда соответствующая стена выключена.
    const baseHalf = Math.max(maxDim * FLOOR_DEFAULT_SIZE_FACTOR / 2, FLOOR_MIN_SIZE / 2);

    // Дистанция от центра модели до стены в локальной системе стен.
    const wallDist = (wallId) => Math.max(modelMaxXZ * 0.5, 1) * _walls[wallId].distance;

    // Локальные границы пола (в системе координат стен, до поворота).
    // X — ось left↔right, Z — ось back↔front.
    let localMinX = -baseHalf;
    let localMaxX = baseHalf;
    let localMinZ = -baseHalf;
    let localMaxZ = baseHalf;

    if (_walls.left.enabled)  localMinX = -wallDist('left');
    if (_walls.right.enabled) localMaxX =  wallDist('right');
    if (_walls.back.enabled)  localMinZ = -wallDist('back');
    // Передней стены нет — localMaxZ всегда = baseHalf.

    const w = Math.max(localMaxX - localMinX, 0.1);
    const h = Math.max(localMaxZ - localMinZ, 0.1);
    // Локальный центр прямоугольника пола (относительно центра модели).
    const localCenterX = (localMinX + localMaxX) / 2;
    const localCenterZ = (localMinZ + localMaxZ) / 2;

    // Поворот локального центра в мировые координаты.
    const yawRad = _getEffectiveWallsRotationRad();
    const localOffset = new THREE.Vector3(localCenterX, 0, localCenterZ);
    localOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), yawRad);
    const worldCenter = m.center.clone().add(localOffset);

    // Геометрию пересоздаём только при изменении размеров (функция может зваться часто).
    const params = _shadowPlane.geometry.parameters;
    if (!params || Math.abs(params.width - w) > 0.001 || Math.abs(params.height - h) > 0.001) {
        _shadowPlane.geometry.dispose();
        _shadowPlane.geometry = new THREE.PlaneGeometry(w, h);
    }

    _shadowPlane.position.set(worldCenter.x, m.minY + _floorHeightOffset, worldCenter.z);
    // rotation.order = 'YXZ' → сначала Y (поворот вокруг вертикали), потом X (наклон в горизонталь).
    // Это даёт горизонтальный прямоугольник, повёрнутый вокруг вертикальной оси.
    _shadowPlane.rotation.order = 'YXZ';
    _shadowPlane.rotation.y = yawRad;
    _shadowPlane.rotation.x = -Math.PI / 2;
}

// ============================================================
// ВИРТУАЛЬНЫЕ СТЕНЫ (для AR: ловят тень модели, не отбрасывают свою)
// ============================================================
//
// receiver  (ShadowMaterial, castShadow:false, receiveShadow:true) — рисует тень
//           модели на стене, сама тень не отбрасывает.
// floorLine — золотистая линия на полу (видна при открытой панели).
//
// Стены упираются друг в друга: back обрезается по left/right, right/left — по back.
// Пол ограничен стенами (см. _updateFloorBounds) — тень стены падает вне пола.
//
// Ориентация фиксируется в момент включения первой стены (_ensureWallReference):
// back ставится за моделью перпендикулярно оси камеры; после фиксации поворот
// модели и движение камеры стены не двигают (критично для AR — совпадение с реальной
// стеной). Слайдер «Поворот стен» доворачивает вокруг центра. При выключении всех
// стен база сбрасывается. Fallback при вертикальном взгляде — азимут камеры.

/**
 * Возвращает актуальную ориентацию стены с учётом зафиксированной базы
 * (_wallsBaseYaw) и доворота слайдером (_wallsRotation).
 */
function _getWallAxis(wallId) {
    const base = WALL_AXES_BASE[wallId];
    if (!base) return null;
    const yawRad = _getEffectiveWallsRotationRad();
    if (yawRad === 0) return base;  // без поворота — отдаём базовую константу
    const direction = base.direction.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yawRad);
    return { direction, rotationY: base.rotationY + yawRad };
}

/**
 * Базовый yaw стен (в радианах) на момент включения: задняя стенка — за моделью,
 * перпендикулярно оси камеры. Ось камеры = направление взгляда (проекция на XZ).
 * Fallback — азимут позиции камеры, если взгляд почти вертикальный.
 */
function _getWallsBaseYaw() {
    if (_api?.camera) {
        const dir = new THREE.Vector3();
        _api.camera.getWorldDirection(dir);
        dir.y = 0;
        if (dir.lengthSq() > 1e-4) {
            dir.normalize();
            // back-стена ставится по направлению взгляда (за моделью):
            // backDir = (-sin(yaw), 0, -cos(yaw)) = dir → yaw = atan2(-dir.x, -dir.z)
            return Math.atan2(-dir.x, -dir.z);
        }
    }
    return THREE.MathUtils.degToRad(_getCameraAzimuthDeg());
}

/**
 * Фиксирует опорную базу стен (однократно, до выключения всех стен):
 * центр/размеры/нижняя грань модели + базовый yaw по оси камеры.
 * После фиксации стены и пол не зависят от поворота модели и положения камеры.
 */
function _ensureWallReference() {
    if (_wallRef || !_api?.model) return;
    const box = new THREE.Box3().setFromObject(_api.model);
    const size = box.getSize(new THREE.Vector3());
    _wallRef = {
        center: box.getCenter(new THREE.Vector3()),
        size,
        minY: box.min.y,
    };
    _wallsBaseYaw = _getWallsBaseYaw();
}

/**
 * Метрики для расчёта стен и пола: зафиксированная база или живой AABB модели.
 * E13: без базы AABB кэшируется (инвалидация — 'model-transformed').
 */
let _liveMetricsCache = null;

function _getWallMetrics() {
    if (_wallRef) return _wallRef;
    if (_liveMetricsCache) return _liveMetricsCache;
    const box = new THREE.Box3().setFromObject(_api.model);
    const size = box.getSize(new THREE.Vector3());
    _liveMetricsCache = { center: box.getCenter(new THREE.Vector3()), size, minY: box.min.y };
    return _liveMetricsCache;
}

function _createWall(wallId) {
    if (!_api || !_api.scene || !_api.model) return;
    const wall = _walls[wallId];
    const axis = _getWallAxis(wallId);
    if (!wall || !axis || wall.receiver) return;

    // Receiver: castShadow:false (не отбрасывает тень), receiveShadow:true (ловит тень модели).
    // Стартовая геометрия 1×1 — реальный размер задаёт _positionWall.
    const receiverMat = new THREE.ShadowMaterial({
        opacity: _shadowOpacity,
        color: 0x000000,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    const receiver = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), receiverMat);
    receiver.castShadow = false;
    receiver.receiveShadow = true;
    receiver.visible = _shadowEnabled;
    _api.scene.add(receiver);

    // Floor line — золотистая линия на полу. Длина пересоздаётся в _positionWall.
    const floorLineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.5, 0, 0),
        new THREE.Vector3(0.5, 0, 0),
    ]);
    const floorLineMat = new THREE.LineBasicMaterial({
        color: 0xffd060,
        transparent: true,
        opacity: 0.9,
    });
    const floorLine = new THREE.LineSegments(floorLineGeo, floorLineMat);
    floorLine.visible = _wallPanelVisible;
    _api.scene.add(floorLine);

    wall.receiver = receiver;
    wall.floorLine = floorLine;
    _positionWall(wallId);
}

function _removeWall(wallId) {
    const wall = _walls[wallId];
    if (!wall) return;

    if (wall.receiver) {
        _api?.scene?.remove(wall.receiver);
        wall.receiver.geometry.dispose();
        wall.receiver.material.dispose();
        wall.receiver = null;
    }
    if (wall.floorLine) {
        _api?.scene?.remove(wall.floorLine);
        wall.floorLine.geometry.dispose();
        wall.floorLine.material.dispose();
        wall.floorLine = null;
    }
}

/**
 * Позиционирует стену и пересчитывает её ширину с учётом соседей.
 * Back обрезается по left/right, right/left — по back (упираются друг в друга).
 * Геометрия пересоздаётся только при изменении ширины.
 */
function _positionWall(wallId) {
    const wall = _walls[wallId];
    const axis = _getWallAxis(wallId);
    if (!wall?.receiver || !axis || !_api?.model) return;

    // Позиция/размер — от зафиксированной базы _wallRef (стены стоят на месте
    // при повороте модели); до фиксации базы — от живого AABB.
    const m = _getWallMetrics();
    const modelMaxXZ = Math.max(m.size.x, m.size.z);
    const wallW = modelMaxXZ * WALL_WIDTH_FACTOR;
    const wallH = Math.max(m.size.y, 1) * WALL_HEIGHT_FACTOR;

    // Дистанция от центра модели до стены (в локальной системе, до поворота).
    const distOf = (id) => Math.max(modelMaxXZ * 0.5, 1) * _walls[id].distance;
    const dist = distOf(wallId);

    // Вычисляем границы стены в локальной системе (до поворота).
    // Для back: X-границы (стена идёт по X).
    // Для right/left: Z-границы (стена идёт по Z).
    let extentStart, extentEnd;
    if (wallId === 'back') {
        extentStart = -wallW / 2;
        extentEnd = wallW / 2;
        if (_walls.left.enabled)  extentStart = -distOf('left');
        if (_walls.right.enabled) extentEnd =  distOf('right');
    } else {  // right или left
        extentStart = -wallW / 2;
        extentEnd = wallW / 2;
        if (_walls.back.enabled) extentStart = -distOf('back');
        // Передней стены нет — extentEnd остаётся +wallW/2.
    }

    const wallWidth = Math.max(extentEnd - extentStart, 0.1);
    const wallCenterAlongAxis = (extentStart + extentEnd) / 2;

    // Позиция центра стены в локальной системе (относительно модели).
    // Back:  (wallCenterAlongAxis, 0, -dist)     — стена на -Z, центр смещён по X
    // Right: (dist, 0, wallCenterAlongAxis)      — стена на +X, центр смещён по Z
    // Left:  (-dist, 0, wallCenterAlongAxis)     — стена на -X, центр смещён по Z
    let localCenter;
    if (wallId === 'back') {
        localCenter = new THREE.Vector3(wallCenterAlongAxis, 0, -dist);
    } else if (wallId === 'right') {
        localCenter = new THREE.Vector3(dist, 0, wallCenterAlongAxis);
    } else {  // left
        localCenter = new THREE.Vector3(-dist, 0, wallCenterAlongAxis);
    }

    // Поворот локального центра в мировую систему.
    const yawRad = _getEffectiveWallsRotationRad();
    localCenter.applyAxisAngle(new THREE.Vector3(0, 1, 0), yawRad);
    const worldPos = m.center.clone().add(localCenter);

    const floorY = m.minY + _floorHeightOffset;
    const wallCenterY = floorY + wallH / 2;

    // Пересоздаём геометрию receiver если ширина изменилась.
    const currentWidth = wall.receiver.geometry.parameters?.width;
    if (!currentWidth || Math.abs(currentWidth - wallWidth) > 0.001) {
        wall.receiver.geometry.dispose();
        wall.receiver.geometry = new THREE.PlaneGeometry(wallWidth, wallH);

        // Пересоздаём и линию на полу — её длина = ширине стены.
        if (wall.floorLine) {
            wall.floorLine.geometry.dispose();
            wall.floorLine.geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(-wallWidth / 2, 0, 0),
                new THREE.Vector3(wallWidth / 2, 0, 0),
            ]);
        }
    }

    // Позиция и поворот receiver (вертикальная плоскость).
    wall.receiver.position.set(worldPos.x, wallCenterY, worldPos.z);
    wall.receiver.rotation.set(0, axis.rotationY, 0);

    // Позиция и поворот floorLine (горизонтальная линия на полу).
    // Y = floorY + 0.01 чтобы избежать z-fighting с полом.
    if (wall.floorLine) {
        wall.floorLine.position.set(worldPos.x, floorY + 0.01, worldPos.z);
        wall.floorLine.rotation.set(0, axis.rotationY, 0);
    }
}

function _positionAllWalls() {
    for (const id of ['back', 'right', 'left']) {
        if (_walls[id]?.receiver) _positionWall(id);
    }
}

function _setWallEnabled(wallId, enabled) {
    if (!_walls[wallId]) return;
    // Флаг меняем ПЕРВЫМ: обрезка пола и ширина соседей видят актуальное состояние.
    _walls[wallId].enabled = enabled;
    if (enabled) {
        // Первое включение фиксирует базу стен (центр модели + yaw по оси камеры).
        _ensureWallReference();
        if (!_walls[wallId].receiver) _createWall(wallId);
    } else {
        _removeWall(wallId);
        // Все стены выключены — база сбрасывается, следующее включение зафиксует её заново.
        if (!_walls.back.enabled && !_walls.right.enabled && !_walls.left.enabled) _wallRef = null;
    }
    // Включение/выключение меняет границы пола и ширину соседних стен.
    _positionAllWalls();
    _updateFloorBounds();
    _refreshShadowing();
    _updateWallPanelUI();
    _saveState();
}

function _setWallDistance(wallId, dist) {
    if (!_walls[wallId]) return;
    _walls[wallId].distance = THREE.MathUtils.clamp(dist, WALL_DISTANCE_MIN, WALL_DISTANCE_MAX);
    _positionAllWalls();
    _updateFloorBounds();
    _refreshShadowing();
    _updateWallPanelUI();
    _saveState();
}

function _setFloorHeight(val) {
    _floorHeightOffset = THREE.MathUtils.clamp(val, FLOOR_HEIGHT_MIN, FLOOR_HEIGHT_MAX);
    _invalidateSunGeomCache();
    _updateFloorBounds();
    _positionAllWalls();
    _refreshShadowing();
    _updateWallPanelUI();
    _saveState();
}

function _setWallsRotation(deg) {
    _wallsRotation = THREE.MathUtils.clamp(deg, WALLS_ROTATION_MIN, WALLS_ROTATION_MAX);
    // Поворот меняет ориентацию всех стен и пола.
    _positionAllWalls();
    _updateFloorBounds();
    _refreshShadowing();
    _updateWallPanelUI();
    _saveState();
}

function _resetWalls() {
    for (const id of ['back', 'right', 'left']) {
        if (_walls[id].enabled) _setWallEnabled(id, false);
        _walls[id].distance = 1.0;
    }
    _wallsRotation = 0;
    _floorHeightOffset = 0;
    _updateFloorBounds();
    _updateWallPanelUI();
    _saveState();
}

function _updateWallFloorLinesVisibility() {
    for (const id of ['back', 'right', 'left']) {
        if (_walls[id]?.floorLine) _walls[id].floorLine.visible = _wallPanelVisible;
    }
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
            child.add(edges);
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
                if (sub.isLineSegments) toRemove.push(sub);
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
    _applyEdgeColorFromHex(settings.modelColor || '#CCCCCC');
}

// ============================================================
// ЦВЕТ МОДЕЛИ
// ============================================================

function _applyModelColor(hexColor) {
    if (!_api || !_api.model || !hexColor) return;
    const modelColor = new THREE.Color(hexColor);
    _forEachMeshMaterial(m => { if (m.color) m.color.copy(modelColor); });
    _applyEdgeColorFromHex(hexColor);
}

/** Единый обход материалов всех мешей модели. В GLTF материал может быть массивом. */
function _forEachMeshMaterial(callback) {
    if (!_api || !_api.model) return;
    _api.model.traverse(child => {
        if (!child.isMesh || !child.material) return;
        (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => {
            if (m) callback(m);
        });
    });
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
    _forEachMeshMaterial(m => { m.metalness = value; });
    _renderOnce();
}

function _applyRoughness(value) {
    _forEachMeshMaterial(m => { m.roughness = value; });
    _renderOnce();
}

/** Мгновенный рендер — без него слайдеры отстают (idle-цикл рисует 1 fps). */
function _renderOnce() {
    if (_api && _api.renderer && _api.scene && _api.camera) {
        _api.renderer.render(_api.scene, _api.camera);
    }
}

// ============================================================
// ТОГЛЫ
// ============================================================

function _toggleShadow() {
    _shadowEnabled = !_shadowEnabled;
    if (_cameraLight) _cameraLight.castShadow = _shadowEnabled;
    if (_shadowPlane) _shadowPlane.visible = _shadowEnabled;
    // Синхронизируем видимость receiver-плоскостей стен с общим тумблером тени.
    for (const id of ['back', 'right', 'left']) {
        if (_walls[id]?.receiver) _walls[id].receiver.visible = _shadowEnabled;
    }
    _refreshShadowing();
    _updateShadowUI();
    _updateSunPanelUI();
    _saveState();
}

function _toggleWallPanel() {
    _wallPanelVisible ? _hideWallPanel() : _showWallPanel();
}

function _toggleSunPanel() {
    _sunPanelVisible ? _hideSunPanel() : _showSunPanel();
}

function _setShadowAzimuth(deg) {
    _shadowAzimuth = THREE.MathUtils.clamp(deg, AZIMUTH_MIN, AZIMUTH_MAX);
    _updateSunPosition();
    _renderOnce(); // мгновенный отклик при 1 к/с idle-рендера
    _updateSunPanelUI();
    _saveState();
}

function _setShadowElevation(deg) {
    _shadowElevation = THREE.MathUtils.clamp(deg, ELEVATION_MIN, ELEVATION_MAX);
    _updateSunPosition();
    _renderOnce();
    _updateSunPanelUI();
    _saveState();
}

function _setShadowOpacity(val) {
    _shadowOpacity = THREE.MathUtils.clamp(val, OPACITY_MIN, OPACITY_MAX);
    _applyShadowOpacity();
    // Карта теней не пересчитывается (тень та же) — но uniforms shadowIntensity
    // у шейдера мешей меняется через _applyShadowOpacity(), поэтому достаточно
    // одного рендера кадра, чтобы увидеть результат.
    _renderOnce();
    _updateSunPanelUI();
    _saveState();
}

function _toggleGrid() {
    _gridVisible = !_gridVisible;
    _updateGridOrientation(); // применить видимость сразу
    _renderOnce();            // мгновенный отклик при 1 к/с idle-рендера
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
// UI: общий жизненный цикл всплывающих панелей (солнце/стены/цвет)
// ============================================================

/** outside-обработчик «закрыть тапом вне панели/кнопки» с отложенной регистрацией
 * (чтобы открывающий клик не закрыл панель). Снимается через _removeOutsideClick. */
function _registerPanelAutoClose(panelEl, btnId, getVisible, hideFn) {
    const outsideHandler = e => {
        if (!panelEl.contains(e.target) &&
            !document.getElementById(btnId)?.contains(e.target)) {
            hideFn();
        }
    };
    setTimeout(() => { if (getVisible()) _addDocHandler('pointerdown', outsideHandler); }, 0);
    return outsideHandler;
}

/** Снимает outside-обработчик с документа (оставляет _docHandlers консистентным). */
function _removeOutsideClick(handler) {
    if (!handler) return;
    _docHandlers = _docHandlers.filter(h => h.handler !== handler);
    document.removeEventListener('pointerdown', handler);
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
    const container = _panelsContainer || document.querySelector('.plugin-panels') || document.getElementById('model-container');
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

    _sunOutsideClickHandler = _registerPanelAutoClose(_sunPanelEl, 'vd-sun-btn', () => _sunPanelVisible, _hideSunPanel);
}

function _hideSunPanel() {
    if (!_sunPanelEl) return;
    _sunPanelVisible = false;
    _sunPanelEl.classList.remove('visible');
    _updateSunBtnUI();

    _removeOutsideClick(_sunOutsideClickHandler);
    _sunOutsideClickHandler = null;
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
// UI: панель «Стены» (3 тумблера + 3 слайдера дистанции + высота пола + сброс)
// ============================================================

function _createWallPanel() {
    if (_wallPanelEl) return;
    _injectStyles();

    const el = document.createElement('div');
    el.className = 'vd-wall-panel';
    el.innerHTML = `
        <div class="vd-wall-row">
            <button type="button" class="vd-wall-toggle" id="vd-wall-back-toggle" data-wall="back">Задняя</button>
            <input type="range" id="vd-wall-back-dist" class="vd-wall-slider"
                   min="${WALL_DISTANCE_MIN}" max="${WALL_DISTANCE_MAX}" step="0.05" value="${_walls.back.distance}">
            <span class="vd-wall-value" id="vd-wall-back-val">${_walls.back.distance.toFixed(2)}×</span>
        </div>
        <div class="vd-wall-row">
            <button type="button" class="vd-wall-toggle" id="vd-wall-right-toggle" data-wall="right">Правая</button>
            <input type="range" id="vd-wall-right-dist" class="vd-wall-slider"
                   min="${WALL_DISTANCE_MIN}" max="${WALL_DISTANCE_MAX}" step="0.05" value="${_walls.right.distance}">
            <span class="vd-wall-value" id="vd-wall-right-val">${_walls.right.distance.toFixed(2)}×</span>
        </div>
        <div class="vd-wall-row">
            <button type="button" class="vd-wall-toggle" id="vd-wall-left-toggle" data-wall="left">Левая</button>
            <input type="range" id="vd-wall-left-dist" class="vd-wall-slider"
                   min="${WALL_DISTANCE_MIN}" max="${WALL_DISTANCE_MAX}" step="0.05" value="${_walls.left.distance}">
            <span class="vd-wall-value" id="vd-wall-left-val">${_walls.left.distance.toFixed(2)}×</span>
        </div>
        <div class="vd-wall-divider"></div>
        <div class="vd-wall-row">
            <span class="vd-wall-label">Высота пола</span>
            <input type="range" id="vd-wall-floor" class="vd-wall-slider"
                   min="${FLOOR_HEIGHT_MIN}" max="${FLOOR_HEIGHT_MAX}" step="0.05" value="${_floorHeightOffset}">
            <span class="vd-wall-value" id="vd-wall-floor-val">${_floorHeightOffset.toFixed(2)}</span>
        </div>
        <div class="vd-wall-row">
            <span class="vd-wall-label">Поворот стен</span>
            <input type="range" id="vd-wall-rotation" class="vd-wall-slider"
                   min="${WALLS_ROTATION_MIN}" max="${WALLS_ROTATION_MAX}" step="5" value="${_wallsRotation}">
            <span class="vd-wall-value" id="vd-wall-rotation-val">${Math.round(_wallsRotation)}°</span>
        </div>
        <button type="button" class="vd-wall-reset" id="vd-wall-reset-btn">Сбросить стены</button>
        <div class="vd-wall-hint">Стены фиксируются в момент включения — перпендикулярно оси камеры, за моделью. Слайдер доворачивает их вокруг модели.</div>
    `;
    const container = _panelsContainer || document.querySelector('.plugin-panels') || document.getElementById('model-container');
    if (container) container.appendChild(el);
    _wallPanelEl = el;

    // Тумблеры стен
    for (const id of ['back', 'right', 'left']) {
        const toggle = el.querySelector(`#vd-wall-${id}-toggle`);
        if (toggle) {
            const h = () => _setWallEnabled(id, !_walls[id].enabled);
            toggle.addEventListener('click', h);
            _boundHandlers.push({ el: toggle, type: 'click', handler: h });
        }
        const slider = el.querySelector(`#vd-wall-${id}-dist`);
        if (slider) {
            const h = () => _setWallDistance(id, parseFloat(slider.value));
            slider.addEventListener('input', h);
            _boundHandlers.push({ el: slider, type: 'input', handler: h });
        }
    }

    // Слайдер высоты пола
    const floorSlider = el.querySelector('#vd-wall-floor');
    if (floorSlider) {
        const h = () => _setFloorHeight(parseFloat(floorSlider.value));
        floorSlider.addEventListener('input', h);
        _boundHandlers.push({ el: floorSlider, type: 'input', handler: h });
    }

    // Слайдер поворота стен
    const rotSlider = el.querySelector('#vd-wall-rotation');
    if (rotSlider) {
        const h = () => _setWallsRotation(parseFloat(rotSlider.value));
        rotSlider.addEventListener('input', h);
        _boundHandlers.push({ el: rotSlider, type: 'input', handler: h });
    }

    // Кнопка сброса
    const resetBtn = el.querySelector('#vd-wall-reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', _resetWalls);
        _boundHandlers.push({ el: resetBtn, type: 'click', handler: _resetWalls });
    }
}

function _showWallPanel() {
    _createWallPanel();
    _wallPanelVisible = true;
    _wallPanelEl.classList.add('visible');
    _updateWallFloorLinesVisibility();
    _updateWallBtnUI();
    _updateWallPanelUI();

    _wallOutsideClickHandler = _registerPanelAutoClose(_wallPanelEl, 'vd-wall-btn', () => _wallPanelVisible, _hideWallPanel);
}

function _hideWallPanel() {
    if (!_wallPanelEl) return;
    _wallPanelVisible = false;
    _wallPanelEl.classList.remove('visible');
    _updateWallFloorLinesVisibility();
    _updateWallBtnUI();

    _removeOutsideClick(_wallOutsideClickHandler);
    _wallOutsideClickHandler = null;
}

function _updateWallBtnUI() {
    const btn = document.getElementById('vd-wall-btn');
    if (!btn) return;
    const anyEnabled = _walls.back.enabled || _walls.right.enabled || _walls.left.enabled;
    btn.classList.toggle('panel-open', _wallPanelVisible);
    btn.classList.toggle('has-active', anyEnabled);
}

function _updateWallPanelUI() {
    for (const id of ['back', 'right', 'left']) {
        const toggle = document.getElementById(`vd-wall-${id}-toggle`);
        const slider = document.getElementById(`vd-wall-${id}-dist`);
        const val = document.getElementById(`vd-wall-${id}-val`);
        if (toggle) toggle.classList.toggle('active', _walls[id].enabled);
        if (slider) {
            slider.value = String(_walls[id].distance);
            slider.disabled = !_walls[id].enabled;
        }
        if (val) val.textContent = _walls[id].distance.toFixed(2) + '×';
    }
    const floorSlider = document.getElementById('vd-wall-floor');
    const floorVal = document.getElementById('vd-wall-floor-val');
    if (floorSlider) floorSlider.value = String(_floorHeightOffset);
    if (floorVal) floorVal.textContent = _floorHeightOffset.toFixed(2);
    const rotSlider = document.getElementById('vd-wall-rotation');
    const rotVal = document.getElementById('vd-wall-rotation-val');
    if (rotSlider) rotSlider.value = String(_wallsRotation);
    if (rotVal) rotVal.textContent = Math.round(_wallsRotation) + '°';
    _updateWallBtnUI();
}

// ============================================================
// СОБЫТИЙНЫЕ ОБНОВЛЕНИЯ (E2/E8: _onFrame удалён, плагин полностью событийный)
// ============================================================

/** Камера сдвинулась (OrbitControls 'change'): солнце следует за камерой,
 * видимость сетки зависит от направления взгляда. */
function _onControlsChange() {
    if (_shadowEnabled) _updateSunPosition();
    _updateGridOrientation();
}

/** Модель сдвинута/повернута/масштабирована (контракт 'model-transformed' от transform-gizmo). */
function _onModelTransformed() {
    _invalidateSunGeomCache();
    _liveMetricsCache = null;
    if (_shadowEnabled) _updateSunPosition();
    if (!_wallRef) _updateFloorBounds(); // пока стены не зафиксированы — пол следует за моделью
    // Граница событийной модели: во время анимации AABB меняется каждый кадр без событий —
    // тень/пол подстроятся по следующему событию. Для статичных сцен идентично покадровому.
}

/** Состав видимых деталей изменился (контракт 'model-visibility-changed'): при
 * autoUpdate=false нужен один проход глубины и мгновенный кадр. */
function _onModelVisibilityChanged() {
    _requestShadowUpdate();
    _renderOnce();
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
    _renderOnce();
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

/* === Панели «Солнце» и «Стены»: общая база === */
.vd-sun-panel,
.vd-wall-panel {
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
    max-width: 86vw;
    user-select: none;
    -webkit-user-select: none;
    z-index: 9997;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s;
}
.vd-sun-panel { min-width: 220px; }
.vd-wall-panel { min-width: 250px; }
.vd-sun-panel.visible,
.vd-wall-panel.visible {
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
.vd-sun-label,
.vd-wall-label {
    font-size: 11px;
    color: var(--text-color);
    opacity: 0.75;
    font-weight: 500;
    user-select: none;
    -webkit-user-select: none;
}
.vd-sun-value,
.vd-wall-value {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-color);
    text-align: right;
    font-variant-numeric: tabular-nums;
    opacity: 0.9;
}
.vd-sun-slider,
.vd-wall-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.15);
    outline: none;
    cursor: pointer;
}
.vd-sun-slider::-webkit-slider-thumb,
.vd-wall-slider::-webkit-slider-thumb {
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
.vd-sun-slider::-webkit-slider-thumb:hover,
.vd-wall-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
.vd-sun-slider::-webkit-slider-thumb:active,
.vd-wall-slider::-webkit-slider-thumb:active { transform: scale(0.95); }
.vd-sun-slider::-moz-range-thumb,
.vd-wall-slider::-moz-range-thumb {
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #ffd060;
    border: 2px solid rgba(255, 255, 255, 0.7);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
    cursor: pointer;
}
#vd-sun-btn.panel-open,
#vd-wall-btn.panel-open {
    background: rgba(255, 208, 96, 0.25);
    border-color: rgba(255, 208, 96, 0.6);
    box-shadow: 0 2px 8px rgba(255, 208, 96, 0.25);
}
#vd-sun-btn.panel-open svg,
#vd-wall-btn.panel-open svg { fill: #ffd060; }
@media (max-width: 768px) {
    .vd-sun-panel,
    .vd-wall-panel { padding: 8px 10px; gap: 6px; }
    .vd-sun-panel { min-width: 200px; }
    .vd-sun-slider-group { grid-template-columns: 50px 1fr 40px; gap: 6px; }
}

/* === Панель «Стены» (специфика; общая база — выше, у панели «Солнце») === */
.vd-wall-row {
    display: grid;
    grid-template-columns: 64px 1fr 44px;
    align-items: center;
    gap: 8px;
}
.vd-wall-divider {
    height: 1px;
    background: rgba(128, 128, 128, 0.2);
    margin: 2px 0;
}
.vd-wall-toggle {
    font-size: 11px;
    padding: 4px 6px;
    border: 1px solid rgba(128, 128, 128, 0.25);
    border-radius: 6px;
    background: transparent;
    color: var(--text-color);
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s, opacity 0.15s;
    opacity: 0.7;
}
.vd-wall-toggle:hover {
    background: rgba(255, 255, 255, 0.08);
    opacity: 1;
}
.vd-wall-toggle.active {
    background: rgba(255, 208, 96, 0.25);
    border-color: rgba(255, 208, 96, 0.6);
    color: #ffd060;
    opacity: 1;
}
.vd-wall-slider:disabled {
    opacity: 0.35;
    cursor: not-allowed;
}
.vd-wall-reset {
    margin-top: 2px;
    padding: 6px;
    font-size: 11px;
    border: 1px solid rgba(128, 128, 128, 0.25);
    border-radius: 8px;
    background: transparent;
    color: var(--text-color);
    cursor: pointer;
    opacity: 0.7;
    transition: background 0.15s, opacity 0.15s;
}
.vd-wall-reset:hover {
    background: rgba(255, 255, 255, 0.08);
    opacity: 1;
}
.vd-wall-hint {
    font-size: 10px;
    text-align: center;
    color: var(--text-color);
    opacity: 0.5;
    line-height: 1.3;
}
#vd-wall-btn.has-active::after {
    content: '';
    position: absolute;
    top: 6px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ffd060;
    box-shadow: 0 0 4px rgba(255, 208, 96, 0.9);
}
@media (max-width: 768px) {
    .vd-wall-panel { min-width: 220px; }
    .vd-wall-row { grid-template-columns: 56px 1fr 40px; gap: 6px; }
    .vd-wall-hint { display: none; }
}
`;
    document.head.appendChild(_styleEl);
}

function _addDocHandler(type, handler, opts) {
    if (_docHandlers.some(h => h.handler === handler)) return; // защита от дублей
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
    const panels = _panelsContainer || document.querySelector('.plugin-panels');
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

    // Единый drag-хелпер для всех вертикальных слайдеров (SV/Hue/Metalness/Roughness).

    const clamp01 = v => Math.max(0, Math.min(1, v));

    /**
     * Тап/клик активирует перетаскивание; движение документа обновляет значение;
     * отпускание деактивирует. E13: слушатели живут только во время drag.
     * @param el        элемент-трек
     * @param isActive  getter флага активности
     * @param setActive setter флага
     * @param onValue   (cx, cy, rect) => обновить значение и UI
     */
    function _bindVerticalSlider(el, isActive, setActive, onValue) {
        if (!el) return;
        const onMove = e => {
            if (!isActive()) return;
            const rect = el.getBoundingClientRect();
            const cx = e.touches ? e.touches[0].clientX : e.clientX;
            const cy = e.touches ? e.touches[0].clientY : e.clientY;
            onValue(cx, cy, rect);
        };
        const onTouchMove = e => {
            if (!isActive()) return;
            onMove(e);
            e.preventDefault();
        };
        const detachDoc = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchend', onEnd);
            document.removeEventListener('touchcancel', onEnd);
            if (_activeDragDetach === detachDoc) _activeDragDetach = null;
        };
        const onEnd = () => {
            setActive(false);
            detachDoc();
        };
        const attachDoc = () => {
            document.addEventListener('mousemove', onMove);
            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
            _activeDragDetach = detachDoc;
        };
        const start = e => {
            setActive(true);
            onMove(e);
            if (!_activeDragDetach) attachDoc(); // один активный drag за раз
        };
        el.addEventListener('mousedown', start);
        el.addEventListener('touchstart', e => { start(e); e.preventDefault(); }, { passive: false });
    }

    // SV-взаимодействие
    const svSquare = el.querySelector('#vd-sv-square');
    _bindVerticalSlider(
        svSquare,
        () => _svActive,
        v => { _svActive = v; },
        (cx, cy, rect) => {
            _sat = clamp01((cx - rect.left) / rect.width);
            _val = 1 - clamp01((cy - rect.top) / rect.height);
            _updateColorUI();
            _applyColor();
        }
    );

    // Hue-взаимодействие
    const hueSlider = el.querySelector('#vd-hue-slider');
    _bindVerticalSlider(
        hueSlider,
        () => _hueActive,
        v => { _hueActive = v; },
        (cx, cy, rect) => {
            _hue = clamp01((cy - rect.top) / rect.height);
            _updateColorUI();
            _applyColor();
        }
    );

    // Metalness-взаимодействие
    const metalnessSlider = el.querySelector('#vd-metalness-slider');
    _bindVerticalSlider(
        metalnessSlider,
        () => _metalnessActive,
        v => { _metalnessActive = v; },
        (cx, cy, rect) => {
            _metalness = clamp01((cy - rect.top) / rect.height);
            _updateMRUI();
            _applyMetalness(_metalness);
            _saveState();
        }
    );

    // Roughness-взаимодействие
    const roughnessSlider = el.querySelector('#vd-roughness-slider');
    _bindVerticalSlider(
        roughnessSlider,
        () => _roughnessActive,
        v => { _roughnessActive = v; },
        (cx, cy, rect) => {
            _roughness = clamp01((cy - rect.top) / rect.height);
            _updateMRUI();
            _applyRoughness(_roughness);
            _saveState();
        }
    );
}

function _showColorPanel() {
    _createColorPanel();
    _colorPanelVisible = true;
    _colorPanelEl.classList.add('visible');
    _updateColorUI();
    _updateMRUI();

    _outsideClickHandler = _registerPanelAutoClose(_colorPanelEl, 'vd-color-btn', () => _colorPanelVisible, _hideColorPanel);
}

function _hideColorPanel() {
    if (!_colorPanelEl) return;
    _colorPanelVisible = false;
    _svActive = false;
    _hueActive = false;
    _metalnessActive = false;
    _roughnessActive = false;
    _colorPanelEl.classList.remove('visible');
    _removeOutsideClick(_outsideClickHandler);
    _outsideClickHandler = null;
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

        // Виртуальные стены (ориентация не хранится — фиксируется в момент включения)
        const savedWalls = saved.walls;
        if (savedWalls) {
            for (const id of ['back', 'right', 'left']) {
                if (savedWalls[id]) {
                    _walls[id].enabled = !!savedWalls[id].enabled;
                    _walls[id].distance = typeof savedWalls[id].distance === 'number'
                        ? THREE.MathUtils.clamp(savedWalls[id].distance, WALL_DISTANCE_MIN, WALL_DISTANCE_MAX)
                        : 1.0;
                }
            }
        }
        _floorHeightOffset = typeof saved.floorHeightOffset === 'number'
            ? THREE.MathUtils.clamp(saved.floorHeightOffset, FLOOR_HEIGHT_MIN, FLOOR_HEIGHT_MAX)
            : 0;
        _wallsRotation = typeof saved.wallsRotation === 'number'
            ? THREE.MathUtils.clamp(saved.wallsRotation, WALLS_ROTATION_MIN, WALLS_ROTATION_MAX)
            : 0;
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

    // 2a. Находим сторонние источники света (созданы в engine.js setupLights),
    // чтобы компенсировать их при изменении плотности тени.
    // Без этого AmbientLight и FillLight «заливают» тень светом, и она
    // остаётся полупрозрачной даже при shadowOpacity=1.
    _discoverAmbientLights();

    // 3. Применяем настройки
    _applyShadowOpacity();
    _updateSunPosition();
    _updateGridOrientation(); // начальная видимость сетки по текущему направлению взгляда

    // 3a. Подписки событийной модели (снимаются в _cleanup через _boundHandlers).
    if (_api.controls) {
        _api.controls.addEventListener('change', _onControlsChange);
        _boundHandlers.push({ el: _api.controls, type: 'change', handler: _onControlsChange });
    }
    window.addEventListener('model-transformed', _onModelTransformed);
    _boundHandlers.push({ el: window, type: 'model-transformed', handler: _onModelTransformed });
    window.addEventListener('model-visibility-changed', _onModelVisibilityChanged);
    _boundHandlers.push({ el: window, type: 'model-visibility-changed', handler: _onModelVisibilityChanged });

    // 4. CSS для pill-bar
    _injectStyles();

    // 5. Начальный цвет
    const pluginColor = saved?.modelColor;
    const settingsColor = _api.store.getState('ui.settings')?.modelColor;
    const currentColor = pluginColor || settingsColor || '#cccccc';
    const rgb = hexToRgb(currentColor);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    _hue = hsv.h; _sat = hsv.s; _val = hsv.v;
    _applyModelColor(currentColor);

    // 6. Металличность и шероховатость
    const uiSettings = _api.store.getState('ui.settings') || {};
    _metalness = (saved?.metalness !== undefined) ? saved.metalness
        : (uiSettings.modelMetalness !== undefined ? uiSettings.modelMetalness : 0.1);
    _roughness = (saved?.roughness !== undefined) ? saved.roughness
        : (uiSettings.modelRoughness !== undefined ? uiSettings.modelRoughness : 0.75);
    _applyMetalness(_metalness);
    _applyRoughness(_roughness);

    // 7. Восстанавливаем включённые стены. Базу снимает _ensureWallReference
    //    при первом _setWallEnabled(id, true).
    for (const id of ['back', 'right', 'left']) {
        if (_walls[id].enabled) _setWallEnabled(id, true);
    }
    _updateFloorBounds();
}

function _cleanup() {
    if (_cleanedUp) return;
    _cleanedUp = true;

    // Снять drag-слушатели, если плагин выключили посреди перетаскивания.
    if (_activeDragDetach) { _activeDragDetach(); _activeDragDetach = null; }
    if (_saveStateTimer !== null) { clearTimeout(_saveStateTimer); _saveStateTimer = null; _saveStateNow(); }

    _removeCameraLight();
    _removeShadowPlane();
    _removeGrid();
    _removeEdges();

    // Восстанавливаем исходные интенсивности фоновых источников света,
    // которые мы компенсировали в _applyShadowOpacity. Иначе при деактивации
    // плагина сцена осталась бы затемнённой.
    if (_ambientLight && _ambientLightBaseIntensity > 0) {
        _ambientLight.intensity = _ambientLightBaseIntensity;
    }
    if (_fillLight && _fillLightBaseIntensity > 0) {
        _fillLight.intensity = _fillLightBaseIntensity;
    }
    _ambientLight = null;
    _ambientLightBaseIntensity = 0;
    _fillLight = null;
    _fillLightBaseIntensity = 0;

    // Виртуальные стены: distance сбрасываем, иначе при недоступном localStorage
    // модульные переменные переживают ре-инициализацию.
    for (const id of ['back', 'right', 'left']) {
        _walls[id].enabled = false;
        _walls[id].distance = 1.0;
        _removeWall(id);
    }
    _wallRef = null;
    _wallsBaseYaw = 0;
    _wallsRotation = 0;
    _floorHeightOffset = 0;
    _sunGeomCache = null;
    _liveMetricsCache = null;
    _hideWallPanel();
    if (_wallPanelEl) { _wallPanelEl.remove(); _wallPanelEl = null; }

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
    // module — не указывается; привязку к модулю задаёт администратор
    // в js/plugins/registry.js через PluginManager.bindModules().

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

    // onFrame удалён — плагин полностью событийный.

    panel: {
        className: 'plugin-pill',

        html: `
            <div class="cam-group plugin-pill-group">
                <button class="cam-btn plugin-pill-btn" id="vd-shadow-btn" title="Тени">
                    <svg><use xlink:href="assets/icons/sprite.svg#shadow-line"></use></svg>
                </button>
                <button class="cam-btn plugin-pill-btn" id="vd-sun-btn" title="Солнце">
                    <svg><use xlink:href="assets/icons/sprite.svg#sun"></use></svg>
                </button>
                <button class="cam-btn plugin-pill-btn" id="vd-wall-btn" title="Виртуальные стены">
                    <svg><use xlink:href="assets/icons/sprite.svg#wall-line"></use></svg>
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

        onMount(toolbarEl) {
            // Скоуп-контейнер: собственная панель инструментов, а не глобальный .plugin-panels.
            _panelsContainer = toolbarEl?.closest('.plugin-panels') || null;

            const bind = (id, type, handler) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.addEventListener(type, handler);
                _boundHandlers.push({ el, type, handler });
            };

            bind('vd-shadow-btn', 'click', _toggleShadow);
            bind('vd-sun-btn', 'click', _toggleSunPanel);
            bind('vd-wall-btn', 'click', _toggleWallPanel);
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
            _updateWallBtnUI();
        },

        // При переключении на другой плагин — закрыть всплывающие панели
        // (цвет, солнце, стены), чтобы они не оставались открытыми поверх
        // чужого тулбара. DOM не удаляем — при возврате можно открыть снова.
        onPause() {
            _hideColorPanel();
            _hideSunPanel();
            _hideWallPanel();
        },

        onUnmount() {
            _cleanup();
        }
    }
});
