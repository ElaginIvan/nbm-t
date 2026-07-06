/**
 * Плагин: Центр масс (3D)
 *
 * Вычисляет истинный (объёмно-взвешенный) центр масс замкнутой треугольной
 * сетки методом дивергенциальной теоремы. Для каждого треугольника строится
 * тетраэдр с началом координат; его объём и центроид вносятся в общую сумму.
 *
 * Маркер: сфера в ЦМ + три пунктирные линии-проекции от ЦМ до граней
 * BoundingBox + подписи с расстоянием от грани до ЦМ (мм).
 * Подписи перпендикулярны своей оси, НЕ следят за камерой.
 *
 * Назначение: работник видит, отступив сколько мм от низа / края конструкции,
 * нужно поставить монтажные петли для страховки при транспортировке.
 * Без панели — просто toggle в сайдбаре.
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';

// ============================================================
// СОСТОЯНИЕ
// ============================================================

let _group = null;              // THREE.Group — контейнер маркера
let _api = null;                // API модуля 3d-viewer
let _modelLoadedHandler = null;
let _storeUnsubscribe = null;  // отписка от store

// Переиспользуемые векторы для автопереворота меток (avoid GC)
const _flipWorldPos = new THREE.Vector3();
const _flipQuat = new THREE.Quaternion();
const _flipNormal = new THREE.Vector3();
const _flipToCam = new THREE.Vector3();

// ============================================================
// ВЫЧИСЛЕНИЕ ЦЕНТРА МАСС
// ============================================================

/**
 * Истинный центр масс замкнутой треугольной сетки.
 * Метод: для каждого треугольника (a, b, c) вычисляется
 *   V_tet = a · (b × a→c) / 6          — знаковый объём тетраэдра с origin
 *   centroid_contribution += V_tet * (a + b + c) / 4
 * Результат: Σ centroid_contribution / Σ V_tet
 *
 * @param {THREE.Object3D} model
 * @returns {THREE.Vector3}
 */
function computeCenterOfMass(model) {
    let totalVol = 0;
    const w = new THREE.Vector3();

    const _a = new THREE.Vector3();
    const _b = new THREE.Vector3();
    const _c = new THREE.Vector3();
    const _ab = new THREE.Vector3();
    const _ac = new THREE.Vector3();
    const _cr = new THREE.Vector3();

    model.traverse(child => {
        if (!child.isMesh || !child.geometry || !child.visible) return;

        const geo = child.geometry;
        const pos = geo.getAttribute('position');
        if (!pos) return;

        child.updateWorldMatrix(true, false);
        const m4 = child.matrixWorld;
        const idx = geo.index;

        const count = idx ? idx.count : pos.count;

        for (let i = 0; i < count; i += 3) {
            const i0 = idx ? idx.getX(i)     : i;
            const i1 = idx ? idx.getX(i + 1) : i + 1;
            const i2 = idx ? idx.getX(i + 2) : i + 2;

            _a.fromBufferAttribute(pos, i0).applyMatrix4(m4);
            _b.fromBufferAttribute(pos, i1).applyMatrix4(m4);
            _c.fromBufferAttribute(pos, i2).applyMatrix4(m4);

            _ab.subVectors(_b, _a);
            _ac.subVectors(_c, _a);
            _cr.crossVectors(_ab, _ac);

            const vol = _a.dot(_cr) / 6;
            totalVol += vol;

            const q = vol / 4;
            w.x += (_a.x + _b.x + _c.x) * q;
            w.y += (_a.y + _b.y + _c.y) * q;
            w.z += (_a.z + _b.z + _c.z) * q;
        }
    });

    // Открытая / плоская / вырожденная сетка — fallback на BoundingBox
    if (Math.abs(totalVol) < 1e-10) {
        console.warn('[CenterOfMass] Объём ≈ 0 — fallback на геометрический центр');
        return new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
    }

    return w.divideScalar(totalVol);
}

// ============================================================
// МАРКЕР
// ============================================================

/**
 * Плоскость-подпись (PlaneGeometry + Canvas-текстура).
 * НЕ следит за камерой — ориентация задаётся извне.
 *
 * @param {string} text     — текст подписи
 * @param {string} cssColor — цвет акцента (CSS, для левой полоски)
 * @param {number} height   — высота плоскости в мировых единицах
 * @returns {THREE.Mesh}
 */
function _makeAxisLabel(text, cssColor, height) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fs = 52;
    const padX = 18;
    const padY = 14;

    ctx.font = `600 ${fs}px "Inter","Segoe UI",system-ui,sans-serif`;
    const tw = ctx.measureText(text).width;

    canvas.width  = Math.ceil(tw) + padX * 2;
    canvas.height = Math.ceil(fs * 1.35) + padY * 2;

    // Фон
    ctx.fillStyle = 'rgba(12,12,18,0.85)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
    ctx.fill();

    // Цветная полоска слева
    ctx.fillStyle = cssColor;
    ctx.beginPath();
    ctx.roundRect(0, 0, 5, canvas.height, [8, 0, 0, 8]);
    ctx.fill();

    // Текст
    ctx.fillStyle = '#f0f0f0';
    ctx.font = `600 ${fs}px "Inter","Segoe UI",system-ui,sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padX + 6, canvas.height / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;

    const aspect = canvas.width / canvas.height;
    const geo = new THREE.PlaneGeometry(height * aspect, height);
    const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        side: THREE.DoubleSide,
    });

    return new THREE.Mesh(geo, mat);
}

/**
 * BoundingBox только по видимым мешам.
 * Стандартный Box3.setFromObject() игнорирует visible — свои.
 */
function _visibleBoundingBox(model) {
    const box = new THREE.Box3();
    const _mb = new THREE.Box3();
    model.traverse(child => {
        if (!child.isMesh || !child.visible || !child.geometry) return;
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        _mb.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
        box.union(_mb);
    });
    return box;
}

/** Показать маркер центра масс. */
function _show() {
    if (!_api?.model || !_api?.scene) return;

    const com = computeCenterOfMass(_api.model);
    const box = _visibleBoundingBox(_api.model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim < 1e-6) return;

    // Расстояния от граней BoundingBox до центра масс (в метрах)
    const distX = com.x - box.min.x;   // от левой грани
    const distY = com.y - box.min.y;   // от нижней грани
    const distZ = com.z - box.min.z;   // от передней грани

    _group = new THREE.Group();
    // Локальное начало координат группы = центр масс.
    // Все дочерние объекты — относительно ЦМ.
    _group.position.copy(com);

    // --- Сфера в центре масс ---
    const r = Math.max(maxDim * 0.012, 0.002);
    _group.add(new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 24),
        new THREE.MeshBasicMaterial({ color: 0xff6b35, transparent: true, opacity: 0.92, depthTest: false })
    ));

    // --- Размеры вспомогательных элементов ---
    const lh = Math.max(maxDim * 0.035, 0.025);       // высота подписи
    const dotR = Math.max(maxDim * 0.004, 0.001);      // радиус точки на грани
    const labelGap = lh * 0.75;                         // зазор между гранью и подписью

    /**
     * Конфигурация трёх осей проекции.
     * end     — локальная координата точки на грани BoundingBox
     * rot     — Euler-углы для поворота PlaneGeometry перпендикулярно оси
     */
    const axes = [
        {
            dist: distX,
            end: new THREE.Vector3(-distX, 0, 0),
            color: 0xff4444, css: '#ff4444',
            labelPos: new THREE.Vector3(-distX - labelGap, 0, 0),
            // PlaneGeometry (XY, нормаль +Z) → поворот 90° вокруг Y → плоскость YZ, нормаль вдоль X
            labelRot: new THREE.Euler(0, Math.PI / 2, 0),
            text: `от края: ${(distX * 1000).toFixed(0)} мм`,
        },
        {
            dist: distY,
            end: new THREE.Vector3(0, -distY, 0),
            color: 0x44cc44, css: '#44cc44',
            labelPos: new THREE.Vector3(0, -distY - labelGap, 0),
            // поворот -90° вокруг X → плоскость XZ, нормаль вдоль Y
            labelRot: new THREE.Euler(-Math.PI / 2, 0, 0),
            text: `от низа: ${(distY * 1000).toFixed(0)} мм`,
        },
        {
            dist: distZ,
            end: new THREE.Vector3(0, 0, -distZ),
            color: 0x4488ff, css: '#4488ff',
            labelPos: new THREE.Vector3(0, 0, -distZ - labelGap),
            // без поворота — плоскость XY, нормаль вдоль Z
            labelRot: new THREE.Euler(0, 0, 0),
            text: `от края: ${(distZ * 1000).toFixed(0)} мм`,
        },
    ];

    for (const ax of axes) {
        // 1) Пунктирная линия от ЦМ (0,0,0) до проекции на грань
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            ax.end,
        ]);
        const dashLen = Math.max(ax.dist * 0.04, 0.003);
        const lineMat = new THREE.LineDashedMaterial({
            color: ax.color,
            dashSize: dashLen,
            gapSize: dashLen * 0.6,
            depthTest: false,
        });
        const line = new THREE.Line(lineGeo, lineMat);
        line.computeLineDistances();
        _group.add(line);

        // 2) Точка-маркер на грани
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(dotR, 12, 12),
            new THREE.MeshBasicMaterial({ color: ax.color, depthTest: false })
        );
        dot.position.copy(ax.end);
        _group.add(dot);

        // 3) Подпись с расстоянием (чуть вне грани)
        const label = _makeAxisLabel(ax.text, ax.css, lh);
        label.position.copy(ax.labelPos);
        label.rotation.copy(ax.labelRot);

        // Автопереворот: если камера сзади — отзеркалить по локальной X,
        // чтобы текст всегда читался нормально
        label.onBeforeRender = () => {
            if (!_api?.camera) return;
            label.getWorldPosition(_flipWorldPos);
            label.getWorldQuaternion(_flipQuat);
            _flipNormal.set(0, 0, 1).applyQuaternion(_flipQuat);
            _flipToCam.subVectors(_api.camera.position, _flipWorldPos).normalize();
            label.scale.x = _flipNormal.dot(_flipToCam) < 0 ? -1 : 1;
        };

        _group.add(label);
    }

    _api.scene.add(_group);
}

/** Удалить маркер и освободить ресурсы. */
function _hide() {
    if (!_group) return;
    _group.traverse(ch => {
        if (ch.geometry) ch.geometry.dispose();
        if (ch.material) {
            if (ch.material.map) ch.material.map.dispose();
            ch.material.dispose();
        }
    });
    if (_api?.scene) _api.scene.remove(_group);
    _group = null;
}

// ============================================================
// РЕГИСТРАЦИЯ ПЛАГИНА
// ============================================================

PluginManager.register({
    id: 'center-of-mass',
    name: 'Центр масс',
    icon: 'center-mass',
    module: '3d-viewer',

    /** Показывать кнопку только когда модель загружена. */
    condition: (api) => !!(api && api.model),

    /**
     * Активация — вычислить и показать маркер.
     * Возвращает функцию очистки (снятие слушателей).
     */
    init(api) {
        _api = api;
        _show();

        // При выборе детали в таблице — пересчитать ЦМ только для видимых мешей.
        // rAF нужен: store-событие fires синхронно ДО того, как highlightParts
        // скроет меши через visible=false.
        _storeUnsubscribe = api.store?.subscribe('specification.lastSelectedPart', () => {
            requestAnimationFrame(() => { _hide(); _show(); });
        });

        // При загрузке новой модели — пересчитать
        _modelLoadedHandler = () => {
            _hide();
            const freshModel = api.store?.getState?.('model.object') || api.model;
            if (freshModel) {
                _api = { ...api, model: freshModel };
                _show();
            }
        };
        window.addEventListener('modelLoaded', _modelLoadedHandler);

        return () => {
            if (_storeUnsubscribe) { _storeUnsubscribe(); _storeUnsubscribe = null; }
            if (_modelLoadedHandler) {
                window.removeEventListener('modelLoaded', _modelLoadedHandler);
                _modelLoadedHandler = null;
            }
        };
    },

    /** Деактивация — убрать маркер из сцены. */
    destroy() {
        if (_storeUnsubscribe) { _storeUnsubscribe(); _storeUnsubscribe = null; }
        _hide();
        _api = null;
    },
});