/**
 * Плагин: Монтаж — визуальный отчёт о ходе монтажа (3D).
 * Кисти «Смонтировано» (зелёный) / «Запланировано» (оранжевый) красят детали
 * по клику; клик по строке спецификации красит все экземпляры обозначения
 * или содержимое узла-сборки. Атрибуты (исполнитель, дата) подставляются из
 * активной кисти. 4 режима отображения; автосохранение в localStorage +
 * экспорт/импорт JSON (формат v2, обратно совместим с v1). При деактивации
 * материалы и видимость модели полностью восстанавливаются.
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';
import { escapeHtml } from '../app.js';

// ============================================================
// КОНСТАНТЫ
// ============================================================

const PLUGIN_ID = 'montage';
const STORAGE_PREFIX = 'pluginMontage:';

const STATUS = {
    NONE: 'none',
    PLANNED: 'planned',
    INSTALLED: 'installed',
};

const STATUS_COLORS = {
    planned: 0xff9500,
    installed: 0x2ecc71,
};

const STATUS_LABELS = {
    planned: 'Запланировано',
    installed: 'Смонтировано',
    none: 'Без статуса',
};

const GHOST_OPACITY = 0.22;
const CLICK_MOVE_TOLERANCE = 25;   // px² — как в 3d-viewer (отличие клика от орбиты)

/** Режимы отображения в порядке цикла кнопки-глаза. */
const DISPLAY_MODES = ['all', 'hide-installed', 'only-installed', 'ghost'];

const DISPLAY_MODE_LABELS = {
    'all': 'Вся модель с цветами статусов',
    'hide-installed': 'Скрыть смонтированные (остаток работ)',
    'only-installed': 'Только смонтированные (готовый этап)',
    'ghost': 'Смонтированные — призраки',
};

// ============================================================
// СОСТОЯНИЕ ПЛАГИНА
// ============================================================

let _api = null;                 // API модуля 3d-viewer
let _store = null;               // Store приложения
let _projectId = null;
let _fingerprint = '';           // отпечаток состава деталей (для импорта)

let _parts = [];                 // [{key, shortKey, name, node, meshes:[]}]
let _partByMesh = new Map();     // Mesh -> part
let _coveredMeshes = new Set();  // uuid мешей, уже занесённых в реестр
let _partsByAncestorName = new Map(); // имя узла-предка (lowercase) -> Set<part>
                                 // — детали, входящие в узел с таким именем
                                 // (узлы-сборки спецификации)

let _statuses = new Map();       // key -> 'planned' | 'installed'
let _meta = new Map();           // key -> {executor: string, date: 'YYYY-MM-DD'} (только у отмеченных)
let _brushExecutor = '';         // исполнитель, подставляемый кистью
let _brushDate = '';             // дата, подставляемая кистью ('YYYY-MM-DD')
let _displayMode = 'all';
let _armedBrush = null;          // null | 'planned' | 'installed' | 'erase'
let _lastPart = null;            // последняя деталь под кистью (для «все одинаковые»)

let _saveTimer = null;
let _reapplyRAF = null;

// Слушатели и подписки
let _canvasHandlers = [];        // [{el, type, handler, opts}]
let _windowHandlers = [];        // [{el, type, handler, opts}]
let _unsubscribers = [];         // функции отписки от store
let _specTableEl = null;

// UI
let _toolbarEl = null;           // пилюля панели плагина
let _panelsContainer = null;     // .plugin-panels (родитель для больших панелей)
let _panelEl = null;             // большая панель (сводка)
let _modalEl = null;             // диалог (импорт / подтверждения)
let _toastEl = null;
let _toastTimer = null;
let _fileInput = null;

// ============================================================
// УТИЛИТЫ
// ============================================================

function _cleanName(name) {
    return name ? String(name).replace(/:\d+$/, '').trim() : '';
}

function _baseColorHex() {
    const s = _store?.getState('ui.settings');
    return (s && s.modelColor) || '#CCCCCC';
}

function _meshMaterials(mesh) {
    if (!mesh.material) return [];
    return Array.isArray(mesh.material) ? mesh.material.filter(Boolean) : [mesh.material];
}

function _wakeRenderer() {
    // В Idle-режиме вьювер рисует 1 к/с — будим цикл, чтобы окраска применилась мгновенно.
    window.dispatchEvent(new Event('viewer-activity'));
}

// ============================================================
// ИСПОЛНИТЕЛИ И ДАТЫ (мета отметок)
// ============================================================

function _pad2(n) { return String(n).padStart(2, '0'); }

function _todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 'ДД.ММ' (текущий год) или 'ДД.ММ.ГГГГ'. */
function _fmtDateShort(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const [y, m, d] = iso.split('-');
    return y === String(new Date().getFullYear()) ? `${d}.${m}` : `${d}.${m}.${y}`;
}

/** Нормализация меты из любого источника (localStorage/импорт/диалог). */
function _normMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const executor = typeof raw.executor === 'string' ? raw.executor.trim().slice(0, 80) : '';
    const date = (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) ? raw.date : '';
    if (!executor && !date) return null;
    return { executor, date };
}

/** Мета существует только у отмеченных деталей. */
function _pruneMeta() {
    for (const k of [..._meta.keys()]) {
        if (!_statuses.has(k)) _meta.delete(k);
    }
}

/** Подставить текущие атрибуты кисти отметке. */
function _stampBrushAttrs(key) {
    const meta = {};
    if (_brushExecutor) meta.executor = _brushExecutor;
    if (_brushDate) meta.date = _brushDate;
    if (meta.executor || meta.date) _meta.set(key, meta);
    else _meta.delete(key);
}

/** « · Иванов 16.09» — суффикс для тостов/подписей по мете детали. */
function _metaSuffix(key) {
    const m = _meta.get(key);
    if (!m) return '';
    let s = '';
    if (m.executor) s += ' · ' + m.executor;
    if (m.date) s += (m.executor ? ' ' : ' · ') + _fmtDateShort(m.date);
    return s;
}

/** Список уникальных имён исполнителей из текущих отметок. */
function _knownExecutors() {
    return [...new Set([..._meta.values()].map(m => m.executor).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'ru'));
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
                if (nm) continue; // именованный меш — сам себе отдельная деталь
                out.push(c);
                continue;
            }
            if (c.isLight || c.isCamera || c.type === 'Bone' || c.type === 'Line' ||
                c.type === 'LineSegments' || c.type === 'Points') continue;
            const nm = _cleanName(c.userData?.name || c.name);
            if (nm) continue; // вложенная именованная деталь — не наша геометрия
            rec(c);
        }
    };
    rec(node);
    return out;
}

/** Реестр деталей: key = цепочка имён от корня + № экземпляра пути; shortKey = имя#№ (для импорта при изменении модели). */
function _buildRegistry(model) {
    _parts = [];
    _partByMesh = new Map();
    _coveredMeshes = new Set();
    _partsByAncestorName = new Map();
    if (!model) return;

    const pathCounter = new Map();
    const nameCounter = new Map();

    const walk = (obj, chain) => {
        const children = obj.children || [];
        for (const child of children) {
            if (child.isLight || child.isCamera || child.type === 'Bone' ||
                child.type === 'Line' || child.type === 'LineSegments' || child.type === 'Points') continue;
            const name = _cleanName(child.userData?.name || child.name);

            // Именованный меш: GLTFLoader кладёт имя на сам THREE.Mesh, а не на Group с дочерним мешем.
            if (child.isMesh) {
                if (!name) continue; // безымянный — геометрия именованного предка
                const ni = nameCounter.get(name) || 0;
                nameCounter.set(name, ni + 1);
                const pathKey = [...chain, name].join('>') + '@mesh';
                const pi = pathCounter.get(pathKey) || 0;
                pathCounter.set(pathKey, pi + 1);
                const meshes = [child, ..._collectOwnMeshes(child)]
                    .filter((m, i, a) => a.indexOf(m) === i);
                const part = {
                    key: pathKey + '#' + pi,
                    shortKey: name + '#' + ni,
                    name,
                    chain: [...chain, name], // именованные предки + само имя
                    node: child,
                    meshes,
                };
                _registerPart(part);
                _linkAncestors(part, [...chain, name]);
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
                const part = {
                    key: pathKey + '#' + pi,
                    shortKey: name + '#' + ni,
                    name,
                    chain: nextChain, // именованные предки + само имя
                    node: child,
                    meshes,
                };
                _registerPart(part);
                _linkAncestors(part, nextChain);
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

/** Связать деталь с именами её именованных предков (для кисти по сборкам). */
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

function _findPartsByName(name) {
    const lower = String(name).toLowerCase();
    // Совпадение и по сырому имени узла, и по отображаемому обозначению:
    // «КТ-02.004» находит тела, экспортированные как «Твердое тело1».
    return _parts.filter(p => p.name.toLowerCase() === lower ||
                              _displayPart(p).name.toLowerCase() === lower);
}

/** Детали внутри узла-сборки: из индекса цепочек имён либо через specification.structure из store. */
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

// ============================================================
// ПРИМЕНЕНИЕ ВИЗУАЛА
// ============================================================

function _saveMaterialState(mat) {
    if (!mat.userData || mat.userData._montageSaved) return;
    mat.userData._montageSaved = {
        opacity: mat.opacity,
        transparent: mat.transparent,
        depthWrite: mat.depthWrite,
    };
}

function _restoreMaterialState(mat) {
    if (!mat.userData || !mat.userData._montageSaved) return;
    const s = mat.userData._montageSaved;
    mat.opacity = s.opacity;
    mat.transparent = s.transparent;
    mat.depthWrite = s.depthWrite;
    delete mat.userData._montageSaved;
}

/**
 * Призрачный режим: растворяем грань И её рёбра (view-display вешает
 * LineSegments-рёбра детьми на меш — у каждого свой материал).
 */
function _setGhost(mesh, on) {
    for (const mat of _meshMaterials(mesh)) {
        if (!mat) continue;
        if (on) {
            _saveMaterialState(mat);
            mat.transparent = true;
            mat.opacity = GHOST_OPACITY;
            mat.depthWrite = false;
        } else {
            _restoreMaterialState(mat);
        }
    }
    for (const child of mesh.children || []) {
        if (!child.isLineSegments) continue;
        for (const mat of _meshMaterials(child)) {
            if (!mat) continue;
            if (on) {
                _saveMaterialState(mat);
                mat.transparent = true;
                mat.opacity = Math.min(1, GHOST_OPACITY * 1.6);
                mat.depthWrite = false;
            } else {
                _restoreMaterialState(mat);
            }
        }
    }
}

/** Окраска и видимость по статусам/режиму; не трогает видимость при активной изоляции детали в спецификации. */
function _applyVisuals() {
    if (!_api?.model) return;
    const baseColor = new THREE.Color(_baseColorHex());
    const isolationActive = !!_store?.getState('specification.lastSelectedPart');
    const controlVisibility = !isolationActive;

    for (const part of _parts) {
        const st = _statuses.get(part.key) || STATUS.NONE;
        const ghost = st === STATUS.INSTALLED && _displayMode === 'ghost';
        for (const mesh of part.meshes) {
            for (const mat of _meshMaterials(mesh)) {
                if (mat.color) {
                    if (st === STATUS.INSTALLED) mat.color.setHex(STATUS_COLORS.installed);
                    else if (st === STATUS.PLANNED) mat.color.setHex(STATUS_COLORS.planned);
                    else mat.color.copy(baseColor);
                }
            }
            _setGhost(mesh, ghost);
            if (controlVisibility) {
                let visible = true;
                if (_displayMode === 'hide-installed' && st === STATUS.INSTALLED) visible = false;
                if (_displayMode === 'only-installed' && st !== STATUS.INSTALLED) visible = false;
                mesh.visible = visible;
            }
        }
    }

    if (controlVisibility) {
        window.dispatchEvent(new Event('model-visibility-changed'));
    }
    _wakeRenderer();
}

/** Полный откат: цвета/прозрачность/видимость к исходным (при выключении плагина). */
function _restoreAll() {
    const baseColor = new THREE.Color(_baseColorHex());
    for (const part of _parts) {
        for (const mesh of part.meshes) {
            for (const mat of _meshMaterials(mesh)) {
                if (mat.color) mat.color.copy(baseColor);
            }
            _setGhost(mesh, false); // снимает и прозрачность рёбер
            mesh.visible = true;
        }
    }
    window.dispatchEvent(new Event('model-visibility-changed'));
    _wakeRenderer();
}

// ============================================================
// СТАТУСЫ: ЯДРО
// ============================================================

function _setPartStatus(part, status) {
    if (!part) return;
    if (status === STATUS.NONE) {
        _statuses.delete(part.key);
        _meta.delete(part.key); // исполнитель/дата живут только при статусе
    } else {
        _statuses.set(part.key, status);
    }
    _scheduleSave();
}

function _paintPart(part, { announce = false } = {}) {
    if (!part || !_armedBrush) return;
    const status = _armedBrush === 'erase' ? STATUS.NONE : _armedBrush;
    _lastPart = part;
    _setPartStatus(part, status);
    if (status !== STATUS.NONE) _stampBrushAttrs(part.key);
    _applyVisuals();
    _updatePanelUI();
    if (announce) {
        const label = status === STATUS.NONE ? 'Статус снят' : STATUS_LABELS[status] + _metaSuffix(part.key);
        _toastPartApplied(part, label, status);
    }
}

/** Красит все экземпляры обозначения (имени детали) либо — при wholeNode —
 * все детали внутри узла с таким именем (клик по строке спецификации:
 * строка может быть узлом-сборкой или «Группа N»). */
function _paintName(name, status, { announce = true, wholeNode = false } = {}) {
    // Спецификация красит содержимое узла целиком (как её собственная
    // изоляция); кисти по известной детали — точное имя обозначения.
    let targets = wholeNode ? _findPartsInNode(name) : [];
    if (!targets.length) targets = _findPartsByName(name);
    if (!targets.length && !wholeNode) targets = _findPartsInNode(name);
    if (!targets.length) {
        if (announce) _toast(`«${name}»: в модели таких деталей не найдено`);
        return false;
    }
    for (const p of targets) {
        _setPartStatus(p, status);
        if (status !== STATUS.NONE) _stampBrushAttrs(p.key);
    }
    _applyVisuals();
    _updatePanelUI();
    if (announce) {
        const label = status === STATUS.NONE ? 'статус снят' : '→ ' + STATUS_LABELS[status] + _metaSuffix(targets[0].key);
        _toast(`«${name}»: ${targets.length} шт ${label}`);
    }
    return true;
}

// ============================================================
// ХРАНЕНИЕ (localStorage)
// ============================================================

function _storageKey() {
    return STORAGE_PREFIX + (_projectId || 'default');
}

function _scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_saveNow, 300);
}

function _saveNow() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    try {
        _pruneMeta();
        const payload = {
            version: 2,
            displayMode: _displayMode,
            statuses: Object.fromEntries(_statuses),
            meta: Object.fromEntries(_meta),
            brush: { executor: _brushExecutor, date: _brushDate },
            fingerprint: _fingerprint,
            savedAt: new Date().toISOString(),
        };
        localStorage.setItem(_storageKey(), JSON.stringify(payload));
        _updateSavedLabel();
    } catch (e) {
        console.warn('[Montage] Ошибка сохранения в localStorage:', e);
    }
}

function _loadState() {
    try {
        const raw = localStorage.getItem(_storageKey());
        if (!raw) return;
        const data = JSON.parse(raw);
        _statuses = new Map();
        if (data.statuses && typeof data.statuses === 'object') {
            for (const [k, v] of Object.entries(data.statuses)) {
                if (v === STATUS.PLANNED || v === STATUS.INSTALLED) _statuses.set(k, v);
            }
        }
        _meta = new Map();
        if (data.meta && typeof data.meta === 'object') {
            for (const [k, m] of Object.entries(data.meta)) {
                const norm = _normMeta(m);
                if (norm && _statuses.has(k)) _meta.set(k, norm);
            }
        }
        if (DISPLAY_MODES.includes(data.displayMode)) _displayMode = data.displayMode;
        // Атрибуты кисти: исполнитель живёт между сеансами, дата — нет
        // (каждый новый сеанс по умолчанию ставит сегодняшнюю дату).
        const brush = data.brush;
        if (brush && typeof brush === 'object' && typeof brush.executor === 'string') {
            _brushExecutor = brush.executor.trim().slice(0, 80);
        }
    } catch (e) {
        console.warn('[Montage] Ошибка чтения localStorage:', e);
    }
}

// ============================================================
// ЭКСПОРТ / ИМПОРТ JSON
// ============================================================

/** Регулярка для CAD-имён по умолчанию («Твердое тело1», «Solid Body1»); заменяются обозначением из цепочки предков. */
const _GENERIC_BODY_RE = /^(?:(?:твердое|твёрдое)\s*тело\s*\d*|тело\s*\d+|деталь\s*\d+|solid\s*body\s*\d*|solid\s*\d+|body\s*\d+|part\s*\d+|component\s*\d+)$/i;

function _isGenericBodyName(nm) {
    return _GENERIC_BODY_RE.test(String(nm || '').trim());
}

/** Отображение детали: { name, chain } — CAD-имя заменено обозначением. */
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

/** Имя детали для интерфейса и отчёта (без CAD-имён вроде «Твердое тело1»). */
function _partName(p) {
    return _displayPart(p).name;
}

/** Подпись строки отчёта: путь от родителя к детали («КТ-00.000>КТ-02.004»), родитель приглушён. */
function _reportLabel(rec) {
    const fp = String(rec.fullPath || rec.name || '');
    const name = String(rec.name || '');
    const cut = name && fp.length > name.length && fp.endsWith(name)
        ? fp.length - name.length - 1 : -1;
    const parentPath = cut > 0 ? fp.slice(0, cut) : '';
    return parentPath
        ? `<span class="montage-list__ctx">${escapeHtml(parentPath)}&gt;</span>${escapeHtml(name)}`
        : escapeHtml(name);
}

/** Строки отчёта «По обозначениям»; одинаковые имена под разными сборками разделяются минимальным суффиксом цепочки предков. */
function _reportRowsByName() {
    const byName = new Map(); // отображаемое имя -> [{part, disp}]
    for (const p of _parts) {
        const disp = _displayPart(p);
        let arr = byName.get(disp.name);
        if (!arr) { arr = []; byName.set(disp.name, arr); }
        arr.push({ part: p, disp });
    }
    const rows = [];
    for (const [name, items] of byName) {
        // Контекст = именованные предки (без самого имени детали)
        const groups = new Map(); // цепочка предков -> {chain, parts}
        for (const it of items) {
            const parentChain = it.disp.chain.slice(0, -1);
            const key = parentChain.join('>');
            let g = groups.get(key);
            if (!g) { g = { chain: parentChain, parts: [] }; groups.set(key, g); }
            g.parts.push(it.part);
        }
        if (groups.size === 1) {
            const g = groups.values().next().value;
            const fullPath = g.chain.length ? g.chain.join('>') + '>' + name : name;
            rows.push({ name, context: '', fullPath, parts: g.parts });
            continue;
        }
        // Минимальный суффикс цепочки, различающий группы
        const groupArr = [...groups.values()];
        const maxLen = Math.max(...groupArr.map(g => g.chain.length));
        let k = 1, ctxKeys = null;
        while (k <= maxLen) {
            const keys = groupArr.map(g => g.chain.slice(-k).join('>'));
            if (new Set(keys).size === groupArr.length) { ctxKeys = keys; break; }
            k++;
        }
        groupArr.forEach((g, i) => {
            const context = ctxKeys ? ctxKeys[i] : g.chain.join('>');
            const fullPath = g.chain.length ? g.chain.join('>') + '>' + name : name;
            rows.push({ name, context, fullPath, parts: g.parts });
        });
    }
    return rows;
}

function _collectStats() {
    let installed = 0, planned = 0;
    const byExec = new Map(); // исполнитель → {executor, installed, planned, lastDate}
    for (const p of _parts) {
        const st = _statuses.get(p.key) || STATUS.NONE;
        if (st === STATUS.INSTALLED) installed++;
        else if (st === STATUS.PLANNED) planned++;
        // Разбивка по исполнителям (без исполнителя — общая строка '')
        if (st !== STATUS.NONE) {
            const m = _meta.get(p.key);
            const ex = m?.executor || '';
            let er = byExec.get(ex);
            if (!er) { er = { executor: ex, installed: 0, planned: 0, lastDate: '' }; byExec.set(ex, er); }
            if (st === STATUS.INSTALLED) er.installed++; else er.planned++;
            if (m?.date && m.date > er.lastDate) er.lastDate = m.date;
        }
    }
    const byNameArr = _reportRowsByName().map(r => {
        let inst = 0, plan = 0;
        for (const p of r.parts) {
            const st = _statuses.get(p.key) || STATUS.NONE;
            if (st === STATUS.INSTALLED) inst++;
            else if (st === STATUS.PLANNED) plan++;
        }
        return { name: r.name, context: r.context, fullPath: r.fullPath, total: r.parts.length, installed: inst, planned: plan };
    }).sort((a, b) => {
        const d = b.installed - a.installed;
        if (d !== 0) return d;
        const n = a.name.localeCompare(b.name, 'ru');
        if (n !== 0) return n;
        return (a.context || '').localeCompare(b.context || '', 'ru');
    });
    const byExecArr = [...byExec.values()].sort((a, b) => {
        const d = b.installed - a.installed;
        return d !== 0 ? d : (a.executor || '').localeCompare(b.executor || '', 'ru');
    });
    return { total: _parts.length, installed, planned, byName: byNameArr, byExecutor: byExecArr };
}

function _exportJSON() {
    if (!_parts.length) { _toast('Модель ещё не загружена'); return; }
    const stats = _collectStats();
    const project = _store?.getState('project.data');
    const shortMap = {};
    const shortMetaMap = {};
    const metaMap = {};
    for (const p of _parts) {
        const st = _statuses.get(p.key);
        if (st) shortMap[p.shortKey] = st;
        const m = _meta.get(p.key);
        if (st && m) { metaMap[p.key] = m; shortMetaMap[p.shortKey] = m; }
    }
    const executors = stats.byExecutor
        .filter(e => e.executor)
        .map(e => ({ name: e.executor, installed: e.installed, planned: e.planned, lastDate: e.lastDate || undefined }));
    const data = {
        format: 'nbm-montage',
        version: 2,
        project: { id: _projectId, name: project?.name || '' },
        exportedAt: new Date().toISOString(),
        modelFingerprint: _fingerprint,
        stats: {
            total: stats.total, installed: stats.installed, planned: stats.planned,
            executors,
        },
        statuses: Object.fromEntries(_statuses),
        meta: metaMap,
        short: shortMap,
        shortMeta: shortMetaMap,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const a = document.createElement('a');
    a.download = `montage-${_projectId || 'project'}-${stamp}.json`;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);

    _toast(`Экспортировано: смонтировано ${stats.installed}, запланировано ${stats.planned}` +
        (executors.length ? `, исполнителей: ${executors.length}` : ''));
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
                console.warn('[Montage] Некорректный JSON:', e);
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

/** Применение импорта: сопоставление точный ключ → короткий (имя#№); файлы v1 (без meta) импортируются без исполнителей. */
function _applyImport(data, mode) {
    if (!data || data.format !== 'nbm-montage' || !data.statuses || typeof data.statuses !== 'object') {
        _toast('Некорректный формат файла отчёта');
        return;
    }
    const incoming = new Map(Object.entries(data.statuses));
    const shortIncoming = (data.short && typeof data.short === 'object') ? data.short : {};
    const metaIncoming = (data.meta && typeof data.meta === 'object') ? new Map(Object.entries(data.meta)) : new Map();
    const shortMetaIncoming = (data.shortMeta && typeof data.shortMeta === 'object') ? data.shortMeta : {};

    const next = mode === 'replace' ? new Map() : new Map(_statuses);
    const nextMeta = mode === 'replace' ? new Map() : new Map(_meta);
    let matched = 0, fallback = 0, skipped = 0, withMeta = 0;

    for (const part of _parts) {
        let st = incoming.get(part.key);
        let metaRaw = metaIncoming.get(part.key);
        if (st !== undefined) matched++;
        else {
            st = shortIncoming[part.shortKey];
            metaRaw = shortMetaIncoming[part.shortKey];
            if (st !== undefined) fallback++;
        }
        if (st === undefined) { if (incoming.has(part.key)) skipped++; continue; }
        if (st === STATUS.PLANNED || st === STATUS.INSTALLED) {
            next.set(part.key, st);
            const m = _normMeta(metaRaw);
            if (m) { nextMeta.set(part.key, m); if (m.executor) withMeta++; }
            else nextMeta.delete(part.key);
        }
        else skipped++;
    }

    _statuses = next;
    _meta = nextMeta;
    _pruneMeta();
    _applyVisuals();
    _updatePanelUI();
    _saveNow();

    const fpDiffers = data.modelFingerprint && data.modelFingerprint !== _fingerprint;
    let msg = `Импорт: применено ${matched + fallback}`;
    if (fallback > 0) msg += ` (по имени: ${fallback})`;
    if (withMeta > 0) msg += `, с исполнителями: ${withMeta}`;
    if (skipped > 0) msg += `, не совпало: ${skipped}`;
    if (fpDiffers) msg += ' ⚠ модель отличается от экспортированной';
    _toast(msg, { timeout: 4500 });
}

// ============================================================
// UI: ПИЛЮЛЯ ПАНЕЛИ
// ============================================================

function _onBrushBtnClick(e) {
    const btn = e.currentTarget;
    const mode = btn.dataset.brush;
    _armedBrush = (_armedBrush === mode) ? null : mode;
    _updatePillUI();
}

function _cycleDisplayMode() {
    const idx = DISPLAY_MODES.indexOf(_displayMode);
    _displayMode = DISPLAY_MODES[(idx + 1) % DISPLAY_MODES.length];
    _scheduleSave();
    _applyVisuals();
    _updatePillUI();
    _updatePanelUI();
    _toast(DISPLAY_MODE_LABELS[_displayMode]);
}

function _updatePillUI() {
    if (!_toolbarEl) return;
    _toolbarEl.querySelectorAll('.montage-btn[data-brush]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.brush === _armedBrush);
        const st = btn.dataset.brush;
        if (st === 'installed') btn.classList.toggle('montage-btn--installed-on', _armedBrush === 'installed');
        if (st === 'planned') btn.classList.toggle('montage-btn--planned-on', _armedBrush === 'planned');
        if (st === 'erase') btn.classList.toggle('montage-btn--erase-on', _armedBrush === 'erase');
    });
    const modeBtn = _toolbarEl.querySelector('#montage-mode-btn');
    if (modeBtn) {
        modeBtn.dataset.tooltip = 'Режим: ' + DISPLAY_MODE_LABELS[_displayMode];
        modeBtn.title = 'Режим: ' + DISPLAY_MODE_LABELS[_displayMode];
    }
}

// ============================================================
// UI: БОЛЬШАЯ ПАНЕЛЬ (СВОДКА)
// ============================================================

function _ensurePanel() {
    if (_panelEl || !_panelsContainer) return _panelEl;

    _panelEl = document.createElement('div');
    _panelEl.className = 'montage-panel';
    _panelEl.innerHTML = `
        <div class="montage-panel__header">
            <span class="montage-panel__title">Монтажный отчёт</span>
            <button type="button" class="montage-panel__close" id="montage-panel-close" aria-label="Закрыть">
                <svg><use xlink:href="assets/icons/sprite.svg#close"></use></svg>
            </button>
        </div>

        <div class="montage-progress">
            <div class="montage-progress__bar"><div class="montage-progress__fill" id="montage-progress-fill"></div></div>
            <div class="montage-progress__label" id="montage-progress-label">—</div>
        </div>

        <div class="montage-chips" id="montage-chips"></div>

        <div class="montage-section-title">Кисть — исполнитель и дата</div>
        <div class="montage-attrs">
            <label class="montage-field">
                <span>Исполнитель</span>
                <input type="text" id="montage-exec-input" list="montage-exec-datalist"
                       placeholder="Фамилия бригады" autocomplete="off" maxlength="80">
                <datalist id="montage-exec-datalist"></datalist>
            </label>
            <label class="montage-field">
                <span>Дата</span>
                <input type="date" id="montage-date-input">
            </label>
        </div>
        <div class="montage-hint">Подставляются к отметкам при окраске кистями</div>

        <div class="montage-section-title">Режим отображения</div>
        <div class="montage-modes" id="montage-modes">
            <button type="button" data-mode="all">Всё</button>
            <button type="button" data-mode="hide-installed">Без смонтированных</button>
            <button type="button" data-mode="only-installed">Только смонтированные</button>
            <button type="button" data-mode="ghost">Призрак</button>
        </div>

        <div class="montage-section-title">Передача отчёта</div>
        <div class="montage-actions">
            <button type="button" class="montage-action" id="montage-export-btn">
                <svg><use xlink:href="assets/icons/sprite.svg#montage-export"></use></svg>
                <span>Экспорт JSON</span>
            </button>
            <button type="button" class="montage-action" id="montage-import-btn">
                <svg><use xlink:href="assets/icons/sprite.svg#montage-import"></use></svg>
                <span>Импорт JSON</span>
            </button>
        </div>
        <div class="montage-actions">
            <button type="button" class="montage-action montage-action--wide" id="montage-same-btn" disabled>
                <svg><use xlink:href="assets/icons/sprite.svg#montage-copies"></use></svg>
                <span id="montage-same-label">Все одинаковые</span>
            </button>
        </div>

        <div class="montage-section-title">По обозначениям</div>
        <div class="montage-list" id="montage-list"></div>

        <div class="montage-section-title" id="montage-exec-section" hidden>По исполнителям</div>
        <div class="montage-list" id="montage-exec-list" hidden></div>

        <div class="montage-panel__footer">
            <button type="button" class="montage-reset" id="montage-reset-btn">Сбросить все статусы</button>
            <span class="montage-saved" id="montage-saved"></span>
        </div>
    `;
    _panelsContainer.appendChild(_panelEl);

    _panelEl.querySelector('#montage-panel-close').addEventListener('click', () => {
        _closePanel();
        _updatePillUI();
    });
    _panelEl.querySelector('#montage-export-btn').addEventListener('click', _exportJSON);
    _panelEl.querySelector('#montage-import-btn').addEventListener('click', _startImport);
    _panelEl.querySelector('#montage-reset-btn').addEventListener('click', () => {
        _showConfirmDialog({
            title: 'Сбросить все статусы?',
            body: 'Все отметки «Смонтировано» и «Запланировано» будут сняты вместе с исполнителями и датами. Действие нельзя отменить.',
            okLabel: 'Сбросить',
            onOk: () => {
                _statuses.clear();
                _meta.clear();
                _applyVisuals();
                _updatePanelUI();
                _saveNow();
                _toast('Все статусы сняты');
            },
        });
    });
    _panelEl.querySelector('#montage-same-btn').addEventListener('click', () => {
        if (!_lastPart) return;
        if (!_armedBrush) { _toast('Сначала выберите кисть статуса'); return; }
        const status = _armedBrush === 'erase' ? STATUS.NONE : _armedBrush;
        _paintName(_lastPart.name, status);
    });
    _panelEl.querySelector('#montage-modes').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        _displayMode = btn.dataset.mode;
        _scheduleSave();
        _applyVisuals();
        _updatePillUI();
        _updatePanelUI();
    });

    // Атрибуты кисти: подставляются к каждой новой отметке
    const execInput = _panelEl.querySelector('#montage-exec-input');
    const dateInput = _panelEl.querySelector('#montage-date-input');
    if (execInput) {
        execInput.value = _brushExecutor;
        execInput.addEventListener('input', () => {
            _brushExecutor = execInput.value.trim().slice(0, 80);
            _scheduleSave();
        });
    }
    if (dateInput) {
        if (!_brushDate) _brushDate = _todayStr();
        dateInput.value = _brushDate;
        dateInput.addEventListener('change', () => {
            _brushDate = /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value) ? dateInput.value : _todayStr();
            dateInput.value = _brushDate;
            _scheduleSave();
        });
    }

    return _panelEl;
}

function _openPanel() {
    _ensurePanel();
    if (!_panelEl) return;
    // Панель внутри .plugin-panels (высота 0) — ограничиваем высоту по 3D-контейнеру, иначе обрезается.
    const containerH = _panelsContainer?.parentElement?.clientHeight || 0;
    if (containerH > 0) {
        _panelEl.style.maxHeight = Math.max(240, containerH - 84) + 'px';
    }
    _panelEl.classList.add('visible');
    _panelEl.scrollTop = 0;
    _updatePanelUI();
}

function _closePanel() {
    if (_panelEl) _panelEl.classList.remove('visible');
}

function _togglePanel() {
    if (_panelEl && _panelEl.classList.contains('visible')) {
        _closePanel();
    } else {
        _openPanel();
    }
}

function _fmtTime(iso) {
    try {
        const d = new Date(iso);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return ''; }
}

function _updateSavedLabel() {
    const el = _panelEl?.querySelector('#montage-saved');
    if (!el) return;
    try {
        const raw = localStorage.getItem(_storageKey());
        if (!raw) { el.textContent = ''; return; }
        const data = JSON.parse(raw);
        el.textContent = data.savedAt ? 'Сохранено ' + _fmtTime(data.savedAt) : '';
    } catch { /* noop */ }
}

function _updatePanelUI() {
    if (!_panelEl || !_panelEl.classList.contains('visible')) return;

    const stats = _collectStats();
    const pct = stats.total > 0 ? Math.round(stats.installed / stats.total * 100) : 0;

    const fill = _panelEl.querySelector('#montage-progress-fill');
    const label = _panelEl.querySelector('#montage-progress-label');
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = `Смонтировано ${stats.installed} из ${stats.total} (${pct}%)`;

    const chips = _panelEl.querySelector('#montage-chips');
    if (chips) {
        chips.innerHTML = `
            <span class="montage-chip montage-chip--installed"><i></i>Смонтировано: <b>${stats.installed}</b></span>
            <span class="montage-chip montage-chip--planned"><i></i>Запланировано: <b>${stats.planned}</b></span>
            <span class="montage-chip"><i></i>Без статуса: <b>${stats.total - stats.installed - stats.planned}</b></span>
        `;
    }

    // Сегменты режимов
    _panelEl.querySelectorAll('#montage-modes button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === _displayMode);
    });

    // Кнопка «все одинаковые»
    const sameBtn = _panelEl.querySelector('#montage-same-btn');
    const sameLabel = _panelEl.querySelector('#montage-same-label');
    if (sameBtn && sameLabel) {
        if (_lastPart) {
            const nm = _partName(_lastPart);
            const cnt = _findPartsByName(nm).length;
            sameBtn.disabled = false;
            sameLabel.textContent = `Все «${nm}» (${cnt} шт)`;
        } else {
            sameBtn.disabled = true;
            sameLabel.textContent = 'Все одинаковые';
        }
    }

    // Список по обозначениям
    const list = _panelEl.querySelector('#montage-list');
    if (list) {
        if (!stats.byName.length) {
            list.innerHTML = '<div class="montage-list__empty">Модель ещё не загружена</div>';
        } else {
            list.innerHTML = stats.byName.map(rec => {
                let dotClass = '';
                if (rec.installed === rec.total) dotClass = 'montage-dot--installed';
                else if (rec.planned === rec.total) dotClass = 'montage-dot--planned';
                else if (rec.installed > 0 || rec.planned > 0) dotClass = 'montage-dot--mixed';
                // Путь от родителя к детали: «КТ-00.000>КТ-02.004»
                const label = _reportLabel(rec);
                const title = rec.fullPath || rec.name;
                return `
                    <div class="montage-list__row">
                        <span class="montage-dot ${dotClass}"></span>
                        <span class="montage-list__name" title="${escapeHtml(title)}">${label}</span>
                        <span class="montage-list__counts">
                            <span class="montage-list__inst">${rec.installed}/${rec.total}</span>
                            ${rec.planned > 0 ? `<span class="montage-list__plan">+${rec.planned} план</span>` : ''}
                        </span>
                    </div>
                `;
            }).join('');
        }
    }

    // Поля кисти — синхронизируем, не затирая ввод с клавиатуры
    const execInput = _panelEl.querySelector('#montage-exec-input');
    if (execInput && document.activeElement !== execInput && execInput.value !== _brushExecutor) {
        execInput.value = _brushExecutor;
    }
    const dateInput = _panelEl.querySelector('#montage-date-input');
    if (dateInput && document.activeElement !== dateInput && dateInput.value !== _brushDate) {
        dateInput.value = _brushDate;
    }

    // Автодополнение исполнителей из текущих отметок
    const datalist = _panelEl.querySelector('#montage-exec-datalist');
    if (datalist) {
        datalist.innerHTML = _knownExecutors()
            .map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
    }

    // Разбивка «По исполнителям»
    const execSection = _panelEl.querySelector('#montage-exec-section');
    const execList = _panelEl.querySelector('#montage-exec-list');
    if (execSection && execList) {
        const marked = stats.installed + stats.planned;
        if (marked === 0) {
            execSection.hidden = true;
            execList.hidden = true;
        } else {
            execSection.hidden = false;
            execList.hidden = false;
            execList.innerHTML = stats.byExecutor.map(er => `
                <div class="montage-list__row">
                    <span class="montage-dot montage-dot--exec"></span>
                    <span class="montage-list__name" title="${escapeHtml(er.executor || 'Исполнитель не указан')}">${escapeHtml(er.executor || 'Без исполнителя')}</span>
                    <span class="montage-list__counts">
                        <span class="montage-list__inst">${er.installed}</span>
                        ${er.planned > 0 ? `<span class="montage-list__plan">+${er.planned} план</span>` : ''}
                        ${er.lastDate ? `<span class="montage-list__date" title="Последняя отметка">${_fmtDateShort(er.lastDate)}</span>` : ''}
                    </span>
                </div>
            `).join('');
        }
    }

    _updateSavedLabel();
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
    _modalEl.className = 'montage-modal';
    _modalEl.innerHTML = `
        <div class="montage-modal__card">
            <div class="montage-modal__title">${escapeHtml(title)}</div>
            <div class="montage-modal__body">${body}</div>
            <div class="montage-modal__buttons">
                ${buttons.map((b, i) => `
                    <button type="button" class="montage-modal__btn ${b.kind ? 'montage-modal__btn--' + b.kind : ''}" data-idx="${i}">
                        ${escapeHtml(b.label)}
                    </button>
                `).join('')}
            </div>
        </div>
    `;
    _modalEl.addEventListener('click', (e) => {
        if (e.target === _modalEl) { _closeModal(); return; }
        const btn = e.target.closest('.montage-modal__btn');
        if (!btn) return;
        const def = buttons[Number(btn.dataset.idx)];
        if (!def) { _closeModal(); return; }
        // onClick получает элемент модалки (можно читать поля формы);
        // возврат false оставляет диалог открытым (для валидации).
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
    if (!data || data.format !== 'nbm-montage') {
        _toast('Это не файл отчёта «Монтаж» (nbm-montage)');
        return;
    }
    const entries = Object.entries(data.statuses || {});
    const inst = entries.filter(([, v]) => v === STATUS.INSTALLED).length;
    const plan = entries.filter(([, v]) => v === STATUS.PLANNED).length;
    const fpDiffers = data.modelFingerprint && data.modelFingerprint !== _fingerprint;
    const projName = data.project?.name ? `«${escapeHtml(data.project.name)}»` : 'без названия';
    const fileExecutors = [...new Set(Object.values(data.meta || {})
        .map(m => (m && typeof m === 'object' ? m.executor : '')).filter(Boolean))];

    const body = `
        <p>Файл: <b>${escapeHtml(fileName)}</b></p>
        <p>Проект: ${projName}</p>
        <p>Позиций: <b class="montage-t--installed">${inst}</b> смонтировано,
           <b class="montage-t--planned">${plan}</b> запланировано</p>
        ${fileExecutors.length
            ? `<p>Исполнители: ${fileExecutors.slice(0, 4).map(escapeHtml).join(', ')}` +
              (fileExecutors.length > 4 ? ` и ещё ${fileExecutors.length - 4}` : '') + '</p>'
            : ''}
        ${fpDiffers
            ? '<p class="montage-modal__warn">⚠ Модель отличается от той, из которой сделан экспорт. Совпадения будут найдены по обозначениям, часть позиций может не примениться.</p>'
            : ''}
        <p class="montage-modal__hint">«Объединить» — добавить к текущим отметкам. «Заменить» — перезаписать всё.</p>
    `;

    _showDialog({
        title: 'Импорт отчёта о монтаже',
        body,
        buttons: [
            { label: 'Отмена' },
            { label: 'Объединить', onClick: () => _applyImport(data, 'merge') },
            { label: 'Заменить', kind: 'primary', onClick: () => _applyImport(data, 'replace') },
        ],
    });
}

/**
 * Тост. С support действия («Все одинаковые»): actionLabel + onAction.
 */
function _toast(text, { actionLabel = null, onAction = null, timeout = 2600 } = {}) {
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    if (!_toastEl) {
        _toastEl = document.createElement('div');
        _toastEl.className = 'montage-toast';
        const container = document.getElementById('model-container') || document.body;
        container.appendChild(_toastEl);
    }
    _toastEl.innerHTML = `
        <span class="montage-toast__text">${escapeHtml(text)}</span>
        ${actionLabel ? `<button type="button" class="montage-toast__action">${escapeHtml(actionLabel)}</button>` : ''}
    `;
    _toastEl.classList.add('visible');
    if (actionLabel && onAction) {
        const btn = _toastEl.querySelector('.montage-toast__action');
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

function _toastPartApplied(part, label, status) {
    const nm = _partName(part);
    const sameCnt = _findPartsByName(nm).length;
    if (sameCnt > 1 && status !== STATUS.NONE) {
        _toast(`«${nm}» — ${label}`, {
            actionLabel: `Все такие же (${sameCnt})`,
            onAction: () => _paintName(nm, status, { announce: false }),
            timeout: 3800,
        });
    } else {
        _toast(`«${nm}» — ${label}`);
    }
}

/**
 * Диалог правки одной детали: статус, исполнитель, дата.
 * Открывается из тоста-инфо (клик по детали без кисти).
 */
function _showEditDialog(part) {
    if (!part || !part.key) return;
    const st = _statuses.get(part.key) || STATUS.NONE;
    const m = _meta.get(part.key) || {};
    const sameCnt = _findPartsByName(_partName(part)).length;
    const knownOptions = _knownExecutors()
        .map(n => `<option value="${escapeHtml(n)}"></option>`).join('');

    const body = `
        <p>Деталь: <b>«${escapeHtml(_partName(part))}»</b>${sameCnt > 1 ? ` · в модели ${sameCnt} шт` : ''}</p>
        <div class="montage-form">
            <div class="montage-form__row" role="radiogroup" aria-label="Статус">
                <label class="montage-radio montage-radio--planned">
                    <input type="radio" name="montage-edit-status" value="planned">
                    <span>Запланировано</span>
                </label>
                <label class="montage-radio montage-radio--installed">
                    <input type="radio" name="montage-edit-status" value="installed">
                    <span>Смонтировано</span>
                </label>
                <label class="montage-radio">
                    <input type="radio" name="montage-edit-status" value="none">
                    <span>Без статуса</span>
                </label>
            </div>
            <label class="montage-field">
                <span>Исполнитель</span>
                <input type="text" id="montage-edit-exec" list="montage-edit-datalist"
                       placeholder="Фамилия бригады" maxlength="80" value="${escapeHtml(m.executor || '')}">
                <datalist id="montage-edit-datalist">${knownOptions}</datalist>
            </label>
            <label class="montage-field">
                <span>Дата</span>
                <input type="date" id="montage-edit-date" value="${escapeHtml(m.date || _todayStr())}">
            </label>
        </div>
        <p class="montage-modal__hint">Применяется к этой детали. Чтобы отметить все одинаковые — выберите кисть и кликните строку в спецификации.</p>
    `;

    _showDialog({
        title: 'Отметка монтажа',
        body,
        buttons: [
            { label: 'Отмена' },
            ...(st !== STATUS.NONE ? [{
                label: 'Снять отметку',
                onClick: () => {
                    _setPartStatus(part, STATUS.NONE);
                    _applyVisuals();
                    _updatePanelUI();
                    _saveNow();
                    _toast(`«${_partName(part)}» — отметка снята`);
                },
            }] : []),
            {
                label: 'Сохранить',
                kind: 'primary',
                onClick: (modalEl) => {
                    if (!modalEl) return;
                    const status = modalEl.querySelector('input[name="montage-edit-status"]:checked')?.value || STATUS.NONE;
                    const executor = (modalEl.querySelector('#montage-edit-exec')?.value || '').trim().slice(0, 80);
                    const dateRaw = modalEl.querySelector('#montage-edit-date')?.value || '';
                    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : '';

                    if (status === STATUS.NONE) {
                        _setPartStatus(part, STATUS.NONE);
                    } else {
                        _statuses.set(part.key, status);
                        const meta = {};
                        if (executor) meta.executor = executor;
                        if (date) meta.date = date;
                        if (meta.executor || meta.date) _meta.set(part.key, meta);
                        else _meta.delete(part.key);
                        _scheduleSave();
                    }
                    _applyVisuals();
                    _updatePanelUI();
                    const label = status === STATUS.NONE
                        ? 'отметка снята'
                        : STATUS_LABELS[status] + _metaSuffix(part.key);
                    _toast(`«${_partName(part)}» — ${label}`);
                },
            },
        ],
    });

    // Отметить текущий статус (после вставки в DOM — только через property)
    const checkedRadio = _modalEl?.querySelector(`input[name="montage-edit-status"][value="${st}"]`);
    if (checkedRadio) checkedRadio.checked = true;
}

// ============================================================
// ВЗАИМОДЕЙСТВИЕ С МОДЕЛЬЮ (кисти через raycast)
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
    if (dx * dx + dy * dy > CLICK_MOVE_TOLERANCE) return; // орбита/панорама, не клик

    if (!_api?.model || !_api?.camera || !_api?.renderer) return;
    const rect = _api.renderer.domElement.getBoundingClientRect();
    _ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1,
             -((e.clientY - rect.top) / rect.height) * 2 + 1);
    _raycaster.setFromCamera(_ndc, _api.camera);
    // visible: скрытые (в режимах отображения/изоляции) детали не ловим —
    // клик проходит сквозь них к видимой геометрии за ними
    const hit = _raycaster.intersectObject(_api.model, true)
        .find(h => h.object.isMesh && h.object.visible);
    if (!hit) return;

    const part = _findPartByMesh(hit.object);
    if (!part) return;

    if (_armedBrush) {
        _paintPart(part, { announce: true });
    } else {
        // Без кисти — карточка детали со статусом/исполнителем/датой
        // и кнопкой «Изменить»; деталь запоминается для «все одинаковые»
        _lastPart = part;
        const st = _statuses.get(part.key) || STATUS.NONE;
        const sameCnt = _findPartsByName(_partName(part)).length;
        _toast(`«${_partName(part)}» · ${STATUS_LABELS[st]}${_metaSuffix(part.key)} · в модели ${sameCnt} шт`, {
            timeout: 3400,
            actionLabel: 'Изменить…',
            onAction: () => _showEditDialog(part),
        });
        _updatePanelUI();
    }
}

// ============================================================
// ТАБЛИЦА СПЕЦИФИКАЦИИ
// ============================================================

/** Клик по строке спецификации с активной кистью красит все экземпляры обозначения (capture-фаза, изоляция не запускается). */
function _onSpecTableClick(e) {
    if (PluginManager.isPluginPaused(PLUGIN_ID)) return;
    if (!_armedBrush) return;
    const row = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('.part-row') : null;
    if (!row) return;
    const name = row.getAttribute('data-part-name');
    if (!name) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const status = _armedBrush === 'erase' ? STATUS.NONE : _armedBrush;
    // Строка может быть узлом-сборкой («Сергей», «Рама-1», «Группа N») —
    // красим всё её содержимое, а не только точное совпадение имени.
    _paintName(name, status, { wholeNode: true });
}

/** После изоляции/сброса изоляции в спецификации — восстановить нашу окраску. */
function _onSpecSelectionChanged() {
    if (_reapplyRAF) cancelAnimationFrame(_reapplyRAF);
    _reapplyRAF = requestAnimationFrame(() => {
        _reapplyRAF = null;
        _applyVisuals();
    });
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
    _loadState();
    _applyVisuals();
    _updatePanelUI();
    _updatePillUI();
}

function _onModelLoaded() {
    _rebuild();
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
    // Новый сеанс — дата кисти по умолчанию сегодняшняя (исполнитель
    // восстанавливается из localStorage в _loadState).
    _brushDate = _todayStr();

    // Canvas: клики-кисти (plugin-system перехватывает и паузит их в фоне)
    const canvas = api.renderer?.domElement;
    if (canvas) {
        _bind(canvas, 'pointerdown', _onCanvasPointerDown, { passive: true });
        _bind(canvas, 'pointerup', _onCanvasPointerUp, { passive: true });
    }

    // Окно: загрузка модели
    const onModelLoaded = () => _onModelLoaded();
    window.addEventListener('modelLoaded', onModelLoaded);
    _windowHandlers.push({ el: window, type: 'modelLoaded', handler: onModelLoaded });

    // Store: изоляция детали в спецификации → перекрасить после её изменений
    if (_store) {
        const unsub = _store.subscribe('specification.lastSelectedPart', _onSpecSelectionChanged);
        _unsubscribers.push(unsub);
    }

    // Таблица спецификации: кисть на все экземпляры обозначения
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
    _cleanupListeners();
    _closeModal();
    _closePanel();
    if (_panelEl) { _panelEl.remove(); _panelEl = null; }
    if (_toastEl) { _toastEl.remove(); _toastEl = null; }
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
}

function _destroy() {
    _cleanup();
    _restoreAll();
    _toolbarEl = null;
    _panelsContainer = null;
    _api = null;
    _store = null;
}

// ============================================================
// РЕГИСТРАЦИЯ ПЛАГИНА
// ============================================================

PluginManager.register({
    id: PLUGIN_ID,
    name: 'Монтаж',
    icon: 'montage-clipboard',
    module: '3d-viewer',

    meta: {
        autoStart: true, // окраска отчёта видна сразу и сохраняется в фоне
        description: 'Визуальный отчёт: смонтировано / запланировано, экспорт-импорт JSON',
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
        className: 'plugin-pill montage-pill',

        html: `
            <div class="montage-brushes plugin-pill-group">
                <button type="button" class="montage-btn plugin-pill-btn" data-brush="installed" title="Кисть: Смонтировано (клик по детали)">
                    <svg><use xlink:href="assets/icons/sprite.svg#montage-check"></use></svg>
                </button>
                <button type="button" class="montage-btn plugin-pill-btn" data-brush="planned" title="Кисть: Запланировано (клик по детали)">
                    <svg><use xlink:href="assets/icons/sprite.svg#montage-clock"></use></svg>
                </button>
                <button type="button" class="montage-btn plugin-pill-btn" data-brush="erase" title="Кисть: снять статус">
                    <svg><use xlink:href="assets/icons/sprite.svg#montage-eraser"></use></svg>
                </button>
            </div>
            <div class="montage-view plugin-pill-group">
                <button type="button" class="montage-btn plugin-pill-btn" id="montage-mode-btn" title="Режим отображения">
                    <svg><use xlink:href="assets/icons/sprite.svg#montage-eye"></use></svg>
                </button>
                <button type="button" class="montage-btn plugin-pill-btn" id="montage-panel-btn" title="Сводка · экспорт/импорт">
                    <svg><use xlink:href="assets/icons/sprite.svg#montage-sliders"></use></svg>
                </button>
            </div>
        `,

        onMount(toolbar) {
            _toolbarEl = toolbar;
            _panelsContainer = toolbar.closest('.plugin-panels') || null;

            toolbar.querySelectorAll('.montage-btn[data-brush]').forEach(btn => {
                btn.addEventListener('click', _onBrushBtnClick);
            });
            toolbar.querySelector('#montage-mode-btn')?.addEventListener('click', _cycleDisplayMode);
            toolbar.querySelector('#montage-panel-btn')?.addEventListener('click', _togglePanel);

            _updatePillUI();
        },

        onUnmount() {
            _closePanel();
            _closeModal();
            _toolbarEl = null;
        },
    },
});

// Отладочный хук (не активен в продакшене): localStorage['debug-montage']='1' или ?debug-montage=1 в адресе.
if (localStorage.getItem('debug-montage') === '1'
    || new URLSearchParams(window.location.search).has('debug-montage')) {
    window.__montage = {
        get parts() { return _parts.map(p => ({ key: p.key, shortKey: p.shortKey, name: p.name, displayName: _partName(p), meshes: p.meshes.length })); },
        labelHtml: rec => _reportLabel(rec),
        get statuses() { return Object.fromEntries(_statuses); },
        get meta() { return Object.fromEntries(_meta); },
        get brush() { return { executor: _brushExecutor, date: _brushDate }; },
        setBrushAttrs(executor, date) {
            _brushExecutor = typeof executor === 'string' ? executor.trim().slice(0, 80) : '';
            _brushDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : _todayStr();
            _scheduleSave();
        },
        get stats() { return _collectStats(); },
        get fingerprint() { return _fingerprint; },
        get displayMode() { return _displayMode; },
        setDisplayMode(m) { _displayMode = m; _applyVisuals(); _updatePillUI(); _updatePanelUI(); },
        setBrush(b) { _armedBrush = b; _updatePillUI(); },
        paintPart(key, status) { _setPartStatus({ key }, status); _applyVisuals(); _updatePanelUI(); _saveNow(); },
        paintName: _paintName,
        editPart(key) { const p = _parts.find(x => x.key === key); if (p) _showEditDialog(p); },
        export: _exportJSON,
        applyImport: _applyImport,
        rebuild: _rebuild,
        visuals: _applyVisuals,
    };
}
