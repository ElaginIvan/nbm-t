/**
 * Централизованное хранилище состояния приложения
 * Использует паттерн Observer для подписки на изменения
 */

const STATE_VERSION = '1.0.0';

/**
 * Глубокое клонирование с поддержкой Map, Set, Date
 * @param {*} obj - Объект для клонирования
 * @returns {*} Клонированный объект
 */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    
    if (obj instanceof Map) {
        return new Map(obj);
    }
    
    if (obj instanceof Set) {
        return new Set(obj);
    }
    
    if (obj instanceof Date) {
        return new Date(obj);
    }
    
    if (Array.isArray(obj)) {
        return obj.map(deepClone);
    }
    
    const cloned = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            cloned[key] = deepClone(obj[key]);
        }
    }
    return cloned;
}

// Начальное состояние приложения
const initialState = {
    // Данные проекта
    project: {
        currentId: null,
        data: null,
        isLoading: false,
        error: null
    },

    // 3D модель
    model: {
        object: null,
        isLoaded: false,
        color: null,
        path: null
    },

    // Сечения модели (cutting)
    cutting3d: {
        isActive: false,
        activeAxis: null,
        axisValues: { x: 0, y: 0, z: 0 },
        axisBounds: { x: { min: -1, max: 1 }, y: { min: -1, max: 1 }, z: { min: -1, max: 1 } },
        invertedAxes: { x: false, y: false, z: false }
    },

    // Спецификация
    specification: {
        structure: [],
        csvData: [],
        lastSelectedPart: null,
        isLoading: false
    },

    // Данные для раскроя
    cutting: {
        materialsData: {},
        isLoading: false,
        settings: {
            stockLength: 6000,
            kerf: 0,
            multiplicity: 1
        },
        results: null
    },

    // UI состояние
    ui: {
        currentView: 'specification', // 'specification' | 'cutting'
        currentMode: '3D', // '3D' | '2D'
        infoPanelHeight: null,
        isFullscreen: false,
        activeContainer: 'model' // 'model' | 'drawing'
    },

    // 2D чертежи
    drawing: {
        currentPart: null,
        images: new Map(),
        isLoading: false
    }
};

class Store {
    constructor(initialState) {
        this.state = deepClone(initialState);
        this.listeners = new Map();
        this.middlewares = [];
    }

    /**
     * Подписка на изменения конкретного пути в состоянии
     * @param {string} path - Путь к состоянию (напр. 'model.isLoaded')
     * @param {function} callback - Функция обратного вызова (newValue, oldValue) => void
     * @returns {function} Функция для отписки
     */
    subscribe(path, callback) {
        if (!this.listeners.has(path)) {
            this.listeners.set(path, []);
        }
        this.listeners.get(path).push(callback);

        // Возвращаем функцию отписки
        return () => {
            const listeners = this.listeners.get(path);
            const index = listeners.indexOf(callback);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        };
    }

    /**
     * Получение значения по пути
     * @param {string} path - Путь к состоянию
     * @returns {*} Значение
     */
    getState(path) {
        if (!path) return this.state;
        
        return path.split('.').reduce((obj, key) => {
            return obj?.[key];
        }, this.state);
    }

    /**
     * Обновление состояния
     * @param {string} path - Путь к состоянию
     * @param {*} value - Новое значение
     * @param {Object|boolean} options - Опции или silent (для обратной совместимости)
     * @param {boolean} options.silent - Не уведомлять подписчиков
     * @param {boolean} options.cascade - Уведомлять подписчиков родительских путей
     */
    setState(path, value, options = {}) {
        // Обратная совместимость: если передан boolean, считаем его silent
        if (typeof options === 'boolean') {
            options = { silent: options, cascade: true };
        }
        
        const { silent = false, cascade = true } = options;

        const keys = path.split('.');
        const lastKey = keys.pop();

        // Находим родительский объект (прямой доступ вместо getState)
        let current = this.state;
        for (const key of keys) {
            if (!current[key]) {
                current[key] = {};
            }
            current = current[key];
        }

        const oldValue = current[lastKey];

        // Не уведомляем если значение не изменилось
        if (oldValue === value) return;

        current[lastKey] = value;

        if (!silent) {
            this._notify(path, value, oldValue);

            // Уведомляем подписчиков родительских путей (только если cascade = true)
            if (cascade) {
                for (let i = keys.length; i > 0; i--) {
                    const parentPath = keys.slice(0, i).join('.');
                    // Прямой доступ к state вместо getState для производительности
                    let parentValue = this.state;
                    for (const key of keys.slice(0, i)) {
                        parentValue = parentValue?.[key];
                    }
                    this._notify(parentPath, parentValue);
                }
            }
        }
    }

    /**
     * Уведомление подписчиков
     * @private
     */
    _notify(path, newValue, oldValue) {
        const listeners = this.listeners.get(path) || [];
        listeners.forEach(callback => {
            try {
                callback(newValue, oldValue);
            } catch (error) {
                console.error(`Error in store listener for path "${path}":`, error);
            }
        });
    }

    /**
     * Массовое обновление состояния
     * @param {Object} updates - Объект с путями и значениями
     */
    batchSet(updates) {
        Object.entries(updates).forEach(([path, value]) => {
            this.setState(path, value, true);
        });
        
        // Уведомляем после всех обновлений
        Object.keys(updates).forEach(path => {
            this._notify(path, this.getState(path));
        });
    }

    /**
     * Сброс состояния к начальному
     */
    reset() {
        this.state = JSON.parse(JSON.stringify(initialState));
        this._notify('*', 'reset');
    }

    /**
     * Получение снимка состояния
     */
    getSnapshot() {
        return JSON.parse(JSON.stringify(this.state));
    }

    /**
     * Добавление middleware
     * @param {function} middleware - (store, next, action) => result
     */
    use(middleware) {
        this.middlewares.push(middleware);
    }
}

// Создаём экземпляр store
export const store = new Store(initialState);

// ============================================================
// Хелперы для удобной работы с состоянием
// ============================================================

export const projectStore = {
    get: () => store.getState('project'),
    getCurrentId: () => store.getState('project.currentId'),
    getData: () => store.getState('project.data'),
    setCurrentId: (id) => store.setState('project.currentId', id),
    setData: (data) => store.setState('project.data', data),
    setLoading: (isLoading) => store.setState('project.isLoading', isLoading),
    setError: (error) => store.setState('project.error', error),
    
    subscribe: (callback) => store.subscribe('project', callback)
};

export const modelStore = {
    get: () => store.getState('model'),
    getObject: () => store.getState('model.object'),
    isLoaded: () => store.getState('model.isLoaded'),
    
    setObject: (object) => store.setState('model.object', object),
    setLoaded: (isLoaded) => store.setState('model.isLoaded', isLoaded),
    setColor: (color) => store.setState('model.color', color),
    setPath: (path) => store.setState('model.path', path),
    
    subscribe: (callback) => store.subscribe('model', callback),
    subscribeLoaded: (callback) => store.subscribe('model.isLoaded', callback)
};

export const cutting3dStore = {
    get: () => store.getState('cutting3d'),
    isActive: () => store.getState('cutting3d.isActive'),
    getActiveAxis: () => store.getState('cutting3d.activeAxis'),
    getAxisValues: () => store.getState('cutting3d.axisValues'),
    getAxisBounds: () => store.getState('cutting3d.axisBounds'),
    getInvertedAxes: () => store.getState('cutting3d.invertedAxes'),

    setActive: (isActive) => store.setState('cutting3d.isActive', isActive),
    setActiveAxis: (axis) => store.setState('cutting3d.activeAxis', axis),
    setAxisValues: (values) => store.setState('cutting3d.axisValues', values),
    setAxisValue: (axis, value) => {
        const current = store.getState('cutting3d.axisValues');
        // Используем cascade: false для уменьшения лишних уведомлений
        store.setState('cutting3d.axisValues', { ...current, [axis]: value }, { cascade: false });
    },
    setAxisBounds: (bounds) => store.setState('cutting3d.axisBounds', bounds),
    setInvertedAxes: (inverted) => store.setState('cutting3d.invertedAxes', inverted),
    invertAxis: (axis) => {
        const current = store.getState('cutting3d.invertedAxes');
        store.setState('cutting3d.invertedAxes', { ...current, [axis]: !current[axis] });
    },

    subscribe: (callback) => store.subscribe('cutting3d', callback),
    subscribeActive: (callback) => store.subscribe('cutting3d.isActive', callback),
    subscribeActiveAxis: (callback) => store.subscribe('cutting3d.activeAxis', callback)
};

export const specificationStore = {
    get: () => store.getState('specification'),
    getStructure: () => store.getState('specification.structure'),
    getCSVData: () => store.getState('specification.csvData'),
    getSelectedPart: () => store.getState('specification.lastSelectedPart'),
    
    setStructure: (structure) => store.setState('specification.structure', structure),
    setCSVData: (csvData) => store.setState('specification.csvData', csvData),
    setSelectedPart: (partName) => store.setState('specification.lastSelectedPart', partName),
    setLoading: (isLoading) => store.setState('specification.isLoading', isLoading),
    
    subscribe: (callback) => store.subscribe('specification', callback),
    subscribeStructure: (callback) => store.subscribe('specification.structure', callback),
    subscribeSelectedPart: (callback) => store.subscribe('specification.lastSelectedPart', callback)
};

export const cuttingStore = {
    get: () => store.getState('cutting'),
    getMaterialsData: () => store.getState('cutting.materialsData'),
    getSettings: () => store.getState('cutting.settings'),
    getResults: () => store.getState('cutting.results'),
    
    setMaterialsData: (data) => store.setState('cutting.materialsData', data),
    setSettings: (settings) => store.setState('cutting.settings', settings),
    updateSetting: (key, value) => {
        const current = store.getState('cutting.settings');
        store.setState('cutting.settings', { ...current, [key]: value });
    },
    setResults: (results) => store.setState('cutting.results', results),
    setLoading: (isLoading) => store.setState('cutting.isLoading', isLoading),
    
    subscribe: (callback) => store.subscribe('cutting', callback),
    subscribeMaterialsData: (callback) => store.subscribe('cutting.materialsData', callback)
};

export const uiStore = {
    get: () => store.getState('ui'),
    getCurrentView: () => store.getState('ui.currentView'),
    getCurrentMode: () => store.getState('ui.currentMode'),
    getInfoPanelHeight: () => store.getState('ui.infoPanelHeight'),
    isFullscreen: () => store.getState('ui.isFullscreen'),
    getActiveContainer: () => store.getState('ui.activeContainer'),
    
    setCurrentView: (view) => store.setState('ui.currentView', view),
    setCurrentMode: (mode) => store.setState('ui.currentMode', mode),
    setInfoPanelHeight: (height) => store.setState('ui.infoPanelHeight', height),
    setFullscreen: (isFullscreen) => store.setState('ui.isFullscreen', isFullscreen),
    setActiveContainer: (container) => store.setState('ui.activeContainer', container),
    
    subscribe: (callback) => store.subscribe('ui', callback),
    subscribeCurrentView: (callback) => store.subscribe('ui.currentView', callback),
    subscribeCurrentMode: (callback) => store.subscribe('ui.currentMode', callback)
};

export const drawingStore = {
    get: () => store.getState('drawing'),
    getCurrentPart: () => store.getState('drawing.currentPart'),
    getImage: (partName) => store.getState('drawing.images')?.get(partName),
    
    setCurrentPart: (partName) => store.setState('drawing.currentPart', partName),
    addImage: (partName, image) => {
        const images = store.getState('drawing.images') || new Map();
        images.set(partName, image);
        store.setState('drawing.images', images);
    },
    setLoading: (isLoading) => store.setState('drawing.isLoading', isLoading),
    
    subscribe: (callback) => store.subscribe('drawing', callback),
    subscribeCurrentPart: (callback) => store.subscribe('drawing.currentPart', callback)
};

// Экспортируем для отладки в консоли
if (typeof window !== 'undefined') {
    window.__STORE__ = store;
    window.__STORE_HELPERS__ = {
        projectStore,
        modelStore,
        cutting3dStore,
        specificationStore,
        cuttingStore,
        uiStore,
        drawingStore
    };
}

export default store;
