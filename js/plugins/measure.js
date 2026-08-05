/**
 * Плагин: Измерение (3D)
 *
 * Инструменты измерения модели: длина ребра, расстояние между элементами,
 * углы (рёбра, грани, двугранный), площадь грани, радиус/диаметр дуг.
 *
 * Адаптация standalone-проекта measurement.js → плагин plugin-system.js.
 * Все глобальные ссылки (camera, renderer, controls, scene и т.д.)
 * заменены на локальные переменные, получаемые через api в init().
 */

import * as THREE from 'three';
// CSS2DRenderer и CSS2DObject — именованные экспорты модуля three/addons/CSS2DRenderer.js.
// Важно: они НЕ являются свойствами неймспейса THREE (THREE.CSS2DRenderer === undefined),
// поэтому используем их напрямую как импортированные биндинги.
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import PluginManager from '../plugin-system.js';

// ============================================================
// Конфигурация
// ============================================================

const isM = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const CONFIG = {
    snapRadius: isM ? 0.012 : 0.008, edgeSnapDist: isM ? 0.01 : 0.006, faceSnapDist: isM ? 0.008 : 0.005,
    snapRadiusStrict: isM ? 0.007 : 0.004, edgeSnapDistStrict: isM ? 0.006 : 0.0035,
    vertexColor: 0x7aa2f7, edgeColor: 0x9ece6a, faceColor: 0xe0af68,
    measureColor: 0xff9e64, angleColor: 0xe0af68, highlightColor: 0xbb9af7,
    arcRadius: 0.6, arcSegments: 32, parallelThreshold: 0.05,
    smoothAngleThreshold: 0.5, coplanarDistThreshold: 0, scaleToMM: 1000
};
const typeLabels = { vertex: 'Верш.', edge: 'Ребро', face: 'Грань' };

// ============================================================
// Состояние плагина
// ============================================================

let _camera, _renderer, _controls, _scene, _model;
let _container;
let _labelRenderer = null;
let _helpersGroup = null;
let _measurementsGroup = null;
let _meshObjects = [];
let _firstMarker, _hoverMarker;
let _animFrameId = null;
let _animT = 0;

// Выделение / измерения
let _selectedMeasId = null;
let _measureIdCounter = 0;
let _measurements = [];
let _activeModes = { vertex: true, edge: true, face: true };
let _useAutoSnapRadii = true;
let _firstSelection = null;
let _firstMeasId = null;
let _edgeHighlight = null;
let _faceHighlight = null;

// Raycaster
const _raycaster = new THREE.Raycaster();
let _mouse = new THREE.Vector2();

// События
let _clickTimeout = null;
let _touchMoved = false;
let _touchStartPos = null;
let _touchStartTime = 0;
let _cameraMoved = false;
let _cameraMoveTimer = null;
let _initialCamPos = null;
let _initialCamTarget = null;

// UI-элементы панели (заполняются в onMount)
let _toolbarEl = null;

// Кэши смежности
let _adjCache = new Map(), _smoothCache = new Map();
const _clearCache = () => { _adjCache.clear(); _smoothCache.clear(); };

// Cleanup-функции
let _boundEventHandlers = [];
let _resizeHandler = null;
let _resizeObserver = null;
let _controlsStartHandler = null;
let _controlsChangeHandler = null;

// ============================================================
// Векторные утилиты
// ============================================================

const sub = (a, b) => new THREE.Vector3().subVectors(a, b);
const add = (a, b) => new THREE.Vector3().addVectors(a, b);
const mul = (v, s) => v.clone().multiplyScalar(s);
const norm = v => v.clone().normalize();
const cross = (a, b) => new THREE.Vector3().crossVectors(a, b);
const dot = (a, b) => a.dot(b);
const dist = (a, b) => a.distanceTo(b);
const len = v => v.length();
const lerp = (a, b, t) => new THREE.Vector3().lerpVectors(a, b, t);
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const midPt = (a, b) => add(a, b).multiplyScalar(0.5);

// ============================================================
// Форматирование
// ============================================================

const formatNumeric = v => String(parseFloat((Math.round(v * 100) / 100).toFixed(2)));
const formatAngle = d => String(parseFloat((Math.round(d * 10) / 10).toFixed(1))) + '°';

// ============================================================
// Фабрика линий
// ============================================================

const makeLine = (pts, color, opts = {}) =>
    new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
            color,
            transparent: opts.transparent ?? !!opts.opacity,
            opacity: opts.opacity ?? 1,
            linewidth: opts.linewidth ?? 1,
            depthTest: opts.depthTest ?? false
        })
    );

// ============================================================
// Утилиты выделения и проекции
// ============================================================

function projectLinePoints(p1, p2, dimMode) {
    if (dimMode === 1) return { start: p1.clone(), end: new THREE.Vector3(p2.x, p1.y, p2.z) };
    if (dimMode === 2) return { start: p1.clone(), end: new THREE.Vector3(p1.x, p2.y, p1.z) };
    return null;
}

function createLabel(text, position, color) {
    const div = document.createElement('div');
    div.textContent = text;
    const col = typeof color === 'number' ? '#' + color.toString(16) : color;
    div.style.cssText = `color:${col};font:bold 16px monospace;background:rgba(10,10,30,0.85);padding:4px 8px;border-radius:6px;border:1px solid ${col};backdrop-filter:blur(4px);white-space:nowrap;text-shadow:1px 1px 0 rgba(0,0,0,0.5)`;
    const label = new CSS2DObject(div);
    label.position.copy(position);
    return label;
}

function projectToScreen(point) {
    const v = point.clone().project(_camera);
    return {
        x: (v.x * 0.5 + 0.5) * _renderer.domElement.clientWidth,
        y: (-v.y * 0.5 + 0.5) * _renderer.domElement.clientHeight
    };
}

const estimateLabelWidth = text => text.length * 9.6 + 16;
const LABEL_MIN_MARGIN = 12;

function createDimLabel(group, dimStart, dimEnd, dimMid, dimDir, offsetDir, color, text) {
    const s1 = projectToScreen(dimStart), s2 = projectToScreen(dimEnd);
    if (Math.hypot(s2.x - s1.x, s2.y - s1.y) >= estimateLabelWidth(text) + LABEL_MIN_MARGIN * 2) {
        group.add(createLabel(text, dimMid, color));
        return;
    }
    const toCam = norm(sub(_camera.position, dimMid));
    let extDir = dimDir.clone();
    if (dot(extDir, toCam) < 0) extDir.negate();
    const midToCam = dist(_camera.position, dimMid);
    const extLen = midToCam > 0.01 ? midToCam * 0.06 : 0.06;
    const extStart = dot(extDir, dimDir) < 0 ? dimStart : dimEnd;
    const extEnd = add(extStart, mul(extDir, extLen));
    group.add(makeLine([extStart, extEnd], color, { opacity: 0.7 }));
    const label = createLabel(text, extEnd, color);
    if (label.element) label.element.style.transform = 'translate(0, -50%)';
    group.add(label);
}

const addEdgeLine = (group, v1, v2, color, opacity = 0.6, linewidth = 1) =>
    group.add(makeLine([v1, v2], color, { opacity, linewidth }));

function drawBoundaryLoops(group, meta, color, opacity, linewidth) {
    const loops = meta.boundaryLoops || (meta.boundary ? [meta.boundary] : null);
    if (!loops) return;
    for (const loop of loops) {
        if (loop.length > 2) {
            const pts = [...loop.map(v => v.clone()), loop[0].clone()];
            group.add(makeLine(pts, color, { opacity: opacity ?? 1, linewidth: linewidth ?? 2 }));
        }
    }
}

function buildOffsetDimensionLine(group, opts) {
    const offsetDist = opts.offsetDist ?? 0.15;
    const dimDir = norm(sub(opts.lineEnd, opts.lineStart));
    const dimStart = opts.lineStart.clone().add(opts.offsetDir.clone().multiplyScalar(offsetDist));
    const dimEnd = opts.lineEnd.clone().add(opts.offsetDir.clone().multiplyScalar(offsetDist));
    const feat1 = opts.featStart ?? opts.lineStart;
    const feat2 = opts.featEnd ?? opts.lineEnd;
    let proj1 = dot(sub(feat1, dimStart), dimDir);
    let proj2 = dot(sub(feat2, dimStart), dimDir);
    const dimLen = dot(sub(dimEnd, dimStart), dimDir);
    proj1 = clamp(proj1, 0, dimLen);
    proj2 = clamp(proj2, 0, dimLen);
    const extEnd1 = add(dimStart, mul(dimDir, proj1));
    const extEnd2 = add(dimStart, mul(dimDir, proj2));
    const wMat = makeLine([feat1, extEnd1], CONFIG.measureColor, { opacity: 0.5 });
    group.add(wMat);
    group.add(makeLine([feat2, extEnd2], CONFIG.measureColor, { opacity: 0.5 }));
    group.add(makeLine([dimStart, dimEnd], CONFIG.measureColor, { linewidth: 2 }));
    opts.edgeLines?.forEach(e => addEdgeLine(group, e.v1, e.v2, e.color, e.opacity));
    opts.boundaryLoops?.forEach(b => drawBoundaryLoops(group, b.meta, b.color, b.opacity, b.lw));
    const distVal = opts.lineStart.distanceTo(opts.lineEnd);
    const mid = midPt(dimStart, dimEnd);
    createDimLabel(group, dimStart, dimEnd, mid, dimDir, opts.offsetDir, CONFIG.measureColor,
        formatNumeric(distVal * CONFIG.scaleToMM) + (opts.labelSuffix || ''));
    return distVal;
}

// ============================================================
// Угловая дуга
// ============================================================

function addAngleArcParts(group, center, dir1, dir2, arcNormal, angle, angleDeg, extLen) {
    group.add(makeLine([center, add(center, mul(dir1, extLen))], CONFIG.angleColor, { linewidth: 2 }));
    group.add(makeLine([center, add(center, mul(dir2, extLen))], CONFIG.angleColor, { linewidth: 2 }));
    group.add(makeLine([center, add(center, mul(dir1, -extLen * 0.3))], CONFIG.angleColor, { opacity: 0.3, linewidth: 2 }));
    group.add(makeLine([center, add(center, mul(dir2, -extLen * 0.3))], CONFIG.angleColor, { opacity: 0.3, linewidth: 2 }));
    const arcPts = [];
    for (let i = 0; i <= CONFIG.arcSegments; i++) {
        const qi = new THREE.Quaternion().setFromAxisAngle(arcNormal, angle * i / CONFIG.arcSegments);
        arcPts.push(add(center, mul(dir1.clone().applyQuaternion(qi), CONFIG.arcRadius)));
    }
    arcPts[0] = add(center, mul(dir1, CONFIG.arcRadius));
    arcPts[arcPts.length - 1] = add(center, mul(dir2, CONFIG.arcRadius));
    group.add(makeLine(arcPts, CONFIG.angleColor, { linewidth: 2 }));
    const qiMid = new THREE.Quaternion().setFromAxisAngle(arcNormal, angle / 2);
    const midDir = norm(dir1.clone().applyQuaternion(qiMid));
    const arcLabelPos = add(center, mul(midDir, CONFIG.arcRadius * 0.9));
    const p1r = add(center, mul(dir1, CONFIG.arcRadius)), p2r = add(center, mul(dir2, CONFIG.arcRadius));
    createDimLabel(group, p1r, p2r, arcLabelPos, norm(sub(p2r, p1r)), midDir, CONFIG.angleColor, formatAngle(angleDeg));
}

// ============================================================
// Геометрические утилиты
// ============================================================

const getSelNormal = sel => sel.meta.normal || faceNormal(...sel.meta.vertices.slice(0, 3));
const getSelCentroid = sel => sel.meta.centroid || triCenter(...sel.meta.vertices.slice(0, 3));

function getOffsetDirection(p1, p2, useCamera) {
    const dir = norm(sub(p2, p1));
    let perp;
    if (useCamera) {
        const toCam = norm(sub(_camera.position, midPt(p1, p2)));
        perp = sub(toCam, mul(dir, dot(toCam, dir)));
        if (len(perp) > 1e-6) return norm(perp);
    }
    perp = cross(dir, Math.abs(dir.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
    return norm(perp);
}

const closestPtSeg = (p, a, b) => {
    const ab = sub(b, a), ap = sub(p, a), d = dot(ab, ab);
    return d < 1e-12 ? a.clone() : lerp(a, b, clamp(dot(ap, ab) / d, 0, 1));
};
const faceNormal = (a, b, c) => norm(cross(sub(b, a), sub(c, a)));
const triArea = (a, b, c) => len(cross(sub(b, a), sub(c, a))) * 0.5;
const triCenter = (a, b, c) => add(add(a, b), c).divideScalar(3);
const areDirectionsParallel = (d1, d2) => len(cross(d1, d2)) < CONFIG.parallelThreshold;
const areEdgesParallel = (v1a, v1b, v2a, v2b) => areDirectionsParallel(norm(sub(v1b, v1a)), norm(sub(v2b, v2a)));
const angleBetweenDirs = (d1, d2) => Math.acos(clamp(dot(d1, d2), -1, 1));
const isAngleType = mType => mType === 'e-e-ang' || mType === 'f-f-ang' || mType === 'e-f-ang';
const isArcType = mType => mType === 'edge-radius' || mType === 'edge-diameter';

function computeAnglePosDirs(dir1, dir2, angle, angleDeg, anglePos) {
    anglePos = ((anglePos || 0) % 4 + 4) % 4;
    return [
        { dir1, dir2, angle, angleDeg },
        { dir1: dir2, dir2: mul(dir1, -1), angle: Math.PI - angle, angleDeg: 180 - angleDeg },
        { dir1: mul(dir1, -1), dir2: mul(dir2, -1), angle, angleDeg },
        { dir1: mul(dir2, -1), dir2: dir1, angle: Math.PI - angle, angleDeg: 180 - angleDeg }
    ][anglePos];
}

// ============================================================
// Ближайшие точки и пересечения
// ============================================================

function closestPtTri(p, a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a.clone();
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b.clone();
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return lerp(a, b, d1 / (d1 - d3));
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c.clone();
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return lerp(a, c, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return lerp(b, c, (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    const dn = 1 / (va + vb + vc), vn = vb * dn, wn = vc * dn;
    return new THREE.Vector3(a.x + ab.x * vn + ac.x * wn, a.y + ab.y * vn + ac.y * wn, a.z + ab.z * vn + ac.z * wn);
}

const getWorldFaces = mesh => {
    const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index;
    const gv = i => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
    const faces = [];
    const count = idx ? idx.count : pos.count;
    const getX = idx ? (i => idx.getX(i)) : (i => i);
    for (let i = 0; i < count; i += 3) faces.push([gv(getX(i)), gv(getX(i + 1)), gv(getX(i + 2))]);
    return faces;
};

const vKey = v => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;

function closestPtsOnSegs(p1, p2, p3, p4) {
    const d1 = sub(p2, p1), d2 = sub(p4, p3), r = sub(p3, p1);
    const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
    let s = 0, t = 0;
    if (a > 1e-10 && e > 1e-10) {
        const b = dot(d1, d2), c = dot(d1, r), dn = a * e - b * b;
        if (Math.abs(dn) > 1e-10) s = clamp((b * f - c * e) / dn, 0, 1);
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
        else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    } else if (a > 1e-10) { s = clamp(-dot(d1, r) / a, 0, 1); }
    else if (e > 1e-10) { t = clamp(f / e, 0, 1); }
    return { pt1: add(p1, mul(d1, s)), pt2: add(p3, mul(d2, t)), s, t };
}

const findSharedVertex = (e1v, e2v) => {
    const match = e1v.flatMap(v1 => e2v.map(v2 => ({ v1, v2 }))).find(({ v1, v2 }) => dist(v1, v2) < 0.001);
    return match ? match.v1.clone() : null;
};

const closestPtOnFace = (sel, pt) =>
    sel.meta.mergedIndices?.length > 0
        ? closestPtMergedFace(pt, sel.meta.mergedIndices, sel.object)
        : closestPtTri(pt, ...sel.meta.vertices.slice(0, 3));

function closestPtMergedFace(p, mergedIndices, mesh) {
    const faces = getWorldFaces(mesh);
    let best = null, minD = Infinity;
    for (const fi of mergedIndices) {
        const v = faces[fi], cl = closestPtTri(p, ...v), d = dist(p, cl);
        if (d < minD) { minD = d; best = cl; }
    }
    return best || p.clone();
}

function getNearestWorldPlaneNormal(cameraDir) {
    const d = [Math.abs(cameraDir.x), Math.abs(cameraDir.y), Math.abs(cameraDir.z)];
    const axis = d.indexOf(Math.max(...d));
    return new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
}

function getWorldPlaneOffsetDir(edgeStart, edgeEnd) {
    const target = _controls?.target ?? new THREE.Vector3(0, 0, 0);
    const cameraDir = norm(sub(_camera.position, target));
    const planeNormal = getNearestWorldPlaneNormal(cameraDir);
    const edgeDir = norm(sub(edgeEnd, edgeStart));
    const edgeInPlane = norm(sub(edgeDir, mul(planeNormal, dot(edgeDir, planeNormal))));
    if (len(edgeInPlane) < 1e-6) return getOffsetDirection(edgeStart, edgeEnd, true);
    let offsetDir = norm(cross(planeNormal, edgeInPlane));
    if (dot(offsetDir, norm(sub(_camera.position, midPt(edgeStart, edgeEnd)))) < 0) offsetDir.negate();
    return offsetDir;
}

// ============================================================
// Обнаружение дуг/окружностей
// ============================================================

function detectArcOrCircle(edgeSel) {
    const mesh = edgeSel.object, smoothData = _buildSmooth(mesh), fEdges = smoothData.featureEdges, selV = edgeSel.meta.vertices;
    const startIdx = fEdges.findIndex(e =>
        (dist(e[0], selV[0]) < 0.001 && dist(e[1], selV[1]) < 0.001) ||
        (dist(e[0], selV[1]) < 0.001 && dist(e[1], selV[0]) < 0.001));
    if (startIdx < 0) return null;
    const refLen = dist(selV[0], selV[1]), lenTol = refLen * 0.02;
    const chain = [fEdges[startIdx][0].clone(), fEdges[startIdx][1].clone()];
    const used = new Set([startIdx]);
    const nextEdge = vtxKey => {
        for (let i = 0; i < fEdges.length; i++) {
            if (used.has(i)) continue;
            const v0k = vKey(fEdges[i][0]), v1k = vKey(fEdges[i][1]);
            let match = null;
            if (v0k === vtxKey) match = { pt: fEdges[i][1].clone(), k: v1k };
            else if (v1k === vtxKey) match = { pt: fEdges[i][0].clone(), k: v0k };
            if (!match || Math.abs(dist(fEdges[i][0], fEdges[i][1]) - refLen) > lenTol) continue;
            used.add(i);
            return match;
        }
        return null;
    };
    const walk = fwd => {
        let maxIter = fEdges.length + 1;
        while (maxIter-- > 0) {
            const key = vKey(fwd ? chain[chain.length - 1] : chain[0]);
            const nx = nextEdge(key);
            if (!nx) break;
            if (nx.k === vKey(fwd ? chain[0] : chain[chain.length - 1]) && chain.length > 4) break;
            fwd ? chain.push(nx.pt) : chain.unshift(nx.pt);
        }
    };
    walk(true); walk(false);
    if (chain.length < 5) return null;
    for (let i = 0; i < chain.length - 1; i++) if (Math.abs(dist(chain[i], chain[i + 1]) - refLen) > lenTol) return null;
    const n = faceNormal(chain[0], chain[1], chain[2]);
    const d0 = dot(n, chain[0]), planeTol = refLen * 0.15;
    for (let i = 3; i < chain.length; i++) if (Math.abs(dot(n, chain[i]) - d0) > planeTol) return null;
    const angles = [];
    for (let i = 1; i < chain.length - 1; i++) {
        const d1 = norm(sub(chain[i], chain[i - 1])), d2 = norm(sub(chain[i + 1], chain[i]));
        angles.push(Math.acos(clamp(dot(d1, d2), -1, 1)));
    }
    if (angles.length < 2) return null;
    const avgAng = angles.reduce((a, b) => a + b, 0) / angles.length;
    if (avgAng < 0.05 || avgAng > Math.PI * 0.8) return null;
    const angTol = Math.max(avgAng * 0.15, 0.05);
    if (angles.some(a => Math.abs(a - avgAng) > angTol)) return null;
    const isClosed = dist(chain[0], chain[chain.length - 1]) < refLen * 1.2;
    const midI = Math.floor(chain.length / 2);
    const center = circumCenter(chain[0], chain[midI], isClosed ? chain[chain.length - 2] : chain[chain.length - 1], n);
    if (!center) return null;
    const radius = dist(center, chain[0]);
    if (radius < 1e-6 || radius > refLen * 100) return null;
    if (chain.some(pt => Math.abs(dist(center, pt) - radius) > radius * 0.08)) return null;
    return { center, radius, normal: n, isCircle: isClosed, points: chain };
}

function detectArcOrCircleFromVertex(vertexSel) {
    const mesh = vertexSel.object, smoothData = _buildSmooth(mesh);
    const fEdges = smoothData.featureEdges, pt = vertexSel.point;
    for (let i = 0; i < fEdges.length; i++) {
        if (dist(fEdges[i][0], pt) < 0.001 || dist(fEdges[i][1], pt) < 0.001) {
            const arcInfo = detectArcOrCircle({ object: mesh, meta: { vertices: [fEdges[i][0].clone(), fEdges[i][1].clone()] } });
            if (arcInfo) return arcInfo;
        }
    }
    return null;
}

function circumCenter(a, b, c, n) {
    const ab = sub(b, a), ac = sub(c, a);
    const abMid = add(a, mul(ab, 0.5)), acMid = add(a, mul(ac, 0.5));
    const perpAB = norm(cross(n, ab)), perpAC = norm(cross(n, ac));
    const w = sub(acMid, abMid);
    const trySolve = (numerator, den) => {
        if (Math.abs(den) < 1e-10) return null;
        return add(acMid, mul(perpAC, numerator / den));
    };
    let result = trySolve(w.x * perpAB.y - w.y * perpAB.x, perpAB.x * perpAC.y - perpAB.y * perpAC.x);
    if (result) return result;
    result = trySolve(w.x * perpAB.z - w.z * perpAB.x, perpAB.x * perpAC.z - perpAB.z * perpAC.x);
    if (result) return result;
    return trySolve(w.y * perpAB.z - w.z * perpAB.y, perpAB.y * perpAC.z - perpAB.z * perpAC.y);
}

const adjustSelectionToCircleCenter = sel => {
    if (!sel) return null;
    const arcInfo = sel.type === 'vertex' ? detectArcOrCircleFromVertex(sel) : sel.type === 'edge' ? detectArcOrCircle(sel) : null;
    return arcInfo ? { center: arcInfo.center.clone(), arcInfo, normal: arcInfo.normal } : null;
};

const addArcContour = (group, arcInfo) => {
    if (!arcInfo?.points || arcInfo.points.length < 3) return;
    const pts = arcInfo.points.slice();
    if (arcInfo.isCircle) pts.push(arcInfo.points[0].clone());
    group.add(makeLine(pts, CONFIG.edgeColor, { opacity: 0.5 }));
};

function addCenterCrossToGroup(group, circleInfo) {
    if (!circleInfo) return;
    const c = circleInfo.center, n = circleInfo.normal || new THREE.Vector3(0, 1, 0), s = 0.005;
    addEdgeLine(group, add(c, mul(n, -s)), add(c, mul(n, s)), CONFIG.measureColor, 0.6);
    const perp = Math.abs(n.x) < 0.9 ? norm(cross(n, new THREE.Vector3(1, 0, 0))) : norm(cross(n, new THREE.Vector3(0, 1, 0)));
    addEdgeLine(group, add(c, mul(perp, -s)), add(c, mul(perp, s)), CONFIG.measureColor, 0.6);
    addArcContour(group, circleInfo.arcInfo);
}

function createArcDimension(arcInfo, dimType) {
    const grp = new THREE.Group();
    const { center, radius, normal: n, points: pts } = arcInfo;
    const isDia = dimType === 'diameter';
    const p1 = isDia ? pts[0] : center;
    const p2 = isDia ? add(center, mul(sub(pts[0], center), -1)) : pts[Math.floor(pts.length / 2)];
    addEdgeLine(grp, p1, p2, CONFIG.measureColor, 0.8, 2);
    addCenterCrossToGroup(grp, { center, arcInfo, normal: n });
    let labelPos = midPt(p1, p2);
    const toCam = norm(sub(_camera.position, labelPos));
    labelPos.add(mul(toCam, 0.02));
    const value = (isDia ? radius * 2 : radius) * CONFIG.scaleToMM;
    createDimLabel(grp, p1, p2, labelPos, norm(sub(p2, p1)), toCam, CONFIG.measureColor, `${isDia ? 'D' : 'R'}${formatNumeric(value)}`);
    return { group: grp, value, center, arcNormal: n };
}

// ============================================================
// Создание размерных линий
// ============================================================

function createEdgeDimensionLine(e1, e2, dimMode) {
    const grp = new THREE.Group();
    let lineStart = e1, lineEnd = e2;
    if (dimMode) { const proj = projectLinePoints(e1, e2, dimMode); if (proj) { lineStart = proj.start; lineEnd = proj.end; } }
    let offsetDir = getWorldPlaneOffsetDir(lineStart, lineEnd);
    if (dimMode === 2) offsetDir.negate();
    const d = buildOffsetDimensionLine(grp, {
        lineStart, lineEnd, featStart: e1, featEnd: e2, offsetDir, offsetDist: 0.25,
        edgeLines: [{ v1: e1, v2: e2, color: CONFIG.edgeColor, opacity: 0.6 }]
    });
    return { group: grp, value: d * CONFIG.scaleToMM, center: midPt(e1, e2) };
}

function createVertexDistLine(p1, p2, dimMode) {
    const grp = new THREE.Group();
    if (!dimMode) {
        const d = dist(p1, p2) * CONFIG.scaleToMM;
        addEdgeLine(grp, p1, p2, CONFIG.measureColor, 0.8, 2);
        createDimLabel(grp, p1, p2, midPt(p1, p2), norm(sub(p2, p1)), getOffsetDirection(p1, p2, true), CONFIG.measureColor, formatNumeric(d));
        return { group: grp, value: d, center: midPt(p1, p2) };
    }
    const proj = projectLinePoints(p1, p2, dimMode);
    const lineStart = proj?.start ?? p1, lineEnd = proj?.end ?? p2;
    const d = buildOffsetDimensionLine(grp, { lineStart, lineEnd, featStart: p1, featEnd: p2, offsetDir: getOffsetDirection(lineStart, lineEnd, true), offsetDist: 0.15 });
    addEdgeLine(grp, p1, p2, CONFIG.measureColor, 0.3);
    return { group: grp, value: d * CONFIG.scaleToMM, center: midPt(p1, p2) };
}

function createFaceDimension(sel) {
    const grp = new THREE.Group(), meta = sel.meta;
    const area = meta.area || triArea(...meta.vertices.slice(0, 3));
    const center = getSelCentroid(sel), normal = getSelNormal(sel);
    drawBoundaryLoops(grp, meta, CONFIG.faceColor, null, 2);
    addEdgeLine(grp, center, add(center, mul(normal, 0.5)), CONFIG.faceColor, 0.5, 2);
    grp.add(createLabel(`S=${formatNumeric(area)} м\u00B2`, add(center, mul(normal, 0.3)), CONFIG.faceColor));
    return { group: grp, value: area };
}

function edgePerpOffsetDir(edgeDir, fromPt, toPt, refPt) {
    const toVec = sub(toPt, fromPt);
    const perp = sub(toVec, mul(edgeDir, dot(toVec, edgeDir)));
    const perpDist = len(perp);
    const p1 = fromPt.clone();
    const p2 = add(p1, mul(perpDist > 1e-10 ? norm(perp) : new THREE.Vector3(0, 1, 0), perpDist));
    let offDir = edgeDir.clone();
    const parallelComp = dot(toVec, edgeDir);
    if (parallelComp < 0) offDir.negate();
    if (Math.abs(parallelComp) < 0.01 && dot(norm(sub(_camera.position, refPt || fromPt)), edgeDir) < 0) offDir.negate();
    return { p1, p2, perpDist, offsetDir: offDir };
}

function createDistanceDimension(type, a, b, c, dimMode) {
    const grp = new THREE.Group();
    let p1, p2, featEnd, edges, loops, offsetDist = 0.15, offsetDir;
    if (type === 'edge-edge') {
        const [e1a, e1b, e2a, e2b] = [a[0], a[1], b[0], b[1]];
        const edgeDir = norm(sub(e1b, e1a));
        const closest = closestPtsOnSegs(e1a, e1b, e2a, e2b);
        const eo = edgePerpOffsetDir(edgeDir, closest.pt1, closest.pt2, closest.pt1);
        p1 = eo.p1; p2 = eo.p2; offsetDir = eo.offsetDir; featEnd = closest.pt2;
        edges = [{ v1: e1a, v2: e1b, color: CONFIG.edgeColor, opacity: 0.6 }, { v1: e2a, v2: e2b, color: CONFIG.edgeColor, opacity: 0.6 }];
    } else if (type === 'edge-vertex') {
        const edgeDir = norm(sub(b, a));
        const ptOnEdge = closestPtSeg(c, a, b);
        const eo = edgePerpOffsetDir(edgeDir, ptOnEdge, c, ptOnEdge);
        p1 = eo.p1; p2 = eo.p2; offsetDir = eo.offsetDir; featEnd = c;
        edges = [{ v1: a, v2: b, color: CONFIG.edgeColor, opacity: 0.6 }];
    } else if (type === 'face-vertex') {
        const normal = getSelNormal(a), centroid = getSelCentroid(a);
        const signedDist = dot(sub(b, centroid), normal);
        p1 = sub(b, mul(normal, signedDist)); p2 = b.clone(); featEnd = b;
        loops = [{ meta: a.meta, color: CONFIG.faceColor, opacity: 0.5, lw: 2 }];
        offsetDir = getWorldPlaneOffsetDir(p1, p2);
    } else if (type === 'face-edge') {
        const normal = getSelNormal(a);
        const c1 = closestPtOnFace(a, b), c2 = closestPtOnFace(a, c);
        const ptOnEdge = dist(b, c1) < dist(c, c2) ? b.clone() : c.clone();
        const ptOnFace = dist(b, c1) < dist(c, c2) ? c1.clone() : c2.clone();
        p1 = ptOnFace.clone();
        const toP2 = sub(ptOnEdge, ptOnFace);
        let dir = normal.clone();
        if (dot(dir, toP2) < 0) dir.negate();
        p2 = add(p1, mul(dir, Math.abs(dot(toP2, normal)))); featEnd = ptOnEdge;
        edges = [{ v1: b, v2: c, color: CONFIG.edgeColor, opacity: 0.6 }];
        loops = [{ meta: a.meta, color: CONFIG.faceColor, opacity: 0.5, lw: 2 }];
        offsetDir = getWorldPlaneOffsetDir(p1, p2);
    } else if (type === 'face-face') {
        const n1 = getSelNormal(a);
        const { p1: pf1, p2: pf2 } = getClosestPointsBetweenFacesOptimized(a, b);
        let direction = n1.clone();
        if (dot(direction, sub(pf2, pf1)) < 0) direction.negate();
        p1 = pf1.clone(); p2 = add(p1, mul(direction, Math.abs(dot(sub(pf2, pf1), direction)))); featEnd = pf2;
        loops = [{ meta: a.meta, color: CONFIG.faceColor, opacity: 0.5, lw: 2 }, { meta: b.meta, color: CONFIG.faceColor, opacity: 0.5, lw: 2 }];
        offsetDir = getWorldPlaneOffsetDir(p1, p2);
    }
    const center = midPt(p1, p2);
    let lineStart = p1, lineEnd = p2;
    if (dimMode) {
        const proj = projectLinePoints(p1, p2, dimMode);
        if (proj) { lineStart = proj.start; lineEnd = proj.end; }
        offsetDir = getOffsetDirection(lineStart, lineEnd, true);
    }
    const distValue = buildOffsetDimensionLine(grp, { lineStart, lineEnd, featStart: p1, featEnd, offsetDir, offsetDist, edgeLines: edges, boundaryLoops: loops });
    return { group: grp, value: distValue * CONFIG.scaleToMM, center };
}

// ============================================================
// Угловые размеры
// ============================================================

function createEdgeAngleArc(e1v, e2v, anglePos) {
    const grp = new THREE.Group();
    let d1 = norm(sub(e1v[1], e1v[0])), d2 = norm(sub(e2v[1], e2v[0]));
    let center = findSharedVertex(e1v, e2v);
    if (center) {
        center = center.clone();
        d1 = norm(sub(dist(e1v[1], center) < 0.001 ? e1v[1] : e1v[0], dist(e1v[1], center) < 0.001 ? e1v[0] : e1v[1]));
        d2 = norm(sub(dist(e2v[1], center) < 0.001 ? e2v[1] : e2v[0], dist(e2v[1], center) < 0.001 ? e2v[0] : e2v[1]));
    } else {
        const llc = lineLineClosest(e1v[0], d1, e2v[0], d2);
        center = llc.point.clone();
    }
    const angle = angleBetweenDirs(d1, d2), angleDeg = angle * 180 / Math.PI;
    let normal = cross(d1, d2);
    if (len(normal) < 1e-6) normal.set(0, 1, 0); else normal.normalize();
    const ap = computeAnglePosDirs(d1, d2, angle, angleDeg, anglePos);
    addAngleArcParts(grp, center, ap.dir1, ap.dir2, normal, ap.angle, ap.angleDeg,
        Math.max(dist(e1v[0], e1v[1]), dist(e2v[0], e2v[1]), CONFIG.arcRadius * 1.5));
    addEdgeLine(grp, e1v[0], e1v[1], CONFIG.edgeColor, 0.5, 2);
    addEdgeLine(grp, e2v[0], e2v[1], CONFIG.edgeColor, 0.5, 2);
    return { group: grp, value: ap.angleDeg, center, arcNormal: normal };
}

function createDihedralAngleArc(s1, s2, anglePos) {
    const grp = new THREE.Group();
    const n1 = getSelNormal(s1), n2 = getSelNormal(s2);
    const angle = angleBetweenDirs(n1, n2), angleDeg = angle * 180 / Math.PI;
    let lineDir = cross(n1, n2), center;
    const sharedEdgeMid = findSharedEdgeBetweenFaces(s1, s2);
    if (sharedEdgeMid) {
        center = sharedEdgeMid;
        if (len(lineDir) > 1e-6) lineDir.normalize(); else lineDir.set(0, 1, 0);
    } else {
        const closestPts = getClosestPointsBetweenFacesOptimized(s1, s2);
        const refPoint = midPt(closestPts.p1, closestPts.p2);
        const intersection = planePlaneIntersection(n1, getSelCentroid(s1), n2, getSelCentroid(s2), refPoint);
        if (intersection) { center = intersection.point; lineDir = intersection.direction; }
        else { center = refPoint; lineDir.set(0, 1, 0); }
    }
    let rad1 = norm(sub(n1, mul(lineDir, dot(n1, lineDir)))), rad2 = norm(sub(n2, mul(lineDir, dot(n2, lineDir))));
    if (dot(rad1, n2) > 0) rad1.negate();
    if (dot(rad2, n1) > 0) rad2.negate();
    const arcNormal = lineDir.clone().normalize();
    const faceDir1 = norm(cross(rad1, arcNormal)), faceDir2 = norm(cross(rad2, arcNormal));
    const ap = computeAnglePosDirs(faceDir1, faceDir2, angleBetweenDirs(faceDir1, faceDir2), angleDeg, anglePos);
    addAngleArcParts(grp, center, ap.dir1, ap.dir2, arcNormal, ap.angle, ap.angleDeg, CONFIG.arcRadius * 2.5);
    drawBoundaryLoops(grp, s1.meta, CONFIG.faceColor, 0.5, 2);
    drawBoundaryLoops(grp, s2.meta, CONFIG.faceColor, 0.5, 2);
    return { group: grp, value: ap.angleDeg, center, arcNormal };
}

function createEdgeFaceAngleDimension(edgeSel, faceSel, anglePos) {
    const grp = new THREE.Group();
    const [ev1, ev2] = edgeSel.meta.vertices;
    const edgeDir = norm(sub(ev2, ev1));
    const faceNorm = getSelNormal(faceSel), faceCent = getSelCentroid(faceSel);
    const ptOnEdge = closestPtSeg(faceCent, ev1, ev2);
    const edgeProjOnPlane = norm(sub(edgeDir, mul(faceNorm, dot(edgeDir, faceNorm))));
    const angle = Math.acos(clamp(len(cross(edgeDir, faceNorm)), 0, 1));
    const angleDeg = angle * 180 / Math.PI;
    let arcNormal = norm(cross(edgeProjOnPlane, edgeDir));
    if (len(arcNormal) < 1e-6) arcNormal = faceNorm.clone();
    const extLen = Math.max(dist(ev1, ev2) * 0.8, CONFIG.arcRadius * 1.5);
    const ap = computeAnglePosDirs(edgeProjOnPlane, edgeDir, angle, angleDeg, anglePos);
    addAngleArcParts(grp, ptOnEdge, ap.dir1, ap.dir2, arcNormal, ap.angle, ap.angleDeg, extLen);
    addEdgeLine(grp, ev1, ev2, CONFIG.edgeColor, 0.5, 2);
    drawBoundaryLoops(grp, faceSel.meta, CONFIG.faceColor, 0.5, 2);
    return { group: grp, value: ap.angleDeg, center: ptOnEdge, arcNormal };
}

// ============================================================
// Линии и плоскости: пересечения
// ============================================================

function lineLineClosest(p1, d1, p2, d2) {
    const w0 = sub(p1, p2), a = dot(d1, d1), b = dot(d1, d2), c = dot(d2, d2), d = dot(d1, w0), e = dot(d2, w0);
    const den = a * c - b * b;
    let sc, tc;
    if (Math.abs(den) < 1e-10) { sc = 0; tc = (b > c) ? d / b : e / c; }
    else { sc = (b * e - c * d) / den; tc = (a * e - b * d) / den; }
    const pt1 = add(p1, mul(d1, sc)), pt2 = add(p2, mul(d2, tc));
    return { pt1, pt2, point: midPt(pt1, pt2), s: sc, t: tc, dist: dist(pt1, pt2) };
}

function planePlaneIntersection(n1, p1, n2, p2, refPoint) {
    const d1 = dot(n1, p1), d2 = dot(n2, p2);
    let dir = cross(n1, n2);
    if (len(dir) < 1e-6) return null;
    dir.normalize();
    const axes = [
        { comp: Math.abs(dir.z), solve: () => { const det = n1.x * n2.y - n2.x * n1.y; return Math.abs(det) > 1e-10 ? new THREE.Vector3((d1 * n2.y - d2 * n1.y) / det, (n1.x * d2 - n2.x * d1) / det, 0) : null; } },
        { comp: Math.abs(dir.y), solve: () => { const det = n1.x * n2.z - n2.x * n1.z; return Math.abs(det) > 1e-10 ? new THREE.Vector3((d1 * n2.z - d2 * n1.z) / det, 0, (n1.x * d2 - n2.x * d1) / det) : null; } },
        { comp: Math.abs(dir.x), solve: () => { const det = n1.y * n2.z - n2.y * n1.z; return Math.abs(det) > 1e-10 ? new THREE.Vector3(0, (d1 * n2.z - d2 * n1.z) / det, (n1.y * d2 - n2.y * d1) / det) : null; } }
    ];
    axes.sort((a, b) => b.comp - a.comp);
    const basePoint = axes.reduce((acc, ax) => acc || ax.solve(), null) || new THREE.Vector3();
    const point = refPoint ? add(basePoint, mul(dir, dot(sub(refPoint, basePoint), dir))) : basePoint;
    return { point, direction: dir };
}

function findSharedEdgeBetweenFaces(s1, s2) {
    const loops1 = s1.meta.boundaryLoops || (s1.meta.boundary ? [s1.meta.boundary] : []);
    const loops2 = s2.meta.boundaryLoops || (s2.meta.boundary ? [s2.meta.boundary] : []);
    if (!loops1.length || !loops2.length) return null;
    let bestDist = Infinity, bestMid = null;
    for (const loop1 of loops1) for (let ei1 = 0; ei1 < loop1.length; ei1++) {
        const a1 = loop1[ei1], b1 = loop1[(ei1 + 1) % loop1.length];
        for (const loop2 of loops2) for (let ei2 = 0; ei2 < loop2.length; ei2++) {
            const a2 = loop2[ei2], b2 = loop2[(ei2 + 1) % loop2.length];
            const res = closestPtsOnSegs(a1, b1, a2, b2), d = dist(res.pt1, res.pt2);
            if (d < bestDist) { bestDist = d; bestMid = midPt(res.pt1, res.pt2); }
        }
    }
    return (bestDist < 0.01 && bestMid) ? bestMid : null;
}

function getClosestPointsBetweenFacesOptimized(s1, s2) {
    const faces1 = getWorldFaces(s1.object), faces2 = getWorldFaces(s2.object);
    const getVerts = (sel, faces) => sel.meta.mergedIndices?.length > 0
        ? sel.meta.mergedIndices.flatMap(fi => faces[fi])
        : sel.meta.vertices.slice();
    const verts1 = getVerts(s1, faces1), verts2 = getVerts(s2, faces2);
    let bestP1 = null, bestP2 = null, minDist = Infinity;
    const checkPair = (p1, p2, d) => { if (d < minDist) { minDist = d; bestP1 = p1.clone(); bestP2 = p2.clone(); } };
    for (const v1 of verts1) for (const v2 of verts2) checkPair(v1, v2, dist(v1, v2));
    for (let i = 0; i < verts1.length; i++) for (let j = 0; j < verts2.length; j += 3) {
        const cl = closestPtTri(verts1[i], verts2[j], verts2[j+1], verts2[j+2]); checkPair(verts1[i], cl, dist(verts1[i], cl));
    }
    for (let j = 0; j < verts2.length; j++) for (let i = 0; i < verts1.length; i += 3) {
        const cl = closestPtTri(verts2[j], verts1[i], verts1[i+1], verts1[i+2]); checkPair(cl, verts2[j], dist(verts2[j], cl));
    }
    return { p1: bestP1 ?? verts1[0].clone(), p2: bestP2 ?? verts2[0].clone() };
}

// ============================================================
// РЕЕСТР ТИПОВ ИЗМЕРЕНИЙ
// ============================================================

const angleLabelPrefix = { 'e-e-ang': 'Р-Р', 'f-f-ang': 'Г-Г', 'e-f-ang': `${typeLabels.edge}-${typeLabels.face}` };

const MEAS_TYPES = {
    'edge-len': {
        create: (s1, s2, opts) => createEdgeDimensionLine(s1.meta.vertices[0], s1.meta.vertices[1], opts.dimMode),
        label: (v, suffix) => `Ребро = ${formatNumeric(v)}${suffix}`,
    },
    'edge-radius': {
        create: (s1, s2, opts, meas) => createArcDimension(meas.arcInfo, 'radius'),
        label: v => `R = ${formatNumeric(v)}`,
    },
    'edge-diameter': {
        create: (s1, s2, opts, meas) => createArcDimension(meas.arcInfo, 'diameter'),
        label: v => `D = ${formatNumeric(v)}`,
    },
    'v-v': {
        create: (s1, s2, opts) => createVertexDistLine(s1.point, s2.point, opts.dimMode),
        label: (v, suffix) => `В-В = ${formatNumeric(v)}${suffix}`,
    },
    'e-e-par': {
        create: (s1, s2, opts) => createDistanceDimension('edge-edge', s1.meta.vertices, s2.meta.vertices, undefined, opts.dimMode),
        label: (v, suffix) => `Р-Р || = ${formatNumeric(v)}${suffix}`,
    },
    'e-e-ang': {
        create: (s1, s2) => createEdgeAngleArc(s1.meta.vertices, s2.meta.vertices),
        label: v => (angleLabelPrefix['e-e-ang'] + ' ' + formatAngle(v)),
    },
    'f-f-par': {
        create: (s1, s2, opts) => createDistanceDimension('face-face', s1, s2, undefined, opts.dimMode),
        label: (v, suffix) => `Г-Г || = ${formatNumeric(v)}${suffix}`,
    },
    'f-f-ang': {
        create: (s1, s2) => createDihedralAngleArc(s1, s2),
        label: v => (angleLabelPrefix['f-f-ang'] + ' ' + formatAngle(v)),
    },
    'f-e': {
        create: (s1, s2, opts) => {
            const edgeSel = s1.type === 'edge' ? s1 : s2, faceSel = s1.type === 'face' ? s1 : s2;
            return createDistanceDimension('face-edge', faceSel, edgeSel.meta.vertices[0], edgeSel.meta.vertices[1], opts.dimMode);
        },
        label: (v, suffix) => `${typeLabels.face}-${typeLabels.edge} = ${formatNumeric(v)}${suffix}`,
    },
    'e-f-ang': {
        create: (s1, s2) => {
            const edgeSel = s1.type === 'edge' ? s1 : s2, faceSel = s1.type === 'face' ? s1 : s2;
            return createEdgeFaceAngleDimension(edgeSel, faceSel);
        },
        label: v => (angleLabelPrefix['e-f-ang'] + ' ' + formatAngle(v)),
    },
    'e-v': {
        create: (s1, s2, opts) => {
            const edgeSel = s1.type === 'edge' ? s1 : s2, vertexSel = s1.type === 'vertex' ? s1 : s2;
            return createDistanceDimension('edge-vertex', edgeSel.meta.vertices[0], edgeSel.meta.vertices[1], vertexSel.point, opts.dimMode);
        },
        label: (v, suffix) => `${typeLabels.edge}-${typeLabels.vertex} = ${formatNumeric(v)}${suffix}`,
    },
    'f-v': {
        create: (s1, s2, opts) => {
            const faceSel = s1.type === 'face' ? s1 : s2, vertexSel = s1.type === 'vertex' ? s1 : s2;
            return createDistanceDimension('face-vertex', faceSel, vertexSel.point, opts.dimMode);
        },
        label: (v, suffix) => `${typeLabels.face}-${typeLabels.vertex} = ${formatNumeric(v)}${suffix}`,
    },
    'face-area': {
        create: s1 => createFaceDimension(s1),
        label: v => `Грань S=${formatNumeric(v)} м²`,
    }
};

// ============================================================
// Нормализация пары выделений
// ============================================================

const normPair = (s1, s2) => {
    const types = [s1.type, s2.type].sort().join('-');
    const byType = t => s1.type === t ? s1 : s2.type === t ? s2 : null;
    return { types, edge: byType('edge'), face: byType('face'), vertex: byType('vertex') };
};

// ============================================================
// Управление выделением и метками
// ============================================================

const _setLabelClass = (group, cls, add) =>
    group.traverse(c => c.isCSS2DObject && c.element?.classList.toggle(cls, add));

function _selectMeasurement(id) {
    if (_selectedMeasId === id) { _deselectMeasurement(); return; }
    _deselectMeasurement();
    _selectedMeasId = id;
    const meas = _measurements.find(m => m.id === id);
    if (meas?.group) _setLabelClass(meas.group, 'meas-label-selected', true);
    _updateToolbarState();
}

function _deselectMeasurement() {
    if (_selectedMeasId !== null) {
        const meas = _measurements.find(m => m.id === _selectedMeasId);
        if (meas?.group) _setLabelClass(meas.group, 'meas-label-selected', false);
        _selectedMeasId = null;
    }
    _updateToolbarState();
}

function _addLabelSelectionHandlers(group, measId) {
    const handler = e => { e.stopPropagation(); e.preventDefault(); _selectMeasurement(measId); };
    group.traverse(c => {
        if (c.isCSS2DObject && c.element) {
            Object.assign(c.element.style, { pointerEvents: 'auto', cursor: 'pointer' });
            c.element.addEventListener('click', handler);
            c.element.addEventListener('touchend', handler);
        }
    });
}

// ============================================================
// Добавление / удаление измерений
// ============================================================

function _addMeasurement(s1, s2) {
    let result = null, mType = '', vertexArcInfo = null;
    let adjS1 = s1, adjS2 = s2, s1CircleInfo = null, s2CircleInfo = null;

    if (!s2) {
        const arcInfo = s1.type === 'edge' ? detectArcOrCircle(s1) : s1.type === 'vertex' ? detectArcOrCircleFromVertex(s1) : null;
        if (s1.type === 'edge' && arcInfo) {
            mType = arcInfo.isCircle ? 'edge-diameter' : 'edge-radius';
            result = createArcDimension(arcInfo, arcInfo.isCircle ? 'diameter' : 'radius');
            if (!result) { result = createEdgeDimensionLine(s1.meta.vertices[0], s1.meta.vertices[1]); mType = 'edge-len'; }
        } else if (s1.type === 'edge') {
            result = createEdgeDimensionLine(s1.meta.vertices[0], s1.meta.vertices[1]);
            if (!result) return null;
            mType = 'edge-len';
        } else if (s1.type === 'vertex' && arcInfo) {
            vertexArcInfo = arcInfo;
            mType = arcInfo.isCircle ? 'edge-diameter' : 'edge-radius';
            result = createArcDimension(arcInfo, arcInfo.isCircle ? 'diameter' : 'radius');
            if (!result) return null;
        } else if (s1.type === 'vertex') {
            return null;
        } else if (s1.type === 'face') {
            result = createFaceDimension(s1); mType = 'face-area';
        } else return null;

        if (arcInfo && (mType === 'edge-radius' || mType === 'edge-diameter') && s1.type === 'edge') vertexArcInfo = arcInfo;
    } else {
        s1CircleInfo = adjustSelectionToCircleCenter(s1);
        s2CircleInfo = adjustSelectionToCircleCenter(s2);
        if (s1CircleInfo && s2CircleInfo && dist(s1CircleInfo.center, s2CircleInfo.center) < 0.001) { s1CircleInfo = null; s2CircleInfo = null; }

        adjS1 = s1CircleInfo ? { type: 'vertex', point: s1CircleInfo.center.clone(), object: s1.object, meta: s1.meta } : s1;
        adjS2 = s2CircleInfo ? { type: 'vertex', point: s2CircleInfo.center.clone(), object: s2.object, meta: s2.meta } : s2;

        const pair = normPair(adjS1, adjS2);

        if (pair.types === 'vertex-vertex') {
            result = createVertexDistLine(adjS1.point, adjS2.point); mType = 'v-v';
        } else if (pair.types === 'edge-edge') {
            const e1v = adjS1.meta.vertices, e2v = adjS2.meta.vertices;
            if (areEdgesParallel(e1v[0], e1v[1], e2v[0], e2v[1])) {
                result = createDistanceDimension('edge-edge', e1v, e2v); mType = 'e-e-par';
            } else {
                result = createEdgeAngleArc(e1v, e2v); mType = 'e-e-ang';
            }
        } else if (pair.types === 'face-face') {
            if (areDirectionsParallel(getSelNormal(adjS1), getSelNormal(adjS2))) {
                result = createDistanceDimension('face-face', adjS1, adjS2); mType = 'f-f-par';
            } else {
                result = createDihedralAngleArc(adjS1, adjS2); mType = 'f-f-ang';
            }
        } else if (pair.types === 'edge-face') {
            if (Math.abs(dot(norm(sub(pair.edge.meta.vertices[1], pair.edge.meta.vertices[0])), getSelNormal(pair.face))) < CONFIG.parallelThreshold) {
                mType = 'f-e'; result = MEAS_TYPES['f-e'].create(adjS1, adjS2, {});
            } else {
                result = createEdgeFaceAngleDimension(pair.edge, pair.face); mType = 'e-f-ang';
                if (!result) { mType = 'f-e'; result = MEAS_TYPES['f-e'].create(adjS1, adjS2, {}); }
            }
        } else if (pair.types === 'edge-vertex') {
            mType = 'e-v'; result = MEAS_TYPES['e-v'].create(adjS1, adjS2, {});
        } else if (pair.types === 'face-vertex') {
            mType = 'f-v'; result = MEAS_TYPES['f-v'].create(adjS1, adjS2, {});
        }

        if (result?.group) {
            if (s1CircleInfo) addCenterCrossToGroup(result.group, s1CircleInfo);
            if (s2CircleInfo) addCenterCrossToGroup(result.group, s2CircleInfo);
        }
    }

    if (!result?.group) return null;
    _measurementsGroup.add(result.group);
    const id = ++_measureIdCounter;
    const isAngle = isAngleType(mType), isArc = isArcType(mType), isLinear = !isAngle && !isArc && mType !== 'face-area';
    const mLabel = mType === 'face-area'
        ? MEAS_TYPES[mType].label(result.value)
        : (MEAS_TYPES[mType].label(result.value, ''));

    const meas = {
        id, mType, value: result.value, label: mLabel,
        obj1: s1.object.userData.name || 'Модель',
        obj2: s2 ? (s2.object.userData.name || 'Модель') : '',
        group: result.group, anglePos: 0, dimMode: 0,
        s1: (isAngle || isLinear || isArc) ? adjS1 : null,
        s2: (isAngle || isLinear || isArc) ? adjS2 : null,
        center: result.center || null, arcNormal: result.arcNormal || null,
        arcInfo: isArc ? (vertexArcInfo || detectArcOrCircle(s1)) : null,
        circleCenters: s2 ? [s1CircleInfo, s2CircleInfo] : null
    };
    _measurements.push(meas);
    _clearHL();
    _addLabelSelectionHandlers(result.group, id);
    _selectMeasurement(id);
    return meas;
}

const _disposeGroup = group => {
    group.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) { c.material.map?.dispose(); c.material.dispose(); }
        if (c.isCSS2DObject && c.element) c.element.remove();
    });
};

function _removeMeasurement(id) {
    const i = _measurements.findIndex(m => m.id === id);
    if (i < 0) return;
    const m = _measurements[i];
    if (_selectedMeasId === id) { _selectedMeasId = null; _updateToolbarState(); }
    _measurementsGroup.remove(m.group);
    _disposeGroup(m.group);
    _measurements.splice(i, 1);
}

// ============================================================
// Кэши смежности
// ============================================================

function _buildAdj(m) {
    const mid = m.id;
    if (_adjCache.has(mid)) return _adjCache.get(mid);
    const fs = getWorldFaces(m), e2f = new Map();
    for (let fi = 0; fi < fs.length; fi++) {
        const v = fs[fi];
        for (let ei = 0; ei < 3; ei++) {
            const ek = [vKey(v[ei]), vKey(v[(ei + 1) % 3])].sort().join('|');
            if (!e2f.has(ek)) e2f.set(ek, []);
            e2f.get(ek).push(fi);
        }
    }
    const result = { faces: fs, edgeToFace: e2f };
    _adjCache.set(mid, result);
    return result;
}

const mergedArea = (idx, m) => getWorldFaces(m).reduce((t, v, i) => idx.includes(i) ? t + triArea(...v) : t, 0);
function mergedCenter(idx, m) { const fs = getWorldFaces(m); const c = new THREE.Vector3(); let ta = 0; for (const i of idx) { const v = fs[i], a = triArea(...v); c.add(mul(triCenter(...v), a)); ta += a; } return c.divideScalar(ta || 1); }
function surfNormal(idx, m) { const fs = getWorldFaces(m); if (!idx.length) return new THREE.Vector3(0, 1, 0); const tn = new THREE.Vector3(); let ta = 0; for (const i of idx) { const v = fs[i], a = triArea(...v); tn.add(mul(faceNormal(...v), a)); ta += a; } return tn.length() < 0.01 ? faceNormal(...fs[idx[0]]) : norm(tn); }

function getBoundaryEdges(idx, m) {
    const fs = getWorldFaces(m), ec = new Map(), ev = new Map();
    for (const fi of idx) {
        const v = fs[fi];
        for (let ei = 0; ei < 3; ei++) {
            const ek = [vKey(v[ei]), vKey(v[(ei + 1) % 3])].sort().join('|');
            ec.set(ek, (ec.get(ek) || 0) + 1);
            if (!ev.has(ek)) ev.set(ek, [v[ei].clone(), v[(ei + 1) % 3].clone()]);
        }
    }
    return [...ec.entries()].filter(([, count]) => count === 1).map(([ek]) => ev.get(ek));
}

function getBoundaryLoops(idx, m) {
    const es = getBoundaryEdges(idx, m);
    if (!es.length) return [];
    const loops = [], used = new Set();
    const vKeyToEdgeIdx = new Map();
    es.forEach((e, ei) => {
        for (const k of [vKey(e[0]), vKey(e[1])]) {
            if (!vKeyToEdgeIdx.has(k)) vKeyToEdgeIdx.set(k, []);
            vKeyToEdgeIdx.get(k).push(ei);
        }
    });
    for (let si = 0; si < es.length; si++) {
        if (used.has(si)) continue;
        const loop = [es[si][0].clone()];
        let ce = es[si][1].clone(), ceKey = vKey(es[si][1]), safe = es.length + 1;
        used.add(si);
        while (safe-- > 0) {
            if (ceKey === vKey(loop[0]) && loop.length > 2) break;
            const candidates = vKeyToEdgeIdx.get(ceKey) || [];
            let found = false;
            for (const i of candidates) {
                if (used.has(i)) continue;
                const ek0 = vKey(es[i][0]), ek1 = vKey(es[i][1]);
                if (ek0 === ceKey) { loop.push(es[i][0].clone()); ce = es[i][1].clone(); ceKey = ek1; used.add(i); found = true; break; }
                if (ek1 === ceKey) { loop.push(es[i][1].clone()); ce = es[i][0].clone(); ceKey = ek0; used.add(i); found = true; break; }
            }
            if (!found) break;
        }
        if (loop.length > 2) loops.push(loop);
    }
    return loops;
}

function _buildSmooth(m) {
    const mid = m.id;
    if (_smoothCache.has(mid)) return _smoothCache.get(mid);
    const adj = _buildAdj(m), { faces: fs, edgeToFace: e2f } = adj;
    const minP = new THREE.Vector3(Infinity, Infinity, Infinity), maxP = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const f of fs) for (const v of f) { minP.min(v); maxP.max(v); }
    const modelSize = dist(minP, maxP), copD = CONFIG.coplanarDistThreshold || (modelSize * 0.00005), smoothTh = CONFIG.smoothAngleThreshold;
    const visited = new Set();
    let surfaces = []; const f2s = new Map();
    for (let fi = 0; fi < fs.length; fi++) {
        if (visited.has(fi)) continue;
        const q = [fi], merged = [];
        let refN = null, refD = null;
        while (q.length) {
            const cur = q.shift();
            if (visited.has(cur)) continue;
            visited.add(cur);
            merged.push(cur);
            const v = fs[cur];
            if (!refN) { refN = faceNormal(...v); refD = -dot(refN, v[0]); }
            for (let ei = 0; ei < 3; ei++) {
                const ek = [vKey(v[ei]), vKey(v[(ei + 1) % 3])].sort().join('|');
                for (const afi of e2f.get(ek) || []) {
                    if (visited.has(afi)) continue;
                    const av = fs[afi];
                    if (av.every(avv => Math.abs(dot(refN, avv) + refD) <= copD)) q.push(afi);
                }
            }
        }
        const si = surfaces.length;
        for (const mi of merged) f2s.set(mi, si);
        const loops = getBoundaryLoops(merged, m);
        surfaces.push({ indices: merged, boundary: loops[0] || [], boundaryLoops: loops, area: mergedArea(merged, m), centroid: mergedCenter(merged, m), normal: surfNormal(merged, m), _flat: merged.length >= 2 });
    }
    const p2Visited = new Set();
    for (let si = 0; si < surfaces.length; si++) {
        if (!surfaces[si] || surfaces[si]._flat || p2Visited.has(si)) continue;
        const cq = [si], cGroups = [];
        while (cq.length) {
            const curSi = cq.shift();
            if (p2Visited.has(curSi)) continue;
            p2Visited.add(curSi);
            if (!surfaces[curSi]?._flat) cGroups.push(curSi);
            if (!surfaces[curSi] || surfaces[curSi]._flat) continue;
            const s = surfaces[curSi];
            for (const ti of s.indices) {
                const v = fs[ti];
                for (let ei = 0; ei < 3; ei++) {
                    const ek = [vKey(v[ei]), vKey(v[(ei + 1) % 3])].sort().join('|');
                    for (const afi of e2f.get(ek) || []) {
                        const adjSi = f2s.get(afi);
                        if (adjSi !== undefined && adjSi !== curSi && !p2Visited.has(adjSi) && surfaces[adjSi] && !surfaces[adjSi]._flat) {
                            const av = fs[afi];
                            if (len(cross(faceNormal(...v), faceNormal(...av))) < smoothTh) cq.push(adjSi);
                        }
                    }
                }
            }
        }
        if (cGroups.length > 1) {
            const tS = surfaces[cGroups[0]];
            for (let gi = 1; gi < cGroups.length; gi++) {
                const srcS = surfaces[cGroups[gi]];
                for (const mi of srcS.indices) { tS.indices.push(mi); f2s.set(mi, cGroups[0]); }
                surfaces[cGroups[gi]] = null;
            }
            tS.boundaryLoops = getBoundaryLoops(tS.indices, m);
            tS.boundary = tS.boundaryLoops[0] || [];
            tS.area = mergedArea(tS.indices, m);
            tS.centroid = mergedCenter(tS.indices, m);
            tS.normal = surfNormal(tS.indices, m);
        }
    }
    const clean = [], old2new = new Map();
    for (let si = 0; si < surfaces.length; si++) if (surfaces[si]) { old2new.set(si, clean.length); clean.push(surfaces[si]); }
    for (const [fk, oldSi] of f2s) { const newSi = old2new.get(oldSi); if (newSi !== undefined) f2s.set(fk, newSi); }
    surfaces = clean;
    const fEdges = [], feSet = new Set(), fvMap = new Map();
    for (const [ek, af] of e2f) {
        let isFeat = af.length === 1 || af.length >= 3;
        if (af.length === 2) { const si1 = f2s.get(af[0]), si2 = f2s.get(af[1]); if (si1 !== si2) isFeat = true; }
        if (!isFeat) continue;
        for (const fi of af) {
            if (feSet.has(ek)) break;
            const v = fs[fi];
            for (let ei = 0; ei < 3; ei++) {
                if ([vKey(v[ei]), vKey(v[(ei + 1) % 3])].sort().join('|') === ek) {
                    feSet.add(ek);
                    fEdges.push([v[ei].clone(), v[(ei + 1) % 3].clone()]);
                    for (const vk of [vKey(v[ei]), vKey(v[(ei + 1) % 3])]) {
                        if (!fvMap.has(vk)) fvMap.set(vk, (vk === vKey(v[ei]) ? v[ei] : v[(ei + 1) % 3]).clone());
                    }
                    break;
                }
            }
        }
    }
    const res = { surfaces, faceToSurface: f2s, featureEdges: fEdges, featureVerts: [...fvMap.values()] };
    _smoothCache.set(mid, res);
    return res;
}

// ============================================================
// Привязка к элементам
// ============================================================

function _snapToElement(point, mesh) {
    const checkV = _activeModes.vertex, checkE = _activeModes.edge, checkF = _activeModes.face;
    const vSnap = _useAutoSnapRadii ? CONFIG.snapRadius : CONFIG.snapRadiusStrict;
    const eSnap = _useAutoSnapRadii ? CONFIG.edgeSnapDist : CONFIG.edgeSnapDistStrict;
    const smoothData = _buildSmooth(mesh), faces = getWorldFaces(mesh);
    let vRes = null, vMin = Infinity, eRes = null, eMin = Infinity, fRes = null, fMin = Infinity;
    if (checkV) for (let i = 0; i < smoothData.featureVerts.length; i++) { const d = dist(point, smoothData.featureVerts[i]); if (d < vSnap && d < vMin) { vMin = d; vRes = { type: 'vertex', point: smoothData.featureVerts[i].clone(), object: mesh, meta: { index: i } }; } }
    if (checkE) for (let i = 0; i < smoothData.featureEdges.length; i++) { const cl = closestPtSeg(point, ...smoothData.featureEdges[i]), d = dist(point, cl); if (d < eSnap && d < eMin) { eMin = d; eRes = { type: 'edge', point: cl.clone(), object: mesh, meta: { index: i, vertices: smoothData.featureEdges[i].map(v => v.clone()), isBoundary: true } }; } }
    if (checkF) for (const surf of smoothData.surfaces) for (const fi of surf.indices) {
        const cl = closestPtTri(point, ...faces[fi]), d = dist(point, cl);
        if (d < CONFIG.faceSnapDist && d < fMin) { fMin = d; fRes = { type: 'face', point: cl.clone(), object: mesh, meta: { index: fi, vertices: faces[fi].map(v => v.clone()), mergedIndices: surf.indices, boundary: surf.boundary, boundaryLoops: surf.boundaryLoops, area: surf.area, centroid: surf.centroid, normal: surf.normal } }; }
    }
    const activeCount = checkV + checkE + checkF;
    if (activeCount > 1) return vRes || eRes || fRes;
    if (checkV) return vRes; if (checkE) return eRes; return fRes;
}

function _findSnapElement(ev) {
    const rect = _renderer.domElement.getBoundingClientRect();
    _mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    _raycaster.setFromCamera(_mouse, _camera);
    // ВАЖНО: recursive=false.
    // В интегрированной версии 3d-viewer.js вызывает addEdgesToObject(model),
    // который добавляет каждому мешу дочерний LineSegments (рёбра/диагонали).
    // С recursive=true (по умолчанию) raycaster попадает в эти LineSegments
    // вместо самой геометрии меша — из-за чего:
    //   1) при наведении подсвечиваются диагонали и линии рёбер;
    //   2) detectArcOrCircle ломается (работает с LineSegments-геометрией) → диаметр не определяется.
    // recursive=false заставляет raycaster тестировать только собственную
    // геометрию мешей (как в оригинальном standalone-варианте, где у мешей
    // вообще не было детей).
    // Дополнительный фильтр isMesh — защитный пояс на случай вложенных мешей.
    const allHits = _raycaster.intersectObjects(_meshObjects, false);
    const hits = allHits.filter(h => h.object.isMesh);
    return hits.length > 0 ? _snapToElement(hits[0].point, hits[0].object) : null;
}

// ============================================================
// Подсветка
// ============================================================

function _highlight(sel) {
    _clearHL();
    if (!sel) return;
    if (sel.type === 'edge' && sel.meta.vertices) {
        _edgeHighlight = makeLine(sel.meta.vertices, CONFIG.edgeColor, { linewidth: 2 });
        _edgeHighlight.renderOrder = 999;
        _helpersGroup.add(_edgeHighlight);
    } else if (sel.type === 'face') {
        _faceHighlight = new THREE.Group();
        drawBoundaryLoops(_faceHighlight, sel.meta, CONFIG.faceColor, null, 2);
        if (_faceHighlight.children.length > 0) _helpersGroup.add(_faceHighlight);
        else _faceHighlight = null;
    }
}

function _clearHL() {
    if (_edgeHighlight) { _helpersGroup.remove(_edgeHighlight); _edgeHighlight.geometry?.dispose(); _edgeHighlight.material?.dispose(); _edgeHighlight = null; }
    if (_faceHighlight) { _helpersGroup.remove(_faceHighlight); _faceHighlight.traverse(c => { c.geometry?.dispose(); c.material?.dispose(); }); _faceHighlight = null; }
    const rem = _helpersGroup.children.filter(c => c.userData?.isFaceFill || (c.isMesh && c.material?.transparent && c.material.opacity === 0.2));
    rem.forEach(c => { _helpersGroup.remove(c); c.geometry?.dispose(); c.material?.dispose(); });
}

// ============================================================
// Пересоздание и переключение
// ============================================================

function _applyRecreatedMeasurement(meas, result, measId) {
    _measurementsGroup.add(result.group);
    meas.group = result.group;
    meas.value = result.value;
    if (result.center) meas.center = result.center;
    if (result.arcNormal) meas.arcNormal = result.arcNormal;
    _addLabelSelectionHandlers(result.group, measId);
    if (_selectedMeasId === measId) _setLabelClass(meas.group, 'meas-label-selected', true);
}

function _cycleAnglePosition(measId) {
    const meas = _measurements.find(m => m.id === measId);
    if (!meas?.s1 || !meas.s2) return;
    let step = 1;
    if (meas.arcNormal && _camera) { if (dot(meas.arcNormal, norm(sub(_camera.position, meas.center || new THREE.Vector3()))) > 0) step = -1; }
    meas.anglePos = ((meas.anglePos || 0) + step + 4) % 4;
    _measurementsGroup.remove(meas.group);
    _disposeGroup(meas.group);
    const result = _recreateAngleResult(meas.mType, meas.s1, meas.s2, meas.anglePos);
    if (!result?.group) return;
    meas.label = MEAS_TYPES[meas.mType]?.label(result.value) ?? formatAngle(result.value);
    _applyRecreatedMeasurement(meas, result, measId);
}

function _recreateAngleResult(mType, s1, s2, anglePos) {
    if (mType === 'e-e-ang') return createEdgeAngleArc(s1.meta.vertices, s2.meta.vertices, anglePos);
    if (mType === 'f-f-ang') return createDihedralAngleArc(s1, s2, anglePos);
    if (mType === 'e-f-ang') {
        const { edge, face } = normPair(s1, s2);
        return createEdgeFaceAngleDimension(edge, face, anglePos);
    }
    return null;
}

function _recreateLinearMeasurement(meas) {
    const type = MEAS_TYPES[meas.mType];
    const result = type?.create(meas.s1, meas.s2, { dimMode: meas.dimMode || 0 }, meas) ?? null;
    if (result?.group && meas.circleCenters) {
        meas.circleCenters.forEach(cc => { if (cc) addCenterCrossToGroup(result.group, cc); });
    }
    return result;
}

function _updateLinearMeasLabel(meas) {
    const suffix = meas.dimMode === 1 ? ' (H)' : meas.dimMode === 2 ? ' (V)' : '';
    const type = MEAS_TYPES[meas.mType];
    meas.label = type?.label(meas.value, suffix) ?? meas.label;
}

function _toggleDimMode(measId) {
    const meas = _measurements.find(m => m.id === measId);
    if (!meas?.s1) return;
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        meas.dimMode = ((meas.dimMode || 0) + 1) % 3;
        if (meas.group) { _measurementsGroup.remove(meas.group); _disposeGroup(meas.group); }
        result = _recreateLinearMeasurement(meas);
        if (result?.group && result.value > 0.5) break;
        result = null;
    }
    if (!result?.group) { meas.dimMode = 0; result = _recreateLinearMeasurement(meas); }
    if (!result?.group) return;
    _updateLinearMeasLabel(meas);
    _applyRecreatedMeasurement(meas, result, measId);
}

// ============================================================
// Панель инструментов — состояние
// ============================================================

function _updateToolbarState() {
    if (!_toolbarEl) return;
    const deleteBtn = _toolbarEl.querySelector('[data-action="delete"]');
    const confirmBtn = _toolbarEl.querySelector('[data-action="confirm"]');
    const positionBtn = _toolbarEl.querySelector('[data-action="position"]');
    if (!deleteBtn) return;

    if (_selectedMeasId !== null) {
        deleteBtn.classList.add('active');
    } else {
        deleteBtn.classList.remove('active');
    }

    if (_firstMeasId !== null) {
        confirmBtn?.classList.add('active');
    } else {
        confirmBtn?.classList.remove('active');
    }

    if (_selectedMeasId !== null) {
        const meas = _measurements.find(m => m.id === _selectedMeasId);
        if (meas) {
            const isAng = isAngleType(meas.mType);
            const isLin = (meas.mType === 'edge-len' || meas.mType === 'v-v' || meas.mType === 'e-e-par' || meas.mType === 'f-f-par' || meas.mType === 'e-v' || meas.mType === 'f-v' || meas.mType === 'f-e' || meas.mType === 'edge-radius' || meas.mType === 'edge-diameter');
            if ((isLin && meas.s1) || isAng) {
                positionBtn?.classList.add('active');
                if (isAng) {
                    positionBtn?.classList.add('active-angle');
                } else {
                    positionBtn?.classList.remove('active-angle');
                }
                const iconLinear = positionBtn?.querySelector('.pos-icon-linear');
                const iconAngle = positionBtn?.querySelector('.pos-icon-angle');
                if (iconLinear && iconAngle) {
                    if (isAng) { iconLinear.style.display = 'none'; iconAngle.style.display = ''; }
                    else { iconLinear.style.display = ''; iconAngle.style.display = 'none'; }
                }
            } else {
                positionBtn?.classList.remove('active');
                positionBtn?.classList.remove('active-angle');
            }
        }
    } else {
        positionBtn?.classList.remove('active');
        positionBtn?.classList.remove('active-angle');
    }
}

// ============================================================
// Взаимодействие
// ============================================================

function _cancelSelection() {
    if (_firstMeasId !== null) { _removeMeasurement(_firstMeasId); _firstMeasId = null; }
    _firstSelection = null;
    _firstMarker.visible = false;
    _clearHL();
    _deselectMeasurement();
}

function _handleInteraction(clientX, clientY) {
    const ev = { clientX, clientY };
    const snap = _findSnapElement(ev);
    if (!snap) return;

    if (!_firstSelection) {
        _firstSelection = snap;
        _firstMarker.visible = true;
        _firstMarker.position.copy(snap.point);
        const circleInfo = adjustSelectionToCircleCenter(snap);
        if (circleInfo) _firstMarker.position.copy(circleInfo.center);
        const colors = { vertex: CONFIG.vertexColor, edge: CONFIG.edgeColor, face: CONFIG.faceColor };
        _firstMarker.children[0].material.color.setHex(colors[snap.type]);

        if (snap.type === 'vertex' || snap.type === 'edge' || snap.type === 'face') {
            const meas = _addMeasurement(snap, null);
            if (meas) { _firstMeasId = meas.id; _updateToolbarState(); }
        } else { _cancelSelection(); }
    } else {
        if (_firstMeasId !== null) { _removeMeasurement(_firstMeasId); _firstMeasId = null; }
        const meas = _addMeasurement(_firstSelection, snap);
        if (!meas) {
            _firstSelection = null; _firstMarker.visible = false; _firstMeasId = null;
            _updateToolbarState(); return;
        }
        setTimeout(() => {
            _firstSelection = null; _firstMarker.visible = false; _firstMeasId = null;
            _updateToolbarState();
        }, 800);
    }
}

// ============================================================
// Анимационный цикл
// ============================================================

function _animate() {
    _animFrameId = requestAnimationFrame(_animate);
    _animT += 0.03;
    if (_firstMarker && _firstMarker.visible) {
        const s = 1 + Math.sin(_animT * 3) * 0.15;
        _firstMarker.scale.set(s, s, s);
    }
    if (_hoverMarker && _hoverMarker.visible) {
        const s = 1 + Math.sin(_animT * 4) * 0.1;
        _hoverMarker.scale.set(s, s, s);
    }
    if (_labelRenderer && _scene && _camera) {
        _labelRenderer.render(_scene, _camera);
    }
}

// ============================================================
// Утилиты init/destroy
// ============================================================

function _createMarker(color, scale) {
    scale = scale || 1;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(
        new THREE.SphereGeometry(0.002 * scale, 6, 4),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
    ));
    return g;
}

function _collectMeshes() {
    _meshObjects = [];
    if (!_model) return;
    _model.traverse(child => { if (child.isMesh) _meshObjects.push(child); });
}

function _showRipple(x, y) {
    const r = document.createElement('div');
    r.className = 'touch-ripple';
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    _container.appendChild(r);
    setTimeout(() => r.remove(), 500);
}

// ============================================================
// РЕГИСТРАЦИЯ ПЛАГИНА
// ============================================================

PluginManager.register({
    id: 'measure',
    name: 'Измерение',
    icon: 'square_foot',
    module: '3d-viewer',

    /**
     * Кнопка плагина показывается только если модель уже загружена.
     * PluginManager переоценивает condition при каждом событии modelLoaded.
     */
    condition: (api) => !!(api && api.model && api.scene),

    init(api) {
        if (!api.scene || !api.model) return;

        _camera = api.camera;
        _renderer = api.renderer;
        _controls = api.controls;
        _scene = api.scene;
        _model = api.model;
        _container = document.getElementById('model-container');

        // Собираем меши
        _collectMeshes();
        _model.updateMatrixWorld(true);

        // Группы
        _helpersGroup = new THREE.Group();
        _helpersGroup.name = 'measure-helpers';
        _scene.add(_helpersGroup);

        _measurementsGroup = new THREE.Group();
        _measurementsGroup.name = 'measurements';
        _scene.add(_measurementsGroup);

        // Маркеры
        _firstMarker = _createMarker(CONFIG.vertexColor);
        _firstMarker.visible = false;
        _helpersGroup.add(_firstMarker);

        _hoverMarker = _createMarker(CONFIG.highlightColor, 0.6);
        _hoverMarker.visible = false;
        _helpersGroup.add(_hoverMarker);

        // CSS2DRenderer
        _labelRenderer = new CSS2DRenderer();
        _labelRenderer.setSize(_container.clientWidth, _container.clientHeight);
        _labelRenderer.domElement.style.position = 'absolute';
        _labelRenderer.domElement.style.top = '0px';
        _labelRenderer.domElement.style.left = '0px';
        _labelRenderer.domElement.style.pointerEvents = 'none';
        _labelRenderer.domElement.style.overflow = 'hidden';
        _labelRenderer.domElement.style.zIndex = '50';
        _container.appendChild(_labelRenderer.domElement);

        // Сброс состояния
        _selectedMeasId = null;
        _measureIdCounter = 0;
        _measurements = [];
        _firstSelection = null;
        _firstMeasId = null;
        _activeModes = { vertex: true, edge: true, face: true };
        _useAutoSnapRadii = true;
        _edgeHighlight = null;
        _faceHighlight = null;
        _cameraMoved = false;
        _clearCache();

        // Определение движения камеры (отличие клика от орбиты)
        _controlsStartHandler = () => {
            _initialCamPos = _camera.position.clone();
            _initialCamTarget = _controls.target.clone();
        };
        _controlsChangeHandler = () => {
            if (!_initialCamPos || !_initialCamTarget) return;
            if (!_camera.position.equals(_initialCamPos) || !_controls.target.equals(_initialCamTarget)) {
                _cameraMoved = true;
                if (_cameraMoveTimer) clearTimeout(_cameraMoveTimer);
                _cameraMoveTimer = setTimeout(() => { _cameraMoved = false; }, 300);
            }
        };
        _controls.addEventListener('start', _controlsStartHandler);
        _controls.addEventListener('change', _controlsChangeHandler);

        // События на canvas
        const canvas = _renderer.domElement;

        const mousemoveHandler = ev => {
            const snap = _findSnapElement(ev);
            if (snap) {
                _hoverMarker.visible = true;
                _hoverMarker.position.copy(snap.point);
                _highlight(snap);
                canvas.style.cursor = 'crosshair';
            } else {
                _hoverMarker.visible = false;
                _clearHL();
                canvas.style.cursor = 'default';
            }
        };
        canvas.addEventListener('mousemove', mousemoveHandler);
        _boundEventHandlers.push({ el: canvas, type: 'mousemove', handler: mousemoveHandler });

        const clickHandler = e => {
            if (_cameraMoved) { _cameraMoved = false; return; }
            if (_clickTimeout) clearTimeout(_clickTimeout);
            _clickTimeout = setTimeout(() => { _handleInteraction(e.clientX, e.clientY); _clickTimeout = null; }, 10);
        };
        canvas.addEventListener('click', clickHandler);
        _boundEventHandlers.push({ el: canvas, type: 'click', handler: clickHandler });

        const ctxHandler = e => e.preventDefault();
        canvas.addEventListener('contextmenu', ctxHandler);
        _boundEventHandlers.push({ el: canvas, type: 'contextmenu', handler: ctxHandler });

        const touchstartHandler = e => {
            if (e.touches.length === 1) {
                const t = e.touches[0];
                _touchStartPos = { x: t.clientX, y: t.clientY };
                _touchStartTime = Date.now();
                _touchMoved = false;
            }
        };
        canvas.addEventListener('touchstart', touchstartHandler, { passive: true });
        _boundEventHandlers.push({ el: canvas, type: 'touchstart', handler: touchstartHandler, opts: { passive: true } });

        const touchmoveHandler = e => {
            if (_touchStartPos && e.touches.length === 1) {
                const t = e.touches[0];
                if (Math.abs(t.clientX - _touchStartPos.x) > 15 || Math.abs(t.clientY - _touchStartPos.y) > 15) {
                    _touchMoved = true;
                }
            }
        };
        canvas.addEventListener('touchmove', touchmoveHandler, { passive: true });
        _boundEventHandlers.push({ el: canvas, type: 'touchmove', handler: touchmoveHandler, opts: { passive: true } });

        const touchendHandler = e => {
            if (_touchStartPos && !_touchMoved && (Date.now() - _touchStartTime) < 350) {
                e.preventDefault();
                _showRipple(_touchStartPos.x, _touchStartPos.y);
                _handleInteraction(_touchStartPos.x, _touchStartPos.y);
            }
            _touchStartPos = null;
            _touchMoved = false;
        };
        canvas.addEventListener('touchend', touchendHandler, { passive: false });
        _boundEventHandlers.push({ el: canvas, type: 'touchend', handler: touchendHandler, opts: { passive: false } });

        // Resize CSS2DRenderer — используем ResizeObserver вместо window.resize,
        // чтобы ловить изменение размера контейнера при фуллскрине и перетаскивании панели.
        _resizeHandler = () => {
            if (_labelRenderer && _container) {
                _labelRenderer.setSize(_container.clientWidth, _container.clientHeight);
            }
        };
        window.addEventListener('resize', _resizeHandler);
        if (typeof ResizeObserver !== 'undefined' && _container) {
            _resizeObserver = new ResizeObserver(_resizeHandler);
            _resizeObserver.observe(_container);
        }

        // Анимация
        _animate();

        return () => {
            window.removeEventListener('resize', _resizeHandler);
            if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
        };
    },

    destroy() {
        // Останавливаем анимацию
        if (_animFrameId) { cancelAnimationFrame(_animFrameId); _animFrameId = null; }

        // Удаляем все измерения
        for (const m of [..._measurements]) {
            if (m.group) { _measurementsGroup?.remove(m.group); _disposeGroup(m.group); }
        }
        _measurements = [];
        _selectedMeasId = null;
        _firstSelection = null;
        _firstMeasId = null;

        // Удаляем группы из сцены
        if (_helpersGroup) {
            _scene?.remove(_helpersGroup);
            _helpersGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
            _helpersGroup = null;
        }
        if (_measurementsGroup) {
            _scene?.remove(_measurementsGroup);
            _measurementsGroup = null;
        }

        // Удаляем CSS2DRenderer
        if (_labelRenderer?.domElement?.parentNode) {
            _labelRenderer.domElement.parentNode.removeChild(_labelRenderer.domElement);
        }
        _labelRenderer = null;

        // Снимаем события с canvas
        for (const { el, type, handler, opts } of _boundEventHandlers) {
            el.removeEventListener(type, handler, opts);
        }
        _boundEventHandlers = [];

        // Resize
        if (_resizeHandler) { window.removeEventListener('resize', _resizeHandler); _resizeHandler = null; }
        if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }

        // Контролсы
        if (_controlsStartHandler) _controls?.removeEventListener('start', _controlsStartHandler);
        if (_controlsChangeHandler) _controls?.removeEventListener('change', _controlsChangeHandler);
        _controlsStartHandler = null;
        _controlsChangeHandler = null;

        // Кэши
        _clearCache();

        // Сброс
        _camera = null; _renderer = null; _controls = null; _scene = null; _model = null;
        _container = null; _toolbarEl = null; _meshObjects = [];
        _firstMarker = null; _hoverMarker = null;
    },

    panel: {
        className: 'measure-panel plugin-pill',

        html: `
            <div class="measure-toolbar">
                <div class="measure-group plugin-pill-group">
                    <button class="measure-btn plugin-pill-btn active" data-mode="vertex" title="Вершина">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><circle cx="12" cy="12" r="5"/></svg>
                    </button>
                    <button class="measure-btn plugin-pill-btn active" data-mode="edge" title="Ребро">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="20" height="20">
                            <line x1="5" y1="19" x2="19" y2="5"/><circle cx="5" cy="19" r="2.5" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="2.5" fill="currentColor" stroke="none"/>
                        </svg>
                    </button>
                    <button class="measure-btn plugin-pill-btn active" data-mode="face" title="Грань">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="4" y="4" width="16" height="16" rx="1.5"/></svg>
                    </button>
                </div>
                <div class="measure-divider plugin-pill-divider"></div>
                <div class="measure-group plugin-pill-group">
                    <button class="measure-btn plugin-pill-btn" data-action="delete" title="Удалить">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20">
                            <line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/>
                        </svg>
                    </button>
                    <button class="measure-btn plugin-pill-btn" data-action="confirm" title="Подтвердить">
                        <svg viewBox="0 0 640 640" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">                 
                            <path d="M530.8 134.1C545.1 144.5 548.3 164.5 537.9 178.8L281.9 530.8C276.4 538.4 267.9 543.1 258.5 543.9C249.1 544.7 240 541.2 233.4 534.6L105.4 406.6C92.9 394.1 92.9 373.8 105.4 361.3C117.9 348.8 138.2 348.8 150.7 361.3L252.2 462.8L486.2 141.1C496.6 126.8 516.6 123.6 530.9 134z"/>
                         </svg>
                    </button>
                    <button class="measure-btn plugin-pill-btn" data-action="position" title="Положение">
                        <svg class="pos-icon-linear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20">
                            <line x1="4" y1="12" x2="20" y2="12"/><polyline points="17,9 20,12 17,15"/><polyline points="7,9 4,12 7,15"/>
                        </svg>
                        <svg class="pos-icon-angle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20" style="display:none">
                            <path d="M5,19 L5,5"/><path d="M5,5 L19,5"/><path d="M8,5 A3,3 0 0,1 5,8"/>
                        </svg>
                    </button>
                </div>
            </div>
        `,

        onMount(toolbar) {
            _toolbarEl = toolbar;

            // Кнопки привязки
            const modeBtns = toolbar.querySelectorAll('.measure-btn[data-mode]');
            modeBtns.forEach(btn => {
                const handler = () => {
                    btn.classList.toggle('active');
                    _activeModes = { vertex: false, edge: false, face: false };
                    modeBtns.forEach(b => { if (b.classList.contains('active')) _activeModes[b.dataset.mode] = true; });
                    const anyActive = _activeModes.vertex || _activeModes.edge || _activeModes.face;
                    if (!anyActive) { btn.classList.add('active'); _activeModes[btn.dataset.mode] = true; }
                    _useAutoSnapRadii = (_activeModes.vertex + _activeModes.edge + _activeModes.face) > 1;
                };
                btn.addEventListener('click', handler);
                _boundEventHandlers.push({ el: btn, type: 'click', handler });
            });

            // Удалить
            const deleteBtn = toolbar.querySelector('[data-action="delete"]');
            if (deleteBtn) {
                const handler = () => {
                    if (_selectedMeasId !== null) {
                        const deletedId = _selectedMeasId;
                        _removeMeasurement(deletedId);
                        if (_firstMeasId === deletedId) { _firstMeasId = null; _firstSelection = null; _firstMarker.visible = false; _clearHL(); }
                        if (_firstMarker?.visible) { _firstMarker.visible = false; _firstSelection = null; _firstMeasId = null; _clearHL(); }
                        _updateToolbarState();
                    }
                };
                deleteBtn.addEventListener('click', handler);
                _boundEventHandlers.push({ el: deleteBtn, type: 'click', handler });
            }

            // Подтвердить
            const confirmBtn = toolbar.querySelector('[data-action="confirm"]');
            if (confirmBtn) {
                const handler = () => {
                    if (_firstMeasId !== null) {
                        _firstSelection = null;
                        _firstMarker.visible = false;
                        _firstMeasId = null;
                        _updateToolbarState();
                    }
                };
                confirmBtn.addEventListener('click', handler);
                _boundEventHandlers.push({ el: confirmBtn, type: 'click', handler });
            }

            // Положение
            const positionBtn = toolbar.querySelector('[data-action="position"]');
            if (positionBtn) {
                const handler = () => {
                    if (_selectedMeasId !== null) {
                        const meas = _measurements.find(m => m.id === _selectedMeasId);
                        if (!meas) return;
                        if (isAngleType(meas.mType)) { _cycleAnglePosition(_selectedMeasId); }
                        else if (meas.s1) { _toggleDimMode(_selectedMeasId); }
                    }
                };
                positionBtn.addEventListener('click', handler);
                _boundEventHandlers.push({ el: positionBtn, type: 'click', handler });
            }

            _updateToolbarState();
        },

        onUnmount() {
            _toolbarEl = null;
        }
    }
});