/**
 * Плагин: Сборка — анимированная последовательность сборки изделия (3D).
 *
 * Редактирование: клик по детали (или по строке спецификации) добавляет её
 * в текущий шаг последовательности. Отмеченные детали исчезают или становятся
 * призраками (переключатель). Шаги формируются гибко: «Новый шаг», авто-шаг
 * после каждого клика, групповое добавление узлов спецификации.
 *
 * Выбор сборок: кнопка «Сборка ↑» расширяет выбор от детали до родительской
 * сборки (подъём по дереву, как «выделить родителя» в «Перемещении»), кнопка
 * «Все» добавляет все такие же сборки или детали (напр. все 50 колонн разом).
 *
 * Воспроизведение: детали устанавливаются по шагам в отмеченном порядке.
 * Стили появления: растворение, падение сверху, выезд слева/справа,
 * масштабирование. Плеер: play/pause, шаг вперёд/назад, таймлайн со
 * скраббингом, скорость, повтор, призрак недособранного.
 *
 * Передача: экспорт/импорт JSON (формат nbm-assembly, отпечаток модели +
 * сопоставление по имени, как у «Монтажа»). Автосохранение в localStorage
 * по проекту. При деактивации плагина материалы/видимость/трансформации
 * полностью восстанавливаются.
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';
import { escapeHtml } from '../app.js';

// ============================================================
// КОНСТАНТЫ
// ============================================================

const PLUGIN_ID = 'assembly';
const STORAGE_PREFIX = 'pluginAssembly:';

const CLICK_MOVE_TOLERANCE = 25;   // px² — как в 3d-viewer (отличие клика от орбиты)
const EDIT_GHOST_OPACITY = 0.18;   // отмеченная деталь (чужой шаг)
const CUR_GHOST_OPACITY = 0.35;    // отмеченная деталь (текущий шаг)
const PLAY_GHOST_OPACITY = 0.12;   // призрак недособранного в плеере
const MAX_UNDO = 60;

/** Стили появления детали. */
const STYLES = ['fade', 'drop', 'slide-left', 'slide-right', 'scale'];

const STYLE_LABELS = {
    'fade': 'Растворение',
    'drop': 'Падение сверху',
    'slide-left': 'Выезд слева',
    'slide-right': 'Выезд справа',
    'scale': 'Масштабирование',
};

const DISPLAY_MODES = ['ghost', 'hidden'];
const DISPLAY_MODE_LABELS = {
    'ghost': 'Призраки',
    'hidden': 'Скрытые',
};

/** Глобальная регэксп-проверка CAD-имён («Твердое тело1») — как в montage. */
const _GENERIC_BODY_RE = /^(?:(?:твердое|твёрдое)\s*тело\s*\d*|тело\s*\d+|деталь\s*\d+|solid\s*body\s*\d*|solid\s*\d+|body\s*\d+|part\s*\d+|component\s*\d+)$/i;

// ============================================================
// СОСТОЯНИЕ ПЛАГИНА
// ============================================================

let _api = null;                 // API модуля 3d-viewer
let _store = null;               // Store приложения
let _projectId = null;
let _fingerprint = '';           // отпечаток состава деталей

// Реестр деталей (аналог montage)
let _parts = [];                 // [{key, shortKey, name, chain, node, meshes:[]}]
let _partByMesh = new Map();     // Mesh -> part
let _coveredMeshes = new Set();
let _partsByAncestorName = new Map(); // имя узла (lowercase) -> Set<part>

let _steps = [];                 // [{name, style|null, parts: [key...]}]
let _currentStepIdx = -1;        // шаг, куда попадают новые клики
let _displayMode = 'ghost';      // 'ghost' | 'hidden' — вид отмеченных в редакторе
let _settings = {
    style: 'fade',               // глобальный стиль появления
    stepDuration: 1.0,           // длительность шага, с
    stepDelay: 0.4,              // пауза между шагами, с
    ghostPreview: true,          // призрак недособранного в плеере
    autoStep: false,             // клик добавляет деталь и сразу создаёт новый шаг
    loop: false,                 // повтор воспроизведения
    speed: 1.0,                  // скорость плеера
};

// Плеер
let _mode = 'edit';              // 'edit' | 'play'
let _playing = false;            // идёт анимация (не на паузе)
let _playIdx = 0;                // текущий шаг воспроизведения
let _playT = 0;                  // время внутри шага, с
let _delayLeft = 0;              // остаток межшаговой паузы, с
let _rafId = null;
let _lastNow = 0;
let _modelSize = null;           // {size: Vector3, box: Box3} модели (для дистанций)
let _timelineDragging = false;

// Undo
let _undoStack = [];

// Слушатели и подписки
let _canvasHandlers = [];
let _windowHandlers = [];
let _unsubscribers = [];
let _specTableEl = null;

// UI
let _toolbarEl = null;
let _panelsContainer = null;
let _panelEl = null;
let _modalEl = null;
let _toastEl = null;
let _toastTimer = null;
let _fileInput = null;

let _stepsAccExpanded = false;   // аккордеон «Шаги последовательности» раскрыт?

// Контекст выбора сборок: последняя выбранная деталь + текущий узел-сборка
// (null в node = уровень самой детали). Сбрасывается новым кликом/rebuild.
let _hier = { part: null, node: null };

let _saveTimer = null;
let _reapplyRAF = null;
let _visibilityGuard = false;    // защита от самопетли на 'model-visibility-changed'

// ============================================================
// УТИЛИТЫ
// ============================================================

function _cleanName(name) {
    return name ? String(name).replace(/:\d+$/, '').trim() : '';
}

function _meshMaterials(mesh) {
    if (!mesh.material) return [];
    return Array.isArray(mesh.material) ? mesh.material.filter(Boolean) : [mesh.material];
}

function _wakeRenderer() {
    // Idle-режим вьювера (1 к/с) — будим цикл, чтобы изменения применялись мгновенно.
    window.dispatchEvent(new Event('viewer-activity'));
}

function _clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function _pad2(n) { return String(n).padStart(2, '0'); }

function _fmtTime(iso) {
    try {
        const d = new Date(iso);
        return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
    } catch { return ''; }
}

/** DJB2-хэш по отсортированному списку ключей — отпечаток модели. */
function _computeFingerprint(keys) {
    const sorted = [...keys].sort();
    let h = 5381;
    const joined = sorted.join('\n');
    for (let i = 0; i < joined.length; i++) {
        h = (((h << 5) + h) + joined.charCodeAt(i)) | 0;
    }
    return 'fp' + (h >>> 0).toString(36) + '-' + sorted.length;
}

function _isGenericBodyName(nm) {
    return _GENERIC_BODY_RE.test(String(nm || '').trim());
}

/** Отображение детали: CAD-имя («Твердое тело1») заменяется обозначением из цепочки предков. */
function _displayPart(p) {
    const name = p.name;
    const chain = p.chain || [];
    if (!_isGenericBodyName(name)) return { name, chain };
    for (let i = chain.length - 2; i >= 0; i--) {
        const cand = chain[i];
        if (cand && !_isGenericBodyName(cand)) {
            return { name: cand, chain: chain.slice(0, i + 1) };
        }
    }
    return { name, chain };
}

function _partName(p) {
    return _displayPart(p).name;
}

// ============================================================
// РЕЕСТР ДЕТАЛЕЙ
// ============================================================

/** Меши узла: спуск через безымянные группы до именованных вложенных деталей/мешей. */
function _collectOwnMeshes(node) {
    const out = [];
    const rec = (obj) => {
        const children = obj.children || [];
        for (const c of children) {
            if (c.isMesh) {
                const nm = _cleanName(c.userData?.name || c.name);
                if (nm) continue;
                out.push(c);
                continue;
            }
            if (c.isLight || c.isCamera || c.type === 'Bone' || c.type === 'Line' ||
                c.type === 'LineSegments' || c.type === 'Points') continue;
            const nm = _cleanName(c.userData?.name || c.name);
            if (nm) continue;
            rec(c);
        }
    };
    rec(node);
    return out;
}

/** Реестр деталей: key = цепочка имён от корня + № экземпляра пути; shortKey = имя#№. */
function _buildRegistry(model) {
    _parts = [];
    _partByMesh = new Map();
    _coveredMeshes = new Set();
    _partsByAncestorName = new Map();
    if (!model) { _fingerprint = ''; return; }

    const pathCounter = new Map();
    const nameCounter = new Map();

    const walk = (obj, chain) => {
        const children = obj.children || [];
        for (const child of children) {
            if (child.isLight || child.isCamera || child.type === 'Bone' ||
                child.type === 'Line' || child.type === 'LineSegments' || child.type === 'Points') continue;
            const name = _cleanName(child.userData?.name || child.name);

            if (child.isMesh) {
                if (!name) continue;
                const ni = nameCounter.get(name) || 0;
                nameCounter.set(name, ni + 1);
                const pathKey = [...chain, name].join('>') + '@mesh';
                const pi = pathCounter.get(pathKey) || 0;
                pathCounter.set(pathKey, pi + 1);
                const meshes = [child, ..._collectOwnMeshes(child)]
                    .filter((m, i, a) => a.indexOf(m) === i);
                _registerPart({
                    key: pathKey + '#' + pi,
                    shortKey: name + '#' + ni,
                    name,
                    chain: [...chain, name],
                    node: child,
                    meshes,
                });
                _linkAncestors(_parts[_parts.length - 1], [...chain, name]);
                continue;
            }

            if (!name) { walk(child, chain); continue; }

            const nextChain = [...chain, name];
            const pathKey = nextChain.join('>');
            const pi = pathCounter.get(pathKey) || 0;
            pathCounter.set(pathKey, pi + 1);

            const ni = nameCounter.get(name) || 0;
            nameCounter.set(name, ni + 1);

            const meshes = _collectOwnMeshes(child);
            if (meshes.length > 0) {
                _registerPart({
                    key: pathKey + '#' + pi,
                    shortKey: name + '#' + ni,
                    name,
                    chain: nextChain,
                    node: child,
                    meshes,
                });
                _linkAncestors(_parts[_parts.length - 1], nextChain);
            }
            walk(child, nextChain);
        }
    };

    walk(model, []);

    // Fallback: меши без единого именованного предка — одна общая «деталь».
    const uncovered = [];
    model.traverse(o => { if (o.isMesh && !_coveredMeshes.has(o.uuid)) uncovered.push(o); });
    if (uncovered.length > 0) {
        _registerPart({
            key: '__ungrouped#0',
            shortKey: '__ungrouped#0',
            name: 'Без имени',
            chain: ['Без имени'],
            node: model,
            meshes: uncovered,
        });
    }

    _fingerprint = _computeFingerprint(_parts.map(p => p.key));
}

function _registerPart(part) {
    _parts.push(part);
    part.meshes.forEach(m => { _partByMesh.set(m, part); _coveredMeshes.add(m.uuid); });
}

function _linkAncestors(part, chainNames) {
    for (const nm of chainNames) {
        const lower = nm.toLowerCase();
        let set = _partsByAncestorName.get(lower);
        if (!set) { set = new Set(); _partsByAncestorName.set(lower, set); }
        set.add(part);
    }
}

function _findPartByMesh(mesh) {
    return _partByMesh.get(mesh) || null;
}

function _findPartByKey(key) {
    return _parts.find(p => p.key === key) || null;
}

function _findPartByShortKey(sk) {
    return _parts.find(p => p.shortKey === sk) || null;
}

function _findPartsByName(name) {
    const lower = String(name).toLowerCase();
    return _parts.filter(p => p.name.toLowerCase() === lower ||
                              _displayPart(p).name.toLowerCase() === lower);
}

/** Детали внутри узла-сборки: индекс цепочек имён либо specification.structure. */
function _findPartsInNode(name) {
    const lower = String(name).toLowerCase();
    const fromRegistry = _partsByAncestorName.get(lower);
    if (fromRegistry && fromRegistry.size) return [...fromRegistry];

    const structure = _store?.getState('specification.structure');
    if (!Array.isArray(structure) || !structure.length) return [];
    const rows = structure.filter(it => String(it?.name || '').toLowerCase() === lower);
    if (!rows.length) return [];
    const found = new Set();
    for (const row of rows) {
        for (const obj of (row.threeObjects || [])) {
            if (!obj || typeof obj.traverse !== 'function') continue;
            obj.traverse(c => {
                if (!c.isMesh) return;
                const part = _partByMesh.get(c);
                if (part) found.add(part);
            });
        }
    }
    return [...found];
}

/** Все детали реестра внутри узла (по мешам под узлом). */
function _partsUnderNode(node) {
    if (!node) return [];
    const set = new Set();
    node.traverse(o => { const p = _partByMesh.get(o); if (p) set.add(p); });
    return [...set];
}

/** Ближайший узел в цепочке предков (или сам узел) с данным именем. */
function _nearestNodeNamed(node, name) {
    const lower = String(name || '').toLowerCase();
    if (!lower) return null;
    for (let o = node; o; o = o.parent) {
        const nm = _cleanName(o.userData?.name || o.name).toLowerCase();
        if (nm && nm === lower) return o;
    }
    return null;
}

/** Сколько экземпляров узлов/деталей с таким именем содержат детали реестра. */
function _countNamedInstances(name) {
    if (!_api?.model) return 0;
    const lower = String(name || '').toLowerCase();
    if (!lower) return 0;
    let n = 0;
    _api.model.traverse(o => {
        if (o === _api.model) return;
        const nm = _cleanName(o.userData?.name || o.name).toLowerCase();
        if (!nm || nm !== lower) return;
        if (_partsUnderNode(o).length > 0) n++;
    });
    return n;
}

// ============================================================
// МАТЕРИАЛЫ: СОХРАНЕНИЕ / ВОССТАНОВЛЕНИЕ / ПРИЗРАК
// ============================================================

function _saveMaterialState(mat) {
    if (!mat.userData || mat.userData._assemblySaved) return;
    mat.userData._assemblySaved = {
        opacity: mat.opacity,
        transparent: mat.transparent,
        depthWrite: mat.depthWrite,
    };
}

function _restoreMaterialState(mat) {
    if (!mat.userData || !mat.userData._assemblySaved) return;
    const s = mat.userData._assemblySaved;
    mat.opacity = s.opacity;
    mat.transparent = s.transparent;
    mat.depthWrite = s.depthWrite;
    delete mat.userData._assemblySaved;
}

/** Прозрачность меша и его рёбер (view-display вешает LineSegments детьми). */
function _setMeshOpacity(mesh, opacity /* null = восстановить */) {
    const apply = (m) => {
        for (const mat of _meshMaterials(m)) {
            if (!mat) continue;
            if (opacity === null) {
                _restoreMaterialState(mat);
            } else {
                _saveMaterialState(mat);
                mat.transparent = true;
                mat.opacity = opacity;
                mat.depthWrite = false;
            }
        }
    };
    apply(mesh);
    for (const child of mesh.children || []) {
        if (!child.isLineSegments) continue;
        apply(child);
    }
}

function _restorePartMaterials(part) {
    for (const mesh of part.meshes) _setMeshOpacity(mesh, null);
}

/** Видимость с учётом того, что рёбра-дети не прячут меш. */
function _setPartVisible(part, visible) {
    for (const mesh of part.meshes) mesh.visible = visible;
}

// ============================================================
// ТРАНСФОРМАЦИИ: ДОМАШНЕЕ СОСТОЯНИЕ И АНИМАЦИОННЫЕ ДАННЫЕ
// ============================================================

/** Домашние трансформации узлов деталей (исходное положение). */
function _captureHomeTransforms() {
    for (const p of _parts) {
        if (!p.node) continue;
        p._home = {
            pos: p.node.position.clone(),
            scale: p.node.scale.clone(),
        };
    }
}

/** Мировые центры деталей и габарит модели — для дистанций анимации. */
function _captureAnimGeometry() {
    if (!_api?.model) return;
    _api.model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(_api.model);
    _modelSize = { size: box.getSize(new THREE.Vector3()), box };

    for (const p of _parts) {
        if (!p.node || !p.node.parent) continue;
        const wb = new THREE.Box3().setFromObject(p.node);
        if (wb.isEmpty()) { p._centerLocal = null; continue; }
        const worldCenter = wb.getCenter(new THREE.Vector3());
        // Центр в системе родителя (анимируем локальные position/scale узла)
        p._centerLocal = p.node.parent.worldToLocal(worldCenter.clone());
    }
}

/** Мировую дельту → локальную дельту родителя (линейная часть обратной матрицы). */
const _invMat = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
function _worldDeltaToLocal(node, worldDelta) {
    if (!node.parent) return worldDelta.clone();
    _invMat.copy(node.parent.matrixWorld).invert();
    _m3.setFromMatrix4(_invMat);
    return worldDelta.clone().applyMatrix3(_m3);
}

/** Кубическое затухание. */
function _ease(t) {
    t = _clamp(t, 0, 1);
    return 1 - Math.pow(1 - t, 3);
}

/** Применить стиль появления к детали на прогрессе e (0..1). */
function _applyStyleAt(part, style, e) {
    const node = part.node;
    if (!node || !part._home) return;

    if (style === 'scale') {
        const k = 0.001 + 0.999 * e;
        node.scale.copy(part._home.scale).multiplyScalar(k);
        if (part._centerLocal) {
            node.position.copy(part._centerLocal)
                .sub(part._home.pos).multiplyScalar(k).negate().add(part._centerLocal);
        }
        _setPartVisible(part, true);
        const opScale = Math.min(1, e * 2);
        for (const mesh of part.meshes) _setMeshOpacity(mesh, opScale);
        return;
    }

    // Стили с перемещением
    let worldDelta = null;
    if (_modelSize) {
        if (style === 'drop') {
            const h = Math.max(_modelSize.size.y * 0.3, 0.5);
            worldDelta = new THREE.Vector3(0, h * (1 - e), 0);
        } else if (style === 'slide-left') {
            const d = Math.max(_modelSize.size.x * 0.45, 0.5);
            worldDelta = new THREE.Vector3(-d * (1 - e), 0, 0);
        } else if (style === 'slide-right') {
            const d = Math.max(_modelSize.size.x * 0.45, 0.5);
            worldDelta = new THREE.Vector3(d * (1 - e), 0, 0);
        }
    }
    if (worldDelta && node.parent) {
        const local = _worldDeltaToLocal(node, worldDelta);
        node.position.copy(part._home.pos).add(local);
    }
    node.scale.copy(part._home.scale);
    _setPartVisible(part, true);
    // Прозрачность: быстро проявляется в начале движения
    const op = Math.min(1, e * 2.5);
    for (const mesh of part.meshes) _setMeshOpacity(mesh, op);
    // fade: позиция уже домашняя — гарантируем это явно
    if (style === 'fade') {
        node.position.copy(part._home.pos);
        node.scale.copy(part._home.scale);
    }
}

/** Вернуть деталь в «установленное» состояние: материалы, видимость, домашняя позиция. */
function _installPart(part) {
    const node = part.node;
    if (node && part._home) {
        node.position.copy(part._home.pos);
        node.scale.copy(part._home.scale);
    }
    _setPartVisible(part, true);
    _restorePartMaterials(part);
}

// ============================================================
// ВИЗУАЛ: РЕДАКТОР
// ============================================================

function _locatePart(key) {
    for (let i = 0; i < _steps.length; i++) {
        if (_steps[i].parts.includes(key)) return i;
    }
    return -1;
}

function _markedCount() {
    let n = 0;
    for (const s of _steps) n += s.parts.length;
    return n;
}

/** Вид отмеченных деталей в редакторе: ghost/hidden; текущий шаг — заметнее. */
function _applyEditVisuals() {
    if (!_api?.model || _mode !== 'edit') return;

    for (const part of _parts) {
        const loc = _locatePart(part.key);
        const marked = loc >= 0;
        if (!marked) {
            _restorePartMaterials(part);
            _setPartVisible(part, true);
            if (part.node && part._home) {
                part.node.position.copy(part._home.pos);
                part.node.scale.copy(part._home.scale);
            }
            continue;
        }
        if (_displayMode === 'hidden') {
            _setPartVisible(part, false);
        } else {
            _setPartVisible(part, true);
            const op = loc === _currentStepIdx ? CUR_GHOST_OPACITY : EDIT_GHOST_OPACITY;
            for (const mesh of part.meshes) _setMeshOpacity(mesh, op);
        }
    }

    _dispatchVisibilityChanged();
    _wakeRenderer();
}

/** Событие для систем, следящих за видимостью модели (2D-аннотации и т.п.). */
function _dispatchVisibilityChanged() {
    if (_visibilityGuard) return;
    _visibilityGuard = true;
    try { window.dispatchEvent(new Event('model-visibility-changed')); }
    finally { _visibilityGuard = false; }
}

// ============================================================
// ВИЗУАЛ: ПЛЕЕР
// ============================================================

/** Состояние сцены на моменте (_playIdx, _playT). */
function _applyPlayState() {
    if (!_api?.model) return;
    const n = _steps.length;

    for (const part of _parts) {
        const loc = _locatePart(part.key);
        if (loc < 0) {
            // Немаркированные — статичный контекст, всегда видны.
            _restorePartMaterials(part);
            _setPartVisible(part, true);
            if (part.node && part._home) {
                part.node.position.copy(part._home.pos);
                part.node.scale.copy(part._home.scale);
            }
            continue;
        }
        if (loc < _playIdx) {
            _installPart(part);
        } else if (loc === _playIdx) {
            const step = _steps[loc];
            const style = step.style || _settings.style;
            const dur = Math.max(0.05, _settings.stepDuration);
            const e = _ease(dur > 0 ? _playT / dur : 1);
            _applyStyleAt(part, style, e);
        } else {
            // Будущие шаги
            if (_settings.ghostPreview) {
                _setPartVisible(part, true);
                for (const mesh of part.meshes) _setMeshOpacity(mesh, PLAY_GHOST_OPACITY);
                if (part.node && part._home) {
                    part.node.position.copy(part._home.pos);
                    part.node.scale.copy(part._home.scale);
                }
            } else {
                _setPartVisible(part, false);
            }
        }
    }
    _wakeRenderer();
}

// ============================================================
// ЦИКЛ ПЛЕЕРА
// ============================================================

function _startPlayLoop() {
    if (_rafId !== null) return;
    _lastNow = performance.now();
    _rafId = requestAnimationFrame(_playTick);
}

function _stopPlayLoop() {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
}

function _playTick(now) {
    _rafId = requestAnimationFrame(_playTick);
    const dt = Math.min((now - _lastNow) / 1000, 0.1);
    _lastNow = now;
    if (!_playing) return;

    const dur = Math.max(0.05, _settings.stepDuration);

    if (_delayLeft > 0) {
        _delayLeft -= dt * _settings.speed;
        if (_delayLeft <= 0) {
            _delayLeft = 0;
            // Повтор: сначала — спрятать всё снова
            if (_playIdx >= _steps.length) {
                _playIdx = 0;
                _playT = 0;
                _applyPlayState();
                _updatePlayerUI();
            }
        }
        return;
    }

    _playT += dt * _settings.speed;

    if (_playT >= dur) {
        // Шаг завершён: зафиксировать детали, перейти к следующему
        if (_steps[_playIdx]) {
            for (const key of _steps[_playIdx].parts) {
                const p = _findPartByKey(key);
                if (p) _installPart(p);
            }
        }
        _playIdx++;
        _playT = 0;
        if (_playIdx >= _steps.length) {
            if (_settings.loop) {
                _delayLeft = Math.max(0, _settings.stepDelay);
            } else {
                _playing = false;
                _applyPlayState();
                _stopPlayLoop();
                _updatePlayerUI();
                _toast('Сборка завершена');
                return;
            }
        } else {
            _delayLeft = Math.max(0, _settings.stepDelay);
        }
    }

    _applyPlayState();
    _updatePlayerUI();
}

// ============================================================
// ПОСЛЕДОВАТЕЛЬНОСТЬ: ЯДРО + UNDO
// ============================================================

function _pushUndo(op) {
    _undoStack.push(op);
    if (_undoStack.length > MAX_UNDO) _undoStack.shift();
}

function _normSteps() {
    if (_steps.length === 0) { _currentStepIdx = -1; return; }
    _currentStepIdx = _clamp(_currentStepIdx, 0, _steps.length - 1);
}

function _newStep({ announce = false, select = true } = {}) {
    _steps.push({ name: '', style: null, parts: [] });
    const idx = _steps.length - 1;
    if (select) _currentStepIdx = idx;
    // Самый первый шаг — раскрыть поднос, чтобы список был виден
    if (_steps.length === 1) _stepsAccExpanded = true;
    _pushUndo({ t: 'newStep', si: idx });
    if (announce) _toast(`Шаг ${idx + 1} создан — добавляйте детали`);
    return idx;
}

/** Удалить шаг: детали становятся неотмеченными. */
function _deleteStep(idx) {
    if (idx < 0 || idx >= _steps.length) return;
    const removed = _steps.splice(idx, 1)[0];
    _pushUndo({ t: 'delStep', si: idx, step: JSON.parse(JSON.stringify(removed)) });
    _normSteps();
}

function _moveStep(from, to) {
    if (from === to || from < 0 || from >= _steps.length) return;
    to = _clamp(to, 0, _steps.length - 1);
    if (from === to) return;
    const [s] = _steps.splice(from, 1);
    _steps.splice(to, 0, s);
    _pushUndo({ t: 'moveStep', from, to });
    _currentStepIdx = to;
}

/** Добавить детали в текущий шаг (или переместить из другого шага). */
function _addPartsToCurrentStep(parts, { announce = true } = {}) {
    if (!parts || !parts.length) return 0;
    if (_mode !== 'edit') return 0;
    if (_steps.length === 0) _newStep({ select: true });
    _normSteps();
    const si = _currentStepIdx;
    const step = _steps[si];
    if (!step) return 0;

    const ops = [];
    let added = 0, moved = 0;
    for (const part of parts) {
        if (!part || !part.key) continue;
        const loc = _locatePart(part.key);
        if (loc === si) continue; // уже в текущем шаге
        if (loc >= 0) {
            // Перемещение из другого шага
            const fromStep = _steps[loc];
            const pi = fromStep.parts.indexOf(part.key);
            fromStep.parts.splice(pi, 1);
            step.parts.push(part.key);
            ops.push({ t: 'move', key: part.key, from: loc, to: si });
            moved++;
        } else {
            step.parts.push(part.key);
            ops.push({ t: 'add', key: part.key, si });
            added++;
        }
    }
    if (ops.length) _pushUndo({ t: 'batch', ops });

    if (_settings.autoStep && added > 0) {
        // Авто-шаг: следующий клик пойдёт в новый шаг
        _steps.push({ name: '', style: null, parts: [] });
        _currentStepIdx = _steps.length - 1;
        _pushUndo({ t: 'newStep', si: _currentStepIdx });
    }

    if (ops.length) {
        _applyEditVisuals();
        _updatePanelUI();
        _updatePillUI();
        _scheduleSave();
    }
    if (announce && (added || moved)) {
        const nm = _partName(parts[0]);
        const cnt = step.parts.length;
        let msg = `Шаг ${si + 1}: +${added || moved}` +
            (added + moved > 1 ? ` дет. (${cnt} в шаге)` : ` · ${nm} (${cnt} в шаге)`);
        if (moved && !added) msg = `Шаг ${si + 1}: перемещено ${moved} · ${nm}`;
        _toast(msg, { actionLabel: 'Отменить', onAction: () => _undo(), timeout: 3200 });
    }
    return added + moved;
}

/** Убрать деталь из последовательности (клик по отмеченной). */
function _removePart(part, { announce = true } = {}) {
    if (_mode !== 'edit') return;
    const loc = _locatePart(part.key);
    if (loc < 0) return;
    const step = _steps[loc];
    const pi = step.parts.indexOf(part.key);
    step.parts.splice(pi, 1);
    _pushUndo({ t: 'remove', key: part.key, si: loc, pi });
    if (announce) _toast(`Шаг ${loc + 1}: −${_partName(part)}`, {
        actionLabel: 'Отменить', onAction: () => _undo(), timeout: 3200,
    });
    _applyEditVisuals();
    _updatePanelUI();
    _scheduleSave();
}

// ============================================================
// ВЫБОР СБОРОК: «СБОРКА ↑» И «ВСЕ ПОДОБНЫЕ»
// ============================================================

/** Запомнить деталь как контекст кнопок «Сборка ↑» / «Все» (уровень — деталь). */
function _setHierPart(part) {
    _hier = part ? { part, node: null } : { part: null, node: null };
    _updatePillUI();
}

/** Расширить выбор до родительской сборки (пилюля, клавиша W).
 * Подъём по дереву до ближайшего предка, добавляющего новые детали
 * (как «выделить родителя» в «Перемещении»). Все детали сборки сразу
 * попадают в текущий шаг. Повторные нажатия поднимаются ещё выше. */
function _selectAssemblyUp() {
    if (_mode !== 'edit') return;
    if (!_hier.part) { _toast('Сначала кликните деталь в 3D или в спецификации'); return; }
    const model = _api?.model;
    const startNode = _hier.node || _hier.part.node;
    if (!startNode || !model) return;

    const curCount = _partsUnderNode(startNode).length;
    let target = startNode.parent;
    let found = null;
    while (target && target !== model) {
        if (_partsUnderNode(target).length > curCount) { found = target; break; }
        target = target.parent;
    }
    if (!found) {
        _toast(_hier.node ? 'Выше — только модель целиком' : 'Деталь уже на верхнем уровне дерева');
        return;
    }

    _hier.node = found;
    const nm = _cleanName(found.userData?.name || found.name) || 'сборка';
    const added = _addPartsToCurrentStep(_partsUnderNode(found), { announce: false });
    if (added > 0) {
        const cnt = _steps[_currentStepIdx]?.parts.length ?? 0;
        _toast(`Сборка «${nm}»: +${added} дет. (${cnt} в шаге)`, {
            actionLabel: 'Отменить', onAction: () => _undo(), timeout: 3600,
        });
    } else {
        _toast(`«${nm}»: детали сборки уже в текущем шаге`);
    }
    _updatePillUI();
}

/** Добавить все такие же сборки/детали в текущий шаг (пилюля, клавиша A).
 * Уровень сборки (после «Сборка ↑» или клика по строке спецификации) —
 * все экземпляры узла с этим именем; уровень детали — все детали
 * с таким же обозначением (как «все одинаковые» в «Монтаже»). */
function _addAllSimilar() {
    if (_mode !== 'edit') return;
    if (!_hier.part) { _toast('Сначала кликните деталь в 3D или в спецификации'); return; }

    let proto = null;      // имя-образец
    let targets = [];      // детали к добавлению
    let instCount = 0;     // сколько всего экземпляров

    if (_hier.node) {
        proto = _cleanName(_hier.node.userData?.name || _hier.node.name);
    }
    if (proto) {
        targets = _findPartsInNode(proto);
        instCount = _countNamedInstances(proto);
    } else {
        proto = _partName(_hier.part);
        targets = _findPartsByName(proto);
        instCount = targets.length;
    }
    if (!proto || !targets.length) {
        _toast(`«${proto || '—'}»: в модели больше таких нет`);
        return;
    }

    const added = _addPartsToCurrentStep(targets, { announce: false });
    if (added > 0) {
        const cnt = _steps[_currentStepIdx]?.parts.length ?? 0;
        _toast(`Все «${proto}» (${instCount} шт): +${added} дет. (${cnt} в шаге)`, {
            actionLabel: 'Отменить', onAction: () => _undo(), timeout: 4000,
        });
    } else {
        _toast(`«${proto}»: всё уже в текущем шаге`);
    }
}

function _undo() {
    const op = _undoStack.pop();
    if (!op) { _toast('Отменять нечего'); return; }
    const ops = op.t === 'batch' ? [...op.ops].reverse() : [op];
    for (const o of ops) {
        switch (o.t) {
            case 'add': {
                const s = _steps[o.si];
                if (s) s.parts = s.parts.filter(k => k !== o.key);
                break;
            }
            case 'remove': {
                const s = _steps[o.si];
                if (s) s.parts.splice(_clamp(o.pi, 0, s.parts.length), 0, o.key);
                break;
            }
            case 'move': {
                const from = _steps[o.from], to = _steps[o.to];
                if (from && to) {
                    const i = to.parts.indexOf(o.key);
                    if (i >= 0) to.parts.splice(i, 1);
                    from.parts.push(o.key);
                }
                break;
            }
            case 'newStep': {
                if (o.si >= 0 && o.si < _steps.length && _steps[o.si].parts.length === 0) {
                    _steps.splice(o.si, 1);
                }
                break;
            }
            case 'delStep': {
                _steps.splice(_clamp(o.si, 0, _steps.length), 0, o.step);
                break;
            }
            case 'moveStep': {
                _moveStepRaw(o.to, o.from);
                break;
            }
            case 'clear': {
                _steps = JSON.parse(JSON.stringify(o.steps));
                _currentStepIdx = o.current;
                break;
            }
        }
    }
    _normSteps();
    _applyEditVisuals();
    _updatePanelUI();
    _updatePillUI();
    _scheduleSave();
}

/** Перестановка шага без записи undo (для обратного хода undo). */
function _moveStepRaw(from, to) {
    if (from === to || from < 0 || from >= _steps.length) return;
    const [s] = _steps.splice(from, 1);
    _steps.splice(_clamp(to, 0, _steps.length), 0, s);
    _normSteps();
}

/** Убрать пустые шаги (без записи undo — вызывается перед плеером/экспортом/сохранением). */
function _pruneEmptySteps() {
    _steps = _steps.filter(s => s.parts.length > 0);
    _normSteps();
}

// ============================================================
// ХРАНЕНИЕ (localStorage)
// ============================================================

function _storageKey() {
    return STORAGE_PREFIX + (_projectId || 'default');
}

function _scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_saveNow, 400);
}

/** Шаги для сохранения: ключи + параллельный список shortKey для ремапа. */
function _stepsForPayload() {
    const steps = _steps.filter(s => s.parts.length > 0).map(s => ({
        name: s.name || '',
        style: s.style || null,
        parts: [...s.parts],
    }));
    const shortSteps = steps.map(s => ({
        name: s.name,
        style: s.style,
        parts: s.parts.map(k => _findPartByKey(k)?.shortKey || k),
    }));
    return { steps, shortSteps };
}

function _saveNow() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    try {
        const { steps, shortSteps } = _stepsForPayload();
        const payload = {
            version: 1,
            displayMode: _displayMode,
            settings: { ..._settings },
            steps,
            shortSteps,
            fingerprint: _fingerprint,
            savedAt: new Date().toISOString(),
        };
        localStorage.setItem(_storageKey(), JSON.stringify(payload));
        _updateSavedLabel();
    } catch (e) {
        console.warn('[Assembly] Ошибка сохранения в localStorage:', e);
    }
}

/** Загрузка: точные ключи → shortKey (модель могла измениться). */
function _loadState() {
    try {
        const raw = localStorage.getItem(_storageKey());
        if (!raw) return;
        const data = JSON.parse(raw);
        const stepsRaw = Array.isArray(data.steps) ? data.steps : [];
        const shortRaw = Array.isArray(data.shortSteps) ? data.shortSteps : [];
        const loaded = [];
        stepsRaw.forEach((s, i) => {
            const parts = [];
            for (let j = 0; j < (s.parts || []).length; j++) {
                let key = s.parts[j];
                if (!_findPartByKey(key)) {
                    const sk = shortRaw[i]?.parts?.[j];
                    const byShort = sk ? _findPartByShortKey(sk) : null;
                    key = byShort ? byShort.key : null;
                }
                if (key && !parts.includes(key)) parts.push(key);
            }
            loaded.push({
                name: typeof s.name === 'string' ? s.name : '',
                style: STYLES.includes(s.style) ? s.style : null,
                parts,
            });
        });
        _steps = loaded;
        _currentStepIdx = _steps.length ? _steps.length - 1 : -1;

        if (DISPLAY_MODES.includes(data.displayMode)) _displayMode = data.displayMode;
        const st = data.settings;
        if (st && typeof st === 'object') {
            if (STYLES.includes(st.style)) _settings.style = st.style;
            if (Number.isFinite(st.stepDuration)) _settings.stepDuration = _clamp(st.stepDuration, 0.3, 3);
            if (Number.isFinite(st.stepDelay)) _settings.stepDelay = _clamp(st.stepDelay, 0, 2);
            if (typeof st.ghostPreview === 'boolean') _settings.ghostPreview = st.ghostPreview;
            if (typeof st.autoStep === 'boolean') _settings.autoStep = st.autoStep;
            if (typeof st.loop === 'boolean') _settings.loop = st.loop;
            if (Number.isFinite(st.speed)) _settings.speed = _clamp(st.speed, 0.25, 3);
        }
    } catch (e) {
        console.warn('[Assembly] Ошибка чтения localStorage:', e);
    }
}

// ============================================================
// РЕЖИМ ПЛЕЕРА: ВХОД / ВЫХОД / УПРАВЛЕНИЕ
// ============================================================

function _enterPlay() {
    if (_mode === 'play' || !_api?.model) return;
    if (_markedCount() === 0) {
        _toast('Последовательность пуста — отметьте детали кликами по модели');
        return;
    }
    _pruneEmptySteps();
    if (!_steps.length) { _toast('Нет шагов для воспроизведения'); return; }

    _closePanel();
    _closeModal();

    // Анимационные данные: домашние трансформации + центры/габариты
    _captureHomeTransforms();
    _captureAnimGeometry();

    _mode = 'play';
    _playIdx = 0;
    _playT = 0;
    _delayLeft = 0;
    _playing = false;
    _applyPlayState();
    _updatePillUI();
    _updatePlayerUI();
}

function _exitPlay() {
    if (_mode !== 'play') return;
    _playing = false;
    _stopPlayLoop();
    _timelineDragging = false;
    _mode = 'edit';
    _applyEditVisuals();
    _updatePillUI();
    _updatePlayerUI();
    _updatePanelUI();
    _scheduleSave();
}

function _togglePlayPause() {
    if (_mode !== 'play') return;
    if (_playing) {
        _playing = false;
        // цикл остаётся живым для скраббинга — не останавливаем rAF
    } else {
        // Если сборка завершена и не в цикле — начать заново
        if (_playIdx >= _steps.length) { _playIdx = 0; _playT = 0; _applyPlayState(); }
        _playing = true;
        _startPlayLoop();
    }
    _updatePlayerUI();
}

function _seek(stepIdx, t) {
    if (_mode !== 'play' || !_steps.length) return;
    _playIdx = _clamp(stepIdx, 0, _steps.length - 1);
    _playT = _clamp(t, 0, Math.max(0.05, _settings.stepDuration));
    _delayLeft = 0;
    _applyPlayState();
    _updatePlayerUI();
}

function _seekPrev() {
    if (_playT > 0.15) { _seek(_playIdx, 0); return; }
    _seek(_playIdx - 1, 0);
}

function _seekNext() {
    _seek(_playIdx + 1, 0);
}

function _resetPlayback() {
    _playing = false;
    _seek(0, 0);
    _updatePlayerUI();
}

/** Селект скоростей плеера. */
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 3];

// ============================================================
// ЭКСПОРТ / ИМПОРТ JSON
// ============================================================

function _exportJSON() {
    if (!_parts.length) { _toast('Модель ещё не загружена'); return; }
    _pruneEmptySteps();
    if (!_steps.length) { _toast('Последовательность пуста — нечего экспортировать'); return; }

    const { steps, shortSteps } = _stepsForPayload();
    const project = _store?.getState('project.data');
    const data = {
        format: 'nbm-assembly',
        version: 1,
        project: { id: _projectId, name: project?.name || '' },
        exportedAt: new Date().toISOString(),
        modelFingerprint: _fingerprint,
        stats: {
            steps: steps.length,
            parts: steps.reduce((n, s) => n + s.parts.length, 0),
            total: _parts.length,
        },
        settings: {
            style: _settings.style,
            stepDuration: _settings.stepDuration,
            stepDelay: _settings.stepDelay,
            ghostPreview: _settings.ghostPreview,
            loop: _settings.loop,
        },
        steps,
        shortSteps,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const d = new Date();
    const stamp = `${d.getFullYear()}${_pad2(d.getMonth() + 1)}${_pad2(d.getDate())}-${_pad2(d.getHours())}${_pad2(d.getMinutes())}`;
    const a = document.createElement('a');
    a.download = `assembly-${_projectId || 'project'}-${stamp}.json`;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);

    _toast(`Экспортировано: ${steps.length} шагов, ${data.stats.parts} деталей`);
    _closePanel();
}

function _ensureFileInput() {
    if (_fileInput) return _fileInput;
    _fileInput = document.createElement('input');
    _fileInput.type = 'file';
    _fileInput.accept = '.json,application/json';
    _fileInput.style.display = 'none';
    _fileInput.addEventListener('change', () => {
        const file = _fileInput.files && _fileInput.files[0];
        _fileInput.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                _showImportDialog(data, file.name);
            } catch (e) {
                console.warn('[Assembly] Некорректный JSON:', e);
                _toast('Файл не является корректным JSON');
            }
        };
        reader.onerror = () => _toast('Не удалось прочитать файл');
        reader.readAsText(file);
    });
    document.body.appendChild(_fileInput);
    return _fileInput;
}

function _startImport() {
    _closePanel();
    _ensureFileInput().click();
}

/** Нормализованные шаги из файла: ключи → shortKey → пропуск ненайденных. */
function _normalizeImportSteps(data) {
    const out = [];
    const stepsRaw = Array.isArray(data.steps) ? data.steps : [];
    const shortRaw = Array.isArray(data.shortSteps) ? data.shortSteps : [];
    stepsRaw.forEach((s, i) => {
        const parts = [];
        for (let j = 0; j < (s.parts || []).length; j++) {
            let key = s.parts[j];
            if (!_findPartByKey(key)) {
                const sk = shortRaw[i]?.parts?.[j];
                const byShort = sk ? _findPartByShortKey(sk) : null;
                key = byShort ? byShort.key : null;
            }
            if (key && !parts.includes(key)) parts.push(key);
        }
        if (parts.length) {
            out.push({
                name: typeof s.name === 'string' ? s.name : '',
                style: STYLES.includes(s.style) ? s.style : null,
                parts,
            });
        }
    });
    return out;
}

function _applyImport(data, mode) {
    if (!data || data.format !== 'nbm-assembly' || !Array.isArray(data.steps)) {
        _toast('Некорректный формат файла последовательности');
        return;
    }
    const incoming = _normalizeImportSteps(data);
    if (!incoming.length) {
        _toast('В файле не найдено ни одной детали текущей модели');
        return;
    }

    if (mode === 'replace') {
        _pushUndo({
            t: 'clear',
            steps: JSON.parse(JSON.stringify(_steps)),
            current: _currentStepIdx,
        });
        _steps = incoming;
        _currentStepIdx = _steps.length ? _steps.length - 1 : -1;
        // Настройки из файла применяются только при полной замене
        const st = data.settings;
        if (st && typeof st === 'object') {
            if (STYLES.includes(st.style)) _settings.style = st.style;
            if (Number.isFinite(st.stepDuration)) _settings.stepDuration = _clamp(st.stepDuration, 0.3, 3);
            if (Number.isFinite(st.stepDelay)) _settings.stepDelay = _clamp(st.stepDelay, 0, 2);
            if (typeof st.ghostPreview === 'boolean') _settings.ghostPreview = st.ghostPreview;
            if (typeof st.loop === 'boolean') _settings.loop = st.loop;
        }
    } else {
        // Объединение: шаги добавляются в конец; undo восстанавливает прежний список
        const snapshot = JSON.parse(JSON.stringify(_steps));
        const snapCur = _currentStepIdx;
        _steps.push(...incoming.map(s => JSON.parse(JSON.stringify(s))));
        _currentStepIdx = _steps.length ? _steps.length - 1 : -1;
        _pushUndo({ t: 'clear', steps: snapshot, current: snapCur });
    }

    _normSteps();
    _applyEditVisuals();
    _updatePanelUI();
    _saveNow();

    const fpDiffers = data.modelFingerprint && data.modelFingerprint !== _fingerprint;
    const totalParts = _steps.reduce((n, s) => n + s.parts.length, 0);
    let msg = `Импорт: ${_steps.length} шагов, ${totalParts} деталей`;
    if (fpDiffers) msg += ' ⚠ модель отличается от экспортированной';
    _toast(msg, { timeout: 4500 });
}

// ============================================================
// UI: ПИЛЮЛЯ-ТУЛБАР
// ============================================================

function _updatePillUI() {
    if (!_toolbarEl) return;
    _toolbarEl.classList.toggle('assembly--playing', _mode === 'play');

    // Редактор: кнопка-глаз отражает режим отображения
    const eyeBtn = _toolbarEl.querySelector('#assembly-eye-btn');
    if (eyeBtn) {
        const use = eyeBtn.querySelector('use');
        const ghost = _displayMode === 'ghost';
        eyeBtn.classList.toggle('assembly-btn--ghost-on', ghost);
        const icon = ghost ? 'montage-eye' : 'eye-closed';
        if (use) use.setAttribute('xlink:href', `assets/icons/sprite.svg#${icon}`);
        const tip = `Отмеченные: ${DISPLAY_MODE_LABELS[_displayMode]} (G)`;
        eyeBtn.dataset.tooltip = tip;
        eyeBtn.title = tip;
    }

    // Undo: активна, когда есть что отменять
    const undoBtn = _toolbarEl.querySelector('#assembly-undo-btn');
    if (undoBtn) undoBtn.disabled = _undoStack.length === 0;

    // «Сборка ↑» и «Все»: активны, когда есть выбранная деталь;
    // «Сборка ↑» подсвечена, пока выбор поднят до уровня сборки
    const hierBtn = _toolbarEl.querySelector('#assembly-hier-btn');
    if (hierBtn) {
        const hasScope = !!_hier.node;
        hierBtn.disabled = !_hier.part;
        hierBtn.classList.toggle('assembly-btn--scope-on', hasScope);
        const tip = hasScope ? 'Расширить до сборки выше (W)' : 'Расширить до сборки (W)';
        hierBtn.title = tip;
        hierBtn.dataset.tooltip = tip;
    }
    const allBtn = _toolbarEl.querySelector('#assembly-all-btn');
    if (allBtn) {
        allBtn.disabled = !_hier.part;
        let tip = 'Все такие же детали/сборки (A)';
        if (_hier.part) {
            const nm = _hier.node
                ? _cleanName(_hier.node.userData?.name || _hier.node.name)
                : _partName(_hier.part);
            if (nm) {
                const cnt = _hier.node ? _countNamedInstances(nm) : _findPartsByName(nm).length;
                if (cnt > 0) tip = `Все «${nm}» — ${cnt} шт (A)`;
            }
        }
        allBtn.title = tip;
        allBtn.dataset.tooltip = tip;
    }
}

function _onEyeClick() {
    _displayMode = _displayMode === 'ghost' ? 'hidden' : 'ghost';
    _scheduleSave();
    _applyEditVisuals();
    _updatePillUI();
    _updatePanelUI();
    _toast(`Отмеченные: ${DISPLAY_MODE_LABELS[_displayMode]}`);
}

function _cycleDisplayMode() { _onEyeClick(); }

// ============================================================
// UI: ПЛЕЕР НА ПИЛЮЛЕ
// ============================================================

function _updatePlayerUI() {
    if (!_toolbarEl) return;

    const playBtn = _toolbarEl.querySelector('#assembly-playpause-btn');
    if (playBtn) {
        const use = playBtn.querySelector('use');
        if (use) use.setAttribute('xlink:href',
            `assets/icons/sprite.svg#${_playing ? 'pause' : 'play'}`);
        playBtn.title = _playing ? 'Пауза (Пробел)' : 'Воспроизвести (Пробел)';
    }

    // Таймлайн: сегменты по шагам, заполнение — прогресс
    const track = _toolbarEl.querySelector('#assembly-tl-track');
    const label = _toolbarEl.querySelector('#assembly-tl-label');
    if (track) {
        const n = _steps.length;
        if (n === 0) {
            track.innerHTML = '<div class="assembly-timeline__seg" style="flex:1"></div>';
        } else {
            const dur = Math.max(0.05, _settings.stepDuration);
            let html = '';
            for (let i = 0; i < n; i++) {
                let fill = 0;
                if (_playIdx >= n || i < _playIdx) fill = 100;
                else if (i === _playIdx) fill = _clamp((_playT / dur) * 100, 0, 100);
                html += `<div class="assembly-timeline__seg${fill >= 100 ? ' assembly-timeline__seg--done' : ''}" style="flex:1">` +
                    `<div class="assembly-timeline__seg-fill" style="width:${fill}%"></div></div>`;
            }
            track.innerHTML = html;
        }
    }
    if (label) {
        label.textContent = _steps.length
            ? `Шаг ${Math.min(_playIdx + 1, _steps.length)}/${_steps.length}`
            : '—';
    }

    const speedSel = _toolbarEl.querySelector('#assembly-speed-sel');
    if (speedSel && parseFloat(speedSel.value) !== _settings.speed) {
        speedSel.value = String(_settings.speed);
    }
}

/** Прогресс по клику/перетаскиванию таймлайна. */
function _timelineSeekFromEvent(e) {
    const track = _toolbarEl?.querySelector('#assembly-tl-track');
    if (!track || !_steps.length) return;
    const rect = track.getBoundingClientRect();
    const frac = _clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 0.9999);
    const idx = Math.floor(frac * _steps.length);
    _seek(idx, 0);
}

function _bindTimeline(el) {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
        if (_mode !== 'play') return;
        _timelineDragging = true;
        el.setPointerCapture?.(e.pointerId);
        _timelineSeekFromEvent(e);
    });
    el.addEventListener('pointermove', (e) => {
        if (!_timelineDragging || _mode !== 'play') return;
        _timelineSeekFromEvent(e);
    });
    const up = () => { _timelineDragging = false; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
}

// ============================================================
// UI: БОЛЬШАЯ ПАНЕЛЬ (ШАГИ И НАСТРОЙКИ)
// ============================================================

const STYLE_SELECT_OPTIONS = () => [
    ['', 'Как в настройках'],
    ...STYLES.map(s => [s, STYLE_LABELS[s]]),
];

function _ensurePanel() {
    if (_panelEl || !_panelsContainer) return _panelEl;

    _panelEl = document.createElement('div');
    _panelEl.className = 'assembly-panel';
    _panelEl.innerHTML = `
        <div class="assembly-panel__header">
            <span class="assembly-panel__title">Анимация сборки</span>
            <button type="button" class="assembly-panel__close" id="assembly-panel-close" aria-label="Закрыть">
                <svg><use xlink:href="assets/icons/sprite.svg#close"></use></svg>
            </button>
        </div>

        <div class="assembly-stats" id="assembly-stats"></div>

        <div class="assembly-accordion" id="assembly-steps-acc">
            <button type="button" class="assembly-accordion__head" aria-expanded="false" aria-controls="assembly-steps-list">
                <span class="assembly-accordion__title">Шаги последовательности</span>
                <span class="assembly-accordion__count" id="assembly-steps-acc-count">0</span>
                <svg class="assembly-accordion__chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </button>
            <div class="assembly-accordion__body">
                <div class="assembly-steps" id="assembly-steps-list"></div>
                <div class="assembly-hint">Кликайте детали в 3D или строки спецификации — они добавляются в текущий (подсвеченный) шаг. Повторный клик по детали убирает её. Кнопки на пилюле: ↑ — расширить выбор до сборки, копии — все такие же сборки/детали. «Новый шаг» и «Отменить» — там же.</div>
            </div>
        </div>

        <div class="assembly-section-title">Анимация</div>
        <div class="assembly-grid2">
            <label class="assembly-field">
                <span>Стиль появления</span>
                <select id="assembly-style-sel"></select>
            </label>
            <label class="assembly-field">
                <span>Повтор</span>
                <select id="assembly-loop-sel">
                    <option value="off">Один раз</option>
                    <option value="on">По кругу</option>
                </select>
            </label>
            <label class="assembly-field">
                <span>Длительность шага <b id="assembly-dur-val">1.0 с</b></span>
                <input type="range" id="assembly-dur" min="0.3" max="3" step="0.1" value="1">
            </label>
            <label class="assembly-field">
                <span>Пауза между шагами <b id="assembly-delay-val">0.4 с</b></span>
                <input type="range" id="assembly-delay" min="0" max="2" step="0.1" value="0.4">
            </label>
        </div>

        <label class="assembly-check">
            <input type="checkbox" id="assembly-ghost-preview">
            <span>Призрак недособранного в плеере</span>
        </label>
        <label class="assembly-check">
            <input type="checkbox" id="assembly-autostep">
            <span>Клик = отдельный шаг (автоматически)</span>
        </label>

        <div class="assembly-section-title">Передача последовательности</div>
        <div class="assembly-actions">
            <button type="button" class="assembly-action" id="assembly-export-btn">
                <svg><use xlink:href="assets/icons/sprite.svg#montage-export"></use></svg>
                <span>Экспорт JSON</span>
            </button>
            <button type="button" class="assembly-action" id="assembly-import-btn">
                <svg><use xlink:href="assets/icons/sprite.svg#montage-import"></use></svg>
                <span>Импорт JSON</span>
            </button>
        </div>

        <div class="assembly-panel__footer">
            <button type="button" class="assembly-reset" id="assembly-reset-btn">Сбросить всё</button>
            <span class="assembly-saved" id="assembly-saved"></span>
        </div>
    `;
    _panelsContainer.appendChild(_panelEl);

    // Делегированные обработчики списка шагов: кнопки ↑/↓/удалить, ввод имени,
    // выбор стиля шага, клик по строке = текущий шаг (биндится один раз, guard внутри)
    _bindStepsList();

    // Селекты стилей
    const styleSel = _panelEl.querySelector('#assembly-style-sel');
    if (styleSel) {
        styleSel.innerHTML = STYLES.map(s =>
            `<option value="${s}">${STYLE_LABELS[s]}</option>`).join('');
        styleSel.addEventListener('change', () => {
            _settings.style = styleSel.value;
            _scheduleSave();
        });
    }

    _panelEl.querySelector('#assembly-panel-close').addEventListener('click', () => {
        _closePanel();
        _updatePillUI();
    });

    // Аккордеон «Шаги последовательности»: клик по шапке — свернуть/развернуть.
    // Состояние живёт в _stepsAccExpanded и aria-expanded (как у «Монтажа»).
    const accHead = _panelEl.querySelector('#assembly-steps-acc .assembly-accordion__head');
    accHead.addEventListener('click', () => {
        _stepsAccExpanded = accHead.getAttribute('aria-expanded') !== 'true';
        accHead.setAttribute('aria-expanded', String(_stepsAccExpanded));
        accHead.closest('.assembly-accordion').classList.toggle('expanded', _stepsAccExpanded);
    });

    _panelEl.querySelector('#assembly-export-btn').addEventListener('click', _exportJSON);
    _panelEl.querySelector('#assembly-import-btn').addEventListener('click', _startImport);

    const gp = _panelEl.querySelector('#assembly-ghost-preview');
    gp.addEventListener('change', () => { _settings.ghostPreview = gp.checked; _scheduleSave(); });
    const as = _panelEl.querySelector('#assembly-autostep');
    as.addEventListener('change', () => { _settings.autoStep = as.checked; _scheduleSave(); });

    const loopSel = _panelEl.querySelector('#assembly-loop-sel');
    loopSel.addEventListener('change', () => {
        _settings.loop = loopSel.value === 'on';
        _scheduleSave();
    });

    const dur = _panelEl.querySelector('#assembly-dur');
    const durVal = _panelEl.querySelector('#assembly-dur-val');
    dur.addEventListener('input', () => {
        _settings.stepDuration = parseFloat(dur.value) || 1;
        durVal.textContent = _settings.stepDuration.toFixed(1) + ' с';
        _scheduleSave();
    });
    const delay = _panelEl.querySelector('#assembly-delay');
    const delayVal = _panelEl.querySelector('#assembly-delay-val');
    delay.addEventListener('input', () => {
        _settings.stepDelay = parseFloat(delay.value) || 0;
        delayVal.textContent = _settings.stepDelay.toFixed(1) + ' с';
        _scheduleSave();
    });

    _panelEl.querySelector('#assembly-reset-btn').addEventListener('click', () => {
        _showConfirmDialog({
            title: 'Сбросить последовательность?',
            body: 'Все шаги и отметки деталей будут удалены. Действие можно отменить кнопкой «Отменить».',
            okLabel: 'Сбросить',
            onOk: () => {
                _pushUndo({
                    t: 'clear',
                    steps: JSON.parse(JSON.stringify(_steps)),
                    current: _currentStepIdx,
                });
                _steps = [];
                _currentStepIdx = -1;
                _applyEditVisuals();
                _updatePanelUI();
                _updatePillUI();
                _saveNow();
                _toast('Последовательность сброшена');
            },
        });
    });

    return _panelEl;
}

/** Короткая подпись стиля шага в списке. */
function _stepStyleLabel(s) {
    return s.style ? STYLE_LABELS[s.style] : '';
}

function _renderStepsList() {
    const list = _panelEl?.querySelector('#assembly-steps-list');
    if (!list) return;
    if (!_steps.length) {
        list.innerHTML = '<div class="assembly-steps__empty">Шагов пока нет — кликните деталь в модели или нажмите «Новый шаг» на пилюле сверху</div>';
        return;
    }
    list.innerHTML = _steps.map((s, i) => {
        const styleOpts = STYLE_SELECT_OPTIONS().map(([v, l]) =>
            `<option value="${v}" ${(s.style || '') === v ? 'selected' : ''}>${l}</option>`).join('');
        return `
            <div class="assembly-step${i === _currentStepIdx ? ' current' : ''}" data-idx="${i}">
                <span class="assembly-step__num">${i + 1}</span>
                <input type="text" class="assembly-step__name" data-idx="${i}"
                       value="${escapeHtml(s.name)}"
                       placeholder="Шаг ${i + 1}" maxlength="60">
                <span class="assembly-step__count">${s.parts.length} дет.</span>
                <select class="assembly-step__style" data-idx="${i}" title="Стиль шага">${styleOpts}</select>
                <button type="button" class="assembly-step__btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Поднять шаг">
                    <svg><use xlink:href="assets/icons/sprite.svg#assembly-up"></use></svg>
                </button>
                <button type="button" class="assembly-step__btn" data-down="${i}" ${i === _steps.length - 1 ? 'disabled' : ''} title="Опустить шаг">
                    <svg><use xlink:href="assets/icons/sprite.svg#assembly-down"></use></svg>
                </button>
                <button type="button" class="assembly-step__btn assembly-step__btn--del" data-del="${i}" title="Удалить шаг">
                    <svg><use xlink:href="assets/icons/sprite.svg#close"></use></svg>
                </button>
            </div>
        `;
    }).join('');
}

function _bindStepsList() {
    const list = _panelEl?.querySelector('#assembly-steps-list');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';

    list.addEventListener('click', (e) => {
        const up = e.target.closest('[data-up]');
        const down = e.target.closest('[data-down]');
        const del = e.target.closest('[data-del]');
        if (up) { _moveStep(Number(up.dataset.up), Number(up.dataset.up) - 1); _afterStepsChange(); return; }
        if (down) { _moveStep(Number(down.dataset.down), Number(down.dataset.down) + 1); _afterStepsChange(); return; }
        if (del) { _deleteStep(Number(del.dataset.del)); _afterStepsChange(); return; }
        const row = e.target.closest('.assembly-step');
        if (row && !e.target.closest('input, select, button')) {
            _currentStepIdx = Number(row.dataset.idx);
            _updatePanelUI();
            _applyEditVisuals(); // подсветка текущего шага меняет прозрачность
        }
    });

    list.addEventListener('input', (e) => {
        if (e.target.classList.contains('assembly-step__name')) {
            const i = Number(e.target.dataset.idx);
            if (_steps[i]) _steps[i].name = e.target.value.slice(0, 60);
            _scheduleSave();
        }
    });

    list.addEventListener('change', (e) => {
        if (e.target.classList.contains('assembly-step__style')) {
            const i = Number(e.target.dataset.idx);
            if (_steps[i]) _steps[i].style = e.target.value || null;
            _scheduleSave();
        }
    });
}

function _afterStepsChange() {
    _updatePanelUI();
    _updatePillUI();
    _applyEditVisuals();
    _scheduleSave();
}

function _updatePanelUI() {
    if (!_panelEl || !_panelEl.classList.contains('visible')) return;

    // Сводка
    const stats = _panelEl.querySelector('#assembly-stats');
    if (stats) {
        const marked = _markedCount();
        stats.innerHTML = `
            <span class="assembly-chip assembly-chip--steps" title="Шагов в последовательности">
                <b>${_steps.length}</b> шагов
            </span>
            <span class="assembly-chip assembly-chip--parts" title="Отмечено деталей">
                <b>${marked}</b> из ${_parts.length}
            </span>
            <span class="assembly-chip assembly-chip--total" title="Текущий шаг">
                ${_steps.length ? 'Шаг ' + (_currentStepIdx + 1) : '—'}
            </span>
        `;
    }

    // Список шагов
    _renderStepsList();

    // Аккордеон шагов: состояние раскрытия + счётчик в шапке
    const acc = _panelEl.querySelector('#assembly-steps-acc');
    if (acc) {
        acc.classList.toggle('expanded', _stepsAccExpanded);
        acc.querySelector('.assembly-accordion__head')?.setAttribute('aria-expanded', String(_stepsAccExpanded));
        const cnt = acc.querySelector('#assembly-steps-acc-count');
        if (cnt) cnt.textContent = String(_steps.length);
    }

    // Чекбоксы/селекты/слайдеры
    const gp = _panelEl.querySelector('#assembly-ghost-preview');
    if (gp && gp.checked !== _settings.ghostPreview) gp.checked = _settings.ghostPreview;
    const as = _panelEl.querySelector('#assembly-autostep');
    if (as && as.checked !== _settings.autoStep) as.checked = _settings.autoStep;
    const styleSel = _panelEl.querySelector('#assembly-style-sel');
    if (styleSel && styleSel.value !== _settings.style) styleSel.value = _settings.style;
    const loopSel = _panelEl.querySelector('#assembly-loop-sel');
    const loopVal = _settings.loop ? 'on' : 'off';
    if (loopSel && loopSel.value !== loopVal) loopSel.value = loopVal;
    const dur = _panelEl.querySelector('#assembly-dur');
    if (dur && parseFloat(dur.value) !== _settings.stepDuration) dur.value = String(_settings.stepDuration);
    const durVal = _panelEl.querySelector('#assembly-dur-val');
    if (durVal) durVal.textContent = _settings.stepDuration.toFixed(1) + ' с';
    const delay = _panelEl.querySelector('#assembly-delay');
    if (delay && parseFloat(delay.value) !== _settings.stepDelay) delay.value = String(_settings.stepDelay);
    const delayVal = _panelEl.querySelector('#assembly-delay-val');
    if (delayVal) delayVal.textContent = _settings.stepDelay.toFixed(1) + ' с';

    _updateSavedLabel();
}

/** Доступная высота панели: не вылезать за верх области модели (в т.ч. на телефоне). */
function _calcPanelMaxH() {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    const containerH = _panelsContainer?.parentElement?.clientHeight || 0;
    const toolbarH = isMobile ? 56 : 64;
    const safeTop = 12;
    let maxH;
    if (isMobile && window.innerHeight > 0) {
        // innerHeight живо реагирует на показ/скрытие адресной строки браузера
        maxH = Math.max(240, window.innerHeight - 148);
        // Когда область модели не на весь экран (таблица спецификации внизу) —
        // не подниматься выше её верхней границы.
        const host = _panelsContainer?.parentElement?.getBoundingClientRect();
        if (host && host.height > 0) {
            const panelBottomY = (_panelsContainer.getBoundingClientRect().bottom || host.bottom) - toolbarH;
            maxH = Math.min(maxH, Math.max(240, panelBottomY - (host.top + toolbarH + safeTop)));
        }
    } else if (containerH > 0) {
        // Панель живёт в .plugin-panels (bottom:64px) над тулбаром (64px) —
        // доступно containerH - 128px минус зазор; пол 150px (панель скроллится внутри).
        maxH = Math.max(150, containerH - 148);
    } else {
        maxH = Math.max(150, window.innerHeight - 160);
    }
    return maxH;
}

function _openPanel() {
    _ensurePanel();
    if (!_panelEl) return;
    _panelEl.style.maxHeight = _calcPanelMaxH() + 'px';
    _panelEl.classList.add('visible');
    _panelEl.scrollTop = 0;
    _updatePanelUI();
}

function _closePanel() {
    if (_panelEl) _panelEl.classList.remove('visible');
}

function _togglePanel() {
    if (_panelEl && _panelEl.classList.contains('visible')) _closePanel();
    else _openPanel();
}

function _updateSavedLabel() {
    const el = _panelEl?.querySelector('#assembly-saved');
    if (!el) return;
    try {
        const raw = localStorage.getItem(_storageKey());
        if (!raw) { el.textContent = ''; return; }
        const data = JSON.parse(raw);
        el.textContent = data.savedAt ? 'Сохранено ' + _fmtTime(data.savedAt) : '';
    } catch { /* noop */ }
}

// ============================================================
// UI: ДИАЛОГИ И ТОСТЫ
// ============================================================

function _closeModal() {
    if (_modalEl) { _modalEl.remove(); _modalEl = null; }
}

function _showDialog({ title, body, buttons }) {
    if (!_panelsContainer) return;
    _closeModal();

    _modalEl = document.createElement('div');
    _modalEl.className = 'assembly-modal';
    _modalEl.innerHTML = `
        <div class="assembly-modal__card">
            <div class="assembly-modal__title">${escapeHtml(title)}</div>
            <div class="assembly-modal__body">${body}</div>
            <div class="assembly-modal__buttons">
                ${buttons.map((b, i) => `
                    <button type="button" class="assembly-modal__btn ${b.kind ? 'assembly-modal__btn--' + b.kind : ''}" data-idx="${i}">
                        ${escapeHtml(b.label)}
                    </button>
                `).join('')}
            </div>
        </div>
    `;
    _modalEl.addEventListener('click', (e) => {
        if (e.target === _modalEl) { _closeModal(); return; }
        const btn = e.target.closest('.assembly-modal__btn');
        if (!btn) return;
        const def = buttons[Number(btn.dataset.idx)];
        if (!def) { _closeModal(); return; }
        let keepOpen = false;
        if (def.onClick) keepOpen = def.onClick(_modalEl) === false;
        if (!keepOpen) _closeModal();
    });
    _panelsContainer.appendChild(_modalEl);
}

function _showConfirmDialog({ title, body, okLabel, onOk }) {
    _showDialog({
        title, body,
        buttons: [
            { label: 'Отмена' },
            { label: okLabel || 'ОК', kind: 'primary', onClick: onOk },
        ],
    });
}

function _showImportDialog(data, fileName) {
    if (!data || data.format !== 'nbm-assembly') {
        _toast('Это не файл последовательности «Сборка» (nbm-assembly)');
        return;
    }
    const steps = Array.isArray(data.steps) ? data.steps : [];
    const partsCount = steps.reduce((n, s) => n + (s.parts?.length || 0), 0);
    const fpDiffers = data.modelFingerprint && data.modelFingerprint !== _fingerprint;
    const projName = data.project?.name ? `«${escapeHtml(data.project.name)}»` : 'без названия';

    const body = `
        <p>Файл: <b>${escapeHtml(fileName)}</b></p>
        <p>Проект: ${projName}</p>
        <p>Шагов: <b>${steps.length}</b>, деталей: <b>${partsCount}</b></p>
        ${fpDiffers
            ? '<p class="assembly-modal__warn">⚠ Модель отличается от той, из которой сделан экспорт. Совпадения будут найдены по обозначениям, часть позиций может не примениться.</p>'
            : ''}
        <p class="assembly-modal__hint">«Объединить» — добавить шаги к текущим. «Заменить» — перезаписать всё (включая настройки анимации).</p>
    `;

    _showDialog({
        title: 'Импорт последовательности сборки',
        body,
        buttons: [
            { label: 'Отмена' },
            { label: 'Объединить', onClick: () => _applyImport(data, 'merge') },
            { label: 'Заменить', kind: 'primary', onClick: () => _applyImport(data, 'replace') },
        ],
    });
}

function _toast(text, { actionLabel = null, onAction = null, timeout = 2600 } = {}) {
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    if (!_toastEl) {
        _toastEl = document.createElement('div');
        _toastEl.className = 'assembly-toast';
        const container = document.getElementById('model-container') || document.body;
        container.appendChild(_toastEl);
    }
    _toastEl.innerHTML = `
        <span class="assembly-toast__text">${escapeHtml(text)}</span>
        ${actionLabel ? `<button type="button" class="assembly-toast__action">${escapeHtml(actionLabel)}</button>` : ''}
    `;
    _toastEl.classList.add('visible');
    if (actionLabel && onAction) {
        const btn = _toastEl.querySelector('.assembly-toast__action');
        btn.addEventListener('click', () => {
            onAction();
            _toastEl.classList.remove('visible');
        });
    }
    _toastTimer = setTimeout(() => {
        _toastEl?.classList.remove('visible');
        _toastTimer = null;
    }, timeout);
}

// ============================================================
// ВЗАИМОДЕЙСТВИЕ С МОДЕЛЬЮ (разметка через raycast)
// ============================================================

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let _pointerDownPos = null;

function _onCanvasPointerDown(e) {
    _pointerDownPos = e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
}

function _onCanvasPointerUp(e) {
    if (!_pointerDownPos || !e.isPrimary) { _pointerDownPos = null; return; }
    const dx = e.clientX - _pointerDownPos.x;
    const dy = e.clientY - _pointerDownPos.y;
    _pointerDownPos = null;
    if (dx * dx + dy * dy > CLICK_MOVE_TOLERANCE) return; // орбита, не клик
    if (_mode !== 'edit') return;                          // в плеере разметка выключена

    if (!_api?.model || !_api?.camera || !_api?.renderer) return;
    const rect = _api.renderer.domElement.getBoundingClientRect();
    _ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1,
             -((e.clientY - rect.top) / rect.height) * 2 + 1);
    _raycaster.setFromCamera(_ndc, _api.camera);

    // Скрытые детали пропускаем (клик сквозь них), включая невидимых предков
    const hit = _raycaster.intersectObject(_api.model, true)
        .find(h => {
            if (!h.object.isMesh) return false;
            for (let o = h.object; o; o = o.parent) { if (o.visible === false) return false; }
            return true;
        });
    if (!hit) return;

    const part = _findPartByMesh(hit.object);
    if (!part) return;
    _setHierPart(part); // контекст для кнопок «Сборка ↑» / «Все»

    const loc = _locatePart(part.key);
    if (loc === _currentStepIdx && loc >= 0) {
        _removePart(part);
    } else {
        _addPartsToCurrentStep([part]);
    }
}

// ============================================================
// ТАБЛИЦА СПЕЦИФИКАЦИИ
// ============================================================

/** Клик по строке спецификации добавляет все детали узла в текущий шаг (capture-фаза, изоляция не запускается). */
function _onSpecTableClick(e) {
    if (PluginManager.isPluginPaused(PLUGIN_ID)) return;
    if (_mode !== 'edit') return;
    const row = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('.part-row') : null;
    if (!row) return;
    const name = row.getAttribute('data-part-name');
    if (!name) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    let targets = _findPartsInNode(name);
    if (!targets.length) targets = _findPartsByName(name);
    if (!targets.length) {
        _toast(`«${name}»: в модели таких деталей не найдено`);
        return;
    }
    const hierFirst = targets[0];
    if (hierFirst) {
        _hier = { part: hierFirst, node: _nearestNodeNamed(hierFirst.node, name) };
        _updatePillUI();
    }
    const added = _addPartsToCurrentStep(targets, { announce: false });
    if (added > 0) {
        _toast(`Шаг ${_currentStepIdx + 1}: «${name}» +${added} дет.`, {
            actionLabel: 'Отменить', onAction: () => _undo(), timeout: 3200,
        });
    } else {
        _toast(`«${name}»: эти детали уже в текущем шаге`);
    }
}

/** После изоляции/сброса изоляции в спецификации — восстановить наш визуал. */
function _onSpecSelectionChanged() {
    if (PluginManager.isPluginPaused(PLUGIN_ID)) return;
    if (_reapplyRAF) cancelAnimationFrame(_reapplyRAF);
    _reapplyRAF = requestAnimationFrame(() => {
        _reapplyRAF = null;
        if (_mode === 'edit') _applyEditVisuals();
        else if (_mode === 'play') _applyPlayState();
    });
}

/** Фоновые плагины (монтаж и т.п.) могут перекрасить/показать модель — возвращаем наш визуал. */
function _onExternalVisibility() {
    if (PluginManager.isPluginPaused(PLUGIN_ID)) return;
    if (_visibilityGuard) return;
    if (_reapplyRAF) cancelAnimationFrame(_reapplyRAF);
    _reapplyRAF = requestAnimationFrame(() => {
        _reapplyRAF = null;
        if (_mode === 'edit') _applyEditVisuals();
        else if (_mode === 'play') _applyPlayState();
    });
}

// ============================================================
// КЛАВИАТУРА
// ============================================================

function _onKeyDown(e) {
    if (PluginManager.isPluginPaused(PLUGIN_ID)) return;
    const tag = e.target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (_mode === 'play') {
        if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            _togglePlayPause();
        } else if (e.code === 'ArrowLeft' && !e.ctrlKey) {
            e.preventDefault();
            _seekPrev();
        } else if (e.code === 'ArrowRight' && !e.ctrlKey) {
            e.preventDefault();
            _seekNext();
        } else if (e.code === 'KeyS' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            _resetPlayback();
        } else if (e.code === 'Escape') {
            e.preventDefault();
            _exitPlay();
        }
        return;
    }

    // Редактор
    if ((e.code === 'KeyZ') && !e.altKey) {
        e.preventDefault();
        _undo();
    } else if (e.code === 'KeyN' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        _newStep({ announce: true, select: true });
        _updatePanelUI();
        _updatePillUI();
        _scheduleSave();
    } else if (e.code === 'KeyG' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        _onEyeClick();
    } else if (e.code === 'KeyW' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        _selectAssemblyUp();
    } else if (e.code === 'KeyA' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        _addAllSimilar();
    } else if (e.code === 'KeyP' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        _enterPlay();
    }
}

// ============================================================
// ЖИЗНЕННЫЙ ЦИКЛ
// ============================================================

function _bind(el, type, handler, opts) {
    el.addEventListener(type, handler, opts);
    _canvasHandlers.push({ el, type, handler, opts });
}

function _rebuild() {
    const model = _store?.getState('model.object') || _api?.model;
    _buildRegistry(model);
    _hier = { part: null, node: null }; // старые объекты реестра недействительны
    _loadState();
    _undoStack = [];
    _captureHomeTransforms();
    _captureAnimGeometry();
    if (_mode === 'play') _exitPlay();
    _applyEditVisuals();
    _updatePanelUI();
    _updatePillUI();
}

function _cleanupListeners() {
    for (const { el, type, handler, opts } of _canvasHandlers) {
        el.removeEventListener(type, handler, opts);
    }
    _canvasHandlers = [];
    for (const { el, type, handler, opts } of _windowHandlers) {
        el.removeEventListener(type, handler, opts);
    }
    _windowHandlers = [];
    for (const unsub of _unsubscribers) {
        try { unsub(); } catch { /* noop */ }
    }
    _unsubscribers = [];
    if (_specTableEl) {
        _specTableEl.removeEventListener('click', _onSpecTableClick, true);
        _specTableEl = null;
    }
}

function _init(api) {
    _api = api;
    _store = api.store;
    _projectId = _store?.getState('project.currentId')
        || document.getElementById('project-data')?.getAttribute('data-project-id')
        || 'default';

    // Canvas: клики-разметка (plugin-system перехватывает и паузит их в фоне)
    const canvas = api.renderer?.domElement;
    if (canvas) {
        _bind(canvas, 'pointerdown', _onCanvasPointerDown, { passive: true });
        _bind(canvas, 'pointerup', _onCanvasPointerUp, { passive: true });
    }

    // Окно: загрузка модели, клавиатура, внешние изменения видимости
    const onModelLoaded = () => _rebuild();
    window.addEventListener('modelLoaded', onModelLoaded);
    _windowHandlers.push({ el: window, type: 'modelLoaded', handler: onModelLoaded });

    window.addEventListener('keydown', _onKeyDown);
    _windowHandlers.push({ el: window, type: 'keydown', handler: _onKeyDown });

    window.addEventListener('model-visibility-changed', _onExternalVisibility);
    _windowHandlers.push({ el: window, type: 'model-visibility-changed', handler: _onExternalVisibility });

    // Resize/orientationchange (мобильные): пересчитать maxHeight открытой панели,
    // когда показ/скрытие URL-бара меняет innerHeight.
    const onResize = () => {
        if (!_panelEl || !_panelEl.classList.contains('visible')) return;
        if (!window.matchMedia('(max-width: 768px)').matches) return;
        if (window.innerHeight <= 0) return;
        _panelEl.style.maxHeight = _calcPanelMaxH() + 'px';
    };
    window.addEventListener('resize', onResize);
    _windowHandlers.push({ el: window, type: 'resize', handler: onResize });
    window.addEventListener('orientationchange', onResize);
    _windowHandlers.push({ el: window, type: 'orientationchange', handler: onResize });
    if (window.visualViewport) {
        const onVvResize = () => onResize();
        window.visualViewport.addEventListener('resize', onVvResize);
        _windowHandlers.push({ el: window.visualViewport, type: 'resize', handler: onVvResize });
    }

    // Store: изоляция детали в спецификации → перекрасить после её изменений
    if (_store) {
        const unsub = _store.subscribe('specification.lastSelectedPart', _onSpecSelectionChanged);
        _unsubscribers.push(unsub);
    }

    // Таблица спецификации: узел-сборка целиком в текущий шаг
    _specTableEl = document.getElementById('specification-body');
    if (_specTableEl) {
        _specTableEl.addEventListener('click', _onSpecTableClick, true);
    }

    // Если модель уже загружена (автозапуск после modelLoaded) — строим сразу
    if (_store?.getState('model.isLoaded')) _rebuild();
}

function _cleanup() {
    if (_reapplyRAF) { cancelAnimationFrame(_reapplyRAF); _reapplyRAF = null; }
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; _saveNow(); }
    _stopPlayLoop();
    _cleanupListeners();
    _closeModal();
    _closePanel();
    if (_panelEl) { _panelEl.remove(); _panelEl = null; }
    if (_toastEl) { _toastEl.remove(); _toastEl = null; }
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
}

function _destroy() {
    _cleanup();
    // Полный откат визуала модели
    if (_mode === 'play') _mode = 'edit';
    _playing = false;
    _restoreAllParts();
    _toolbarEl = null;
    _panelsContainer = null;
    _api = null;
    _store = null;
}

/** Полный откат: материалы/видимость/трансформации к исходным. */
function _restoreAllParts() {
    for (const part of _parts) {
        _restorePartMaterials(part);
        _setPartVisible(part, true);
        if (part.node && part._home) {
            part.node.position.copy(part._home.pos);
            part.node.scale.copy(part._home.scale);
        }
    }
    _dispatchVisibilityChanged();
    _wakeRenderer();
}

// ============================================================
// РЕГИСТРАЦИЯ ПЛАГИНА
// ============================================================

PluginManager.register({
    id: PLUGIN_ID,
    name: 'Сборка',
    icon: 'cubes',

    meta: {
        autoStart: false, // разметка — явное действие пользователя
        description: 'Анимированная последовательность сборки: шаги, плеер, экспорт-импорт JSON',
    },

    condition: (api) => !!(api && api.model && api.scene && api.renderer),

    init(api) {
        _init(api);
        return () => _cleanupListeners();
    },

    destroy() {
        _destroy();
    },

    panel: {
        className: 'plugin-pill assembly-pill',

        html: `
            <div class="assembly-edit-group plugin-pill-group">
                <button type="button" class="plugin-pill-btn" id="assembly-newstep-btn" title="Новый шаг (N)">
                    <svg><use xlink:href="assets/icons/sprite.svg#assembly-plus"></use></svg>
                </button>
                <button type="button" class="plugin-pill-btn" id="assembly-eye-btn" title="Отмеченные: призраки (G)">
                    <svg><use xlink:href="assets/icons/sprite.svg#montage-eye"></use></svg>
                </button>
                <button type="button" class="plugin-pill-btn" id="assembly-undo-btn" title="Отменить (Z)" disabled>
                    <svg><use xlink:href="assets/icons/sprite.svg#arrow-rotate-left"></use></svg>
                </button>
            </div>
            <div class="assembly-edit-group plugin-pill-group">
                <button type="button" class="plugin-pill-btn" id="assembly-hier-btn" title="Расширить до сборки (W)" disabled>
                    <svg><use xlink:href="assets/icons/sprite.svg#assembly-hier-up"></use></svg>
                </button>
                <button type="button" class="plugin-pill-btn" id="assembly-all-btn" title="Все такие же (A)" disabled>
                    <svg><use xlink:href="assets/icons/sprite.svg#montage-copies"></use></svg>
                </button>
            </div>
            <div class="assembly-edit-group plugin-pill-group">
                <button type="button" class="plugin-pill-btn" id="assembly-enterplay-btn" title="Воспроизвести (P)">
                    <svg><use xlink:href="assets/icons/sprite.svg#play"></use></svg>
                </button>
                <button type="button" class="plugin-pill-btn" id="assembly-panel-btn" title="Шаги · настройки · экспорт">
                    <svg><use xlink:href="assets/icons/sprite.svg#montage-sliders"></use></svg>
                </button>
            </div>

            <div class="assembly-play-group plugin-pill-group">
                <button type="button" class="plugin-pill-btn" id="assembly-prev-btn" title="Предыдущий шаг (←)">
                    <svg><use xlink:href="assets/icons/sprite.svg#assembly-step-back"></use></svg>
                </button>
                <button type="button" class="plugin-pill-btn" id="assembly-playpause-btn" title="Воспроизвести (Пробел)">
                    <svg><use xlink:href="assets/icons/sprite.svg#play"></use></svg>
                </button>
                <button type="button" class="plugin-pill-btn" id="assembly-next-btn" title="Следующий шаг (→)">
                    <svg><use xlink:href="assets/icons/sprite.svg#assembly-step-fwd"></use></svg>
                </button>
                <button type="button" class="plugin-pill-btn" id="assembly-reset-btn" title="В начало (S)">
                    <svg><use xlink:href="assets/icons/sprite.svg#stop"></use></svg>
                </button>
            </div>
            <div class="assembly-play-group assembly-play-extra">
                <select id="assembly-speed-sel" class="assembly-speed" title="Скорость"></select>
                <div class="assembly-timeline" id="assembly-timeline" title="Таймлайн: клик или протяните">
                    <div class="assembly-timeline__track" id="assembly-tl-track"></div>
                    <span class="assembly-timeline__label" id="assembly-tl-label">—</span>
                </div>
                <button type="button" class="plugin-pill-btn" id="assembly-exit-btn" title="Выйти из плеера (Esc)">
                    <svg><use xlink:href="assets/icons/sprite.svg#close"></use></svg>
                </button>
            </div>
        `,

        onMount(toolbar) {
            _toolbarEl = toolbar;
            _panelsContainer = toolbar.closest('.plugin-panels') || null;

            // Скорости плеера
            const speedSel = toolbar.querySelector('#assembly-speed-sel');
            if (speedSel) {
                speedSel.innerHTML = SPEED_OPTIONS.map(s =>
                    `<option value="${s}">${s}x</option>`).join('');
                speedSel.value = String(_settings.speed);
                speedSel.addEventListener('change', () => {
                    _settings.speed = parseFloat(speedSel.value) || 1;
                    _scheduleSave();
                });
            }

            // Редактор
            toolbar.querySelector('#assembly-newstep-btn')?.addEventListener('click', () => {
                _newStep({ announce: true, select: true });
                _updatePanelUI();
                _updatePillUI();
                _scheduleSave();
            });
            toolbar.querySelector('#assembly-eye-btn')?.addEventListener('click', _onEyeClick);
            toolbar.querySelector('#assembly-undo-btn')?.addEventListener('click', () => _undo());
            toolbar.querySelector('#assembly-hier-btn')?.addEventListener('click', _selectAssemblyUp);
            toolbar.querySelector('#assembly-all-btn')?.addEventListener('click', _addAllSimilar);
            toolbar.querySelector('#assembly-enterplay-btn')?.addEventListener('click', _enterPlay);
            toolbar.querySelector('#assembly-panel-btn')?.addEventListener('click', _togglePanel);

            // Плеер
            toolbar.querySelector('#assembly-prev-btn')?.addEventListener('click', _seekPrev);
            toolbar.querySelector('#assembly-playpause-btn')?.addEventListener('click', _togglePlayPause);
            toolbar.querySelector('#assembly-next-btn')?.addEventListener('click', _seekNext);
            toolbar.querySelector('#assembly-reset-btn')?.addEventListener('click', _resetPlayback);
            toolbar.querySelector('#assembly-exit-btn')?.addEventListener('click', _exitPlay);
            _bindTimeline(toolbar.querySelector('#assembly-timeline'));

            _updatePillUI();
            _updatePlayerUI();
        },

        // При переключении на другой плагин — выйти из плеера, закрыть панели и вернуть визуал
        onPause() {
            _exitPlay();
            _closePanel();
            _closeModal();
            _restoreAllParts();
        },

        onResume() {
            if (_mode !== 'edit') _mode = 'edit';
            _applyEditVisuals();
        },

        onUnmount() {
            _exitPlay();
            _closePanel();
            _closeModal();
            _toolbarEl = null;
        },
    },
});

// Отладочный хук (не активен в продакшене): localStorage['debug-assembly']='1' или ?debug-assembly=1.
if (localStorage.getItem('debug-assembly') === '1'
    || new URLSearchParams(window.location.search).has('debug-assembly')) {
    window.__assembly = {
        get parts() { return _parts.map(p => ({ key: p.key, shortKey: p.shortKey, name: p.name, displayName: _partName(p) })); },
        get steps() { return JSON.parse(JSON.stringify(_steps)); },
        get settings() { return { ..._settings }; },
        get mode() { return _mode; },
        get displayMode() { return _displayMode; },
        setDisplayMode(m) { _displayMode = m; _applyEditVisuals(); },
        get currentStepIdx() { return _currentStepIdx; },
        setCurrentStep(i) { _currentStepIdx = i; _updatePillUI(); },
        newStep: () => _newStep({ announce: true }),
        addByName(name) {
            const parts = _findPartsByName(name);
            return _addPartsToCurrentStep(parts, { announce: true });
        },
        addNode(name) {
            return _addPartsToCurrentStep(_findPartsInNode(name), { announce: true });
        },
        get scope() {
            if (!_hier.part) return null;
            return {
                key: _hier.part.key,
                level: _hier.node ? 'assembly' : 'part',
                node: _hier.node ? (_cleanName(_hier.node.userData?.name || _hier.node.name) || '(без имени)') : null,
            };
        },
        pick(sk) {
            const p = _findPartByShortKey(sk) || _findPartByKey(sk);
            if (p) _setHierPart(p);
            return p ? p.key : null;
        },
        scopeUp: _selectAssemblyUp,
        addAll: _addAllSimilar,
        enterPlay: _enterPlay,
        exitPlay: _exitPlay,
        play: _togglePlayPause,
        seek: _seek,
        get playIdx() { return _playIdx; },
        get playing() { return _playing; },
        export: _exportJSON,
        applyImport: _applyImport,
        rebuild: _rebuild,
        visuals: _applyEditVisuals,
        applyPlay: _applyPlayState,
        fingerprint: () => _fingerprint,
    };
}
