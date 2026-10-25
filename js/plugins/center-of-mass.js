/**
 * Плагин: Центр масс (3D).
 * Истинный (объёмно-взвешенный) центр масс замкнутой треугольной сетки методом
 * дивергенциальной теоремы. Маркер: сфера в ЦМ + пунктирные проекции до граней
 * BoundingBox с подписями расстояний (мм). Работник видит, где ставить монтажные петли.
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';

// ============================================================
// СОСТОЯНИЕ
// ============================================================

let _group = null;
let _api = null;
let _modelLoadedHandler = null;
let _storeUnsubscribe = null;
let _resubscribeRAF = null;

const _flipWorldPos = new THREE.Vector3();
const _flipQuat = new THREE.Quaternion();
const _flipNormal = new THREE.Vector3();
const _flipToCam = new THREE.Vector3();

// ============================================================
// ВЫЧИСЛЕНИЕ ЦЕНТРА МАСС
// ============================================================

/** Истинный центр масс замкнутой треугольной сетки через сумму знаковых объёмов тетраэдров с origin. */
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

    // Открытая / плоская / вырожденная сетка — fallback на геометрический центр по видимым мешам
    if (Math.abs(totalVol) < 1e-10) {
        console.warn('[CenterOfMass] Объём ≈ 0 — fallback на геометрический центр');
        return _visibleBoundingBox(model).getCenter(new THREE.Vector3());
    }

    return w.divideScalar(totalVol);
}

// ============================================================
// МАРКЕР
// ============================================================

/** Плоскость-подпись (PlaneGeometry + Canvas-текстура). НЕ следит за камерой. */
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

    ctx.fillStyle = 'rgba(12,12,18,0.85)';
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
        ctx.fill();
    } else {
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.fillStyle = cssColor;
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(0, 0, 5, canvas.height, [8, 0, 0, 8]);
        ctx.fill();
    } else {
        ctx.fillRect(0, 0, 5, canvas.height);
    }

    ctx.fillStyle = '#f0f0f0';
    ctx.font = `600 ${fs}px "Inter","Segoe UI",system-ui,sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padX + 6, canvas.height / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;

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

/** BoundingBox только по видимым мешам (Box3.setFromObject игнорирует visible). */
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

    const distX = com.x - box.min.x;
    const distY = com.y - box.min.y;
    const distZ = com.z - box.min.z;

    _group = new THREE.Group();
    _group.position.copy(com);

    const r = Math.max(maxDim * 0.012, 0.002);
    _group.add(new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 24),
        new THREE.MeshBasicMaterial({ color: 0xff6b35, transparent: true, opacity: 0.92, depthTest: false })
    ));

    const lh = Math.max(maxDim * 0.035, 0.025);
    const dotR = Math.max(maxDim * 0.004, 0.001);
    const labelGap = lh * 0.75;

    const axes = [
        {
            dist: distX,
            end: new THREE.Vector3(-distX, 0, 0),
            color: 0xff4444, css: '#ff4444',
            labelPos: new THREE.Vector3(-distX - labelGap, 0, 0),
            labelRot: new THREE.Euler(0, Math.PI / 2, 0),
            text: `от края: ${(distX * 1000).toFixed(0)} мм`,
        },
        {
            dist: distY,
            end: new THREE.Vector3(0, -distY, 0),
            color: 0x44cc44, css: '#44cc44',
            labelPos: new THREE.Vector3(0, -distY - labelGap, 0),
            labelRot: new THREE.Euler(-Math.PI / 2, 0, 0),
            text: `от низа: ${(distY * 1000).toFixed(0)} мм`,
        },
        {
            dist: distZ,
            end: new THREE.Vector3(0, 0, -distZ),
            color: 0x4488ff, css: '#4488ff',
            labelPos: new THREE.Vector3(0, 0, -distZ - labelGap),
            labelRot: new THREE.Euler(0, 0, 0),
            text: `от края: ${(distZ * 1000).toFixed(0)} мм`,
        },
    ];

    for (const ax of axes) {
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

        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(dotR, 12, 12),
            new THREE.MeshBasicMaterial({ color: ax.color, depthTest: false })
        );
        dot.position.copy(ax.end);
        _group.add(dot);

        const label = _makeAxisLabel(ax.text, ax.css, lh);
        label.position.copy(ax.labelPos);
        label.rotation.copy(ax.labelRot);

        // Автопереворот: если камера сзади — отзеркалить по локальной X
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

    /** Показывать кнопку только когда модель загружена. */
    condition: (api) => !!(api && api.model),

    /** Активация — вычислить и показать маркер. Возвращает функцию очистки. */
    init(api) {
        _api = api;
        _show();

        // При выборе детали — пересчитать ЦМ только для видимых мешей (через rAF, чтобы highlightParts успел скрыть меши).
        _storeUnsubscribe = api.store?.subscribe('specification.lastSelectedPart', () => {
            if (_resubscribeRAF) cancelAnimationFrame(_resubscribeRAF);
            _resubscribeRAF = requestAnimationFrame(() => {
                _resubscribeRAF = null;
                _hide();
                _show();
            });
        });

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
            if (_resubscribeRAF) { cancelAnimationFrame(_resubscribeRAF); _resubscribeRAF = null; }
            if (_storeUnsubscribe) { _storeUnsubscribe(); _storeUnsubscribe = null; }
            if (_modelLoadedHandler) {
                window.removeEventListener('modelLoaded', _modelLoadedHandler);
                _modelLoadedHandler = null;
            }
        };
    },

    /** Деактивация — убрать маркер из сцены. */
    destroy() {
        if (_resubscribeRAF) { cancelAnimationFrame(_resubscribeRAF); _resubscribeRAF = null; }
        if (_storeUnsubscribe) { _storeUnsubscribe(); _storeUnsubscribe = null; }
        if (_modelLoadedHandler) {
            window.removeEventListener('modelLoaded', _modelLoadedHandler);
            _modelLoadedHandler = null;
        }
        _hide();
        _api = null;
    },
});
