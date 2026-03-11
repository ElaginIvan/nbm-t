/**
 * Централизованное хранилище состояния приложения
 * Использует паттерн Observer для подписки на изменения
 */

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
        activeContainer: 'model', // 'model' | 'drawing'
        settings: {
            modelColor: '#CCCCCC',
            modelMetalness: 0.1,
            modelRoughness: 0.75,
            gridVisible: true,
            gridSize: 1000,
            themeMode: 'auto' // 'auto' | 'light' | 'dark'
        }
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

// Восстанавливаем настройки UI из localStorage
const savedSettings = localStorage.getItem('uiSettings');
if (savedSettings) {
    try {
        const parsed = JSON.parse(savedSettings);
        store.setState('ui.settings', { ...store.getState('ui.settings'), ...parsed }, { silent: true });
    } catch (e) {
        console.warn('Failed to parse saved UI settings:', e);
    }
}

// Экспортируем для отладки в консоли
if (typeof window !== 'undefined') {
    window.__STORE__ = store;
}

export default store;
