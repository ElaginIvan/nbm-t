/**
 * Приложение 3D Viewer — ядро
 *
 * Содержит:
 * - CSV утилиты (encoding detection, parsing, loading, finding)
 * - Общие утилиты (onReady, withModel, escapeHtml, getProjectId, deepClone)
 * - Store (централизованное хранилище состояния)
 * - DataService (загрузка данных проектов с кэшированием)
 */

// ============================================================
// CSV УТИЛИТЫ
// ============================================================

const ENCODINGS = { UTF8: 'utf-8', WINDOWS1251: 'windows-1251' };

function hasCyrillic(text) {
    return /[а-яА-ЯЁё]/.test(text);
}

function detectEncoding(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return ENCODINGS.UTF8;
    }
    try {
        const utf8Text = new TextDecoder(ENCODINGS.UTF8, { fatal: true }).decode(buffer);
        if (hasCyrillic(utf8Text)) return ENCODINGS.UTF8;
    } catch (e) {
        return ENCODINGS.WINDOWS1251;
    }
    const windows1251Text = new TextDecoder(ENCODINGS.WINDOWS1251).decode(buffer);
    if (hasCyrillic(windows1251Text)) return ENCODINGS.WINDOWS1251;
    return ENCODINGS.UTF8;
}

function decodeCSV(buffer) {
    const encoding = detectEncoding(buffer);
    return new TextDecoder(encoding).decode(buffer);
}

function splitCSVLine(line, delimiter = ';') {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === delimiter && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

function normalizeLineEndings(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseCSV(csvText, delimiter = ';') {
    const normalizedText = normalizeLineEndings(csvText);
    const lines = normalizedText.split('\n');
    if (lines.length === 0) return [];
    let headerLineIndex = 0;
    while (headerLineIndex < lines.length && lines[headerLineIndex].trim() === '') headerLineIndex++;
    if (headerLineIndex >= lines.length) return [];
    const headers = splitCSVLine(lines[headerLineIndex], delimiter).map(h => h.trim());
    const seenDesignations = new Set();
    const result = [];
    for (let i = headerLineIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const values = splitCSVLine(line, delimiter);
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = values[index] !== undefined ? values[index].trim() : '';
        });
        if (obj['Обозначение']) {
            const designation = obj['Обозначение'].trim();
            if (!seenDesignations.has(designation)) {
                seenDesignations.add(designation);
                result.push(obj);
            }
        } else {
            result.push(obj);
        }
    }
    return result;
}

async function loadCSV(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return [];
        const buffer = await response.arrayBuffer();
        const csvText = decodeCSV(buffer);
        return parseCSV(csvText);
    } catch (error) {
        console.error('Error loading CSV data:', error);
        return [];
    }
}

function findInCSV(designation, csvData, options = {}) {
    const { exactMatch = false } = options;
    if (!csvData || csvData.length === 0) return null;
    const cleanDesignation = designation?.trim() || '';
    const exact = csvData.find(item => {
        const csvDesignation = item['Обозначение']?.trim() || '';
        return csvDesignation === cleanDesignation;
    });
    if (exact || exactMatch) return exact;
    const partial = csvData.find(item => {
        const csvDesignation = item['Обозначение']?.trim() || '';
        if (!csvDesignation) return false;
        return csvDesignation.startsWith(cleanDesignation) || cleanDesignation.startsWith(csvDesignation);
    });
    return partial || null;
}

// ============================================================
// ОБЩИЕ УТИЛИТЫ
// ============================================================

/** Хелпер для инициализации по готовности DOM */
function onReady(fn) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fn);
    } else {
        fn();
    }
}

/** Хелпер для traverse-операций над загруженной моделью */
function withModel(callback) {
    if (window.ModelViewer?.isModelLoaded()) {
        const m = window.ModelViewer.getModel();
        if (m) callback(m);
    }
}

/** Экранирует HTML-спецсимволы для безопасной вставки в innerHTML */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getProjectId() {
    const projectData = document.getElementById('project-data');
    if (projectData && projectData.getAttribute('data-project-id')) return projectData.getAttribute('data-project-id');
    const urlParams = new URLSearchParams(window.location.search);
    const projectIdFromUrl = urlParams.get('project');
    if (projectIdFromUrl) return projectIdFromUrl;
    const projectIdFromStorage = localStorage.getItem('selectedProject');
    return projectIdFromStorage || null;
}

// ============================================================
// STORE — Централизованное хранилище состояния
// ============================================================

/** Глубокое клонирование с поддержкой Map, Set, Date */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Map) return new Map(obj);
    if (obj instanceof Set) return new Set(obj);
    if (obj instanceof Date) return new Date(obj);
    if (Array.isArray(obj)) return obj.map(deepClone);

    const cloned = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            cloned[key] = deepClone(obj[key]);
        }
    }
    return cloned;
}

/** Начальное состояние приложения */
const initialState = {
    project: {
        currentId: null,
        data: null,
        isLoading: false,
        error: null
    },
    model: {
        object: null,
        isLoaded: false,
        color: null,
        path: null
    },
    cutting3d: {
        isActive: false,
        activeAxis: null,
        axisValues: { x: 0, y: 0, z: 0 },
        axisBounds: { x: { min: -1, max: 1 }, y: { min: -1, max: 1 }, z: { min: -1, max: 1 } },
        invertedAxes: { x: false, y: false, z: false }
    },
    specification: {
        structure: [],
        csvData: [],
        lastSelectedPart: null,
        isLoading: false
    },
    cutting: {
        materialsData: {},
        isLoading: false,
        settings: { stockLength: 6000, kerf: 0, multiplicity: 1 },
        results: null
    },
    ui: {
        currentView: 'specification',
        currentMode: '3D',
        infoPanelHeight: null,
        isFullscreen: false,
        activeContainer: 'model',
        settings: {
            modelColor: '#CCCCCC',
            modelMetalness: 0.1,
            modelRoughness: 0.75,
            themeMode: 'auto'
        }
    },
    drawing: { currentPart: null }
};

class Store {
    constructor(state) {
        this.state = deepClone(state);
        this.listeners = new Map();
    }

    subscribe(path, callback) {
        if (!this.listeners.has(path)) this.listeners.set(path, []);
        this.listeners.get(path).push(callback);
        return () => {
            const list = this.listeners.get(path);
            const idx = list.indexOf(callback);
            if (idx > -1) list.splice(idx, 1);
        };
    }

    getState(path) {
        if (!path) return this.state;
        return path.split('.').reduce((obj, key) => obj?.[key], this.state);
    }

    setState(path, value, options = {}) {
        const { silent = false, cascade = true } = options;
        const keys = path.split('.');
        const lastKey = keys.pop();

        let current = this.state;
        for (const key of keys) {
            if (!current[key]) current[key] = {};
            current = current[key];
        }

        const oldValue = current[lastKey];
        if (oldValue === value) return;

        current[lastKey] = value;

        if (!silent) {
            this._notify(path, value, oldValue);

            if (cascade) {
                for (let i = keys.length; i > 0; i--) {
                    const parentPath = keys.slice(0, i).join('.');
                    let parentValue = this.state;
                    for (const key of keys.slice(0, i)) {
                        parentValue = parentValue?.[key];
                    }
                    this._notify(parentPath, parentValue);
                }
            }
        }
    }

    _notify(path, newValue, oldValue) {
        (this.listeners.get(path) || []).forEach(cb => {
            try { cb(newValue, oldValue); } catch (e) {
                console.error(`Store listener error for "${path}":`, e);
            }
        });
    }

}

/** Экземпляр хранилища */
export const store = new Store(initialState);

// Восстанавливаем настройки UI из localStorage
const _savedUISettings = localStorage.getItem('uiSettings');
if (_savedUISettings) {
    try {
        const parsed = JSON.parse(_savedUISettings);
        store.setState('ui.settings', { ...store.getState('ui.settings'), ...parsed }, { silent: true });
    } catch (e) {
        console.warn('Failed to parse saved UI settings:', e);
    }
}

// Применяем тему как можно раньше (до рендера)
const _initialTheme = store.getState('ui.settings.themeMode');
if (_initialTheme && _initialTheme !== 'auto') {
    document.documentElement.setAttribute('data-theme', _initialTheme);
}

// ============================================================
// DATA SERVICE — Загрузка данных проектов с кэшированием
// ============================================================

const projectsCache = {
    data: null,
    timestamp: 0,
    ttl: 5 * 60 * 1000
};
let isLoadingProjects = false;
let projectsLoadPromise = null;

export const DataService = {
    async loadProjects() {
        const now = Date.now();
        if (projectsCache.data && (now - projectsCache.timestamp) < projectsCache.ttl) {
            return projectsCache.data;
        }

        if (isLoadingProjects) return projectsLoadPromise;

        isLoadingProjects = true;

        projectsLoadPromise = (async () => {
            try {
                const response = await fetch('projects.json', { cache: 'no-cache' });
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const data = await response.json();
                const projects = data.projects || [];

                projectsCache.data = projects;
                projectsCache.timestamp = now;
                return projects;
            } catch (error) {
                console.error('Error loading projects:', error);
                store.setState('project.error', error.message);
                if (projectsCache.data) return projectsCache.data;
                return [];
            } finally {
                isLoadingProjects = false;
                projectsLoadPromise = null;
            }
        })();

        return projectsLoadPromise;
    },

    async loadProjectData(projectId) {
        try {
            const projects = await this.loadProjects();
            if (!projectId) return projects[0] || null;

            const project = projects.find(p => p.id === projectId);
            if (!project) {
                console.warn(`Project "${projectId}" not found, using first project`);
                return projects[0] || null;
            }

            store.setState('project.data', project);
            store.setState('project.currentId', projectId);
            return project;
        } catch (error) {
            console.error('Error loading project data:', error);
            store.setState('project.error', error.message);
            return null;
        }
    },

    setSelectedProject(projectId) {
        localStorage.setItem('selectedProject', projectId);
        store.setState('project.currentId', projectId);
    },

    getSelectedProject() {
        return store.getState('project.currentId') || localStorage.getItem('selectedProject');
    },

    clearCache() {
        projectsCache.data = null;
        projectsCache.timestamp = 0;
    },

    isProjectsLoaded() {
        return projectsCache.data !== null;
    },

    getCachedProject(projectId) {
        if (!projectsCache.data) return null;
        return projectsCache.data.find(p => p.id === projectId);
    }
};

// ============================================================
// ЭКСПОРТ
// ============================================================

export { withModel, onReady, getProjectId, escapeHtml, deepClone, loadCSV, findInCSV, parseCSV, decodeCSV, ENCODINGS };