/**
 * Plugin System
 * Единая система управления плагинами для всех модулей (3D, 2D и т.д.)
 *
 * Архитектура:
 * - PluginManager.register() — регистрация плагина (делается в файле плагина)
 * - PluginManager.registerModuleAPI() — модуль предоставляет свой API
 * - PluginManager.initUI(container, moduleId) — создание док-панели + контейнера панелей
 *
 * Управление плагинами:
 * - localStorage ключи:
 *     pluginEnabled  — { pluginId: true/false } — плагин включён/выключен (галочка снята = не загружается вообще)
 *     pluginAutoStart — { pluginId: true/false } — автозапуск (запускается ли в фоне при загрузке приложения)
 *
 * UI (док):
 * - Прозрачная горизонтальная панель-док внизу контейнера модуля
 * - Кнопки плагинов: inactive / background / active
 * - Активной может быть только одна иконка за раз
 *
 * PluginLifecycleManager:
 * - Читает localStorage для определения: какие плагины включены, какие автозапускаются
 * - При initUI — автоматически запускает плагины с autoStart в фоне (background)
 * - Предоставляет методы для включения/выключения плагинов из настроек
 */

import { escapeHtml } from './app.js';

// ============================================================
// STORAGE HELPERS
// ============================================================

const STORAGE_KEYS = {
    enabled: 'pluginEnabled',
    autoStart: 'pluginAutoStart'
};

function _loadStorageJSON(key) {
    try {
        return JSON.parse(localStorage.getItem(key) || '{}');
    } catch { return {}; }
}

function _saveStorageJSON(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
        console.warn('[PluginSystem] Ошибка записи localStorage:', e);
    }
}

function _isPluginEnabled(pluginId) {
    const data = _loadStorageJSON(STORAGE_KEYS.enabled);
    // По умолчанию все плагины включены (если нет записи)
    return data[pluginId] !== false;
}

function _setPluginEnabled(pluginId, enabled) {
    const data = _loadStorageJSON(STORAGE_KEYS.enabled);
    data[pluginId] = enabled;
    _saveStorageJSON(STORAGE_KEYS.enabled, data);
}

function _isPluginAutoStart(pluginId) {
    const data = _loadStorageJSON(STORAGE_KEYS.autoStart);
    // Если есть запись в localStorage — используем её
    if (pluginId in data) return data[pluginId] === true;
    // Fallback: читаем meta.autoStart из регистрации плагина
    const plugin = _plugins.get(pluginId);
    return plugin?.meta?.autoStart === true;
}

function _setPluginAutoStart(pluginId, autoStart) {
    const data = _loadStorageJSON(STORAGE_KEYS.autoStart);
    data[pluginId] = autoStart;
    _saveStorageJSON(STORAGE_KEYS.autoStart, data);
}

// ============================================================
// ВНУТРЕННИЕ СТИЛИ
// ============================================================

const _styleId = 'plugin-system-styles';

function _injectStyles() {
    if (document.getElementById(_styleId)) return;
    const style = document.createElement('style');
    style.id = _styleId;
    style.textContent = `
/* --- Док-панель (прозрачная, горизонтальная, внизу) --- */
.plugin-dock {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 0;
    z-index: 100;
    transition: opacity 0.2s ease;
    pointer-events: none;
}

.plugin-dock:empty,
.plugin-dock.no-plugins {
    display: none;
}

/* --- Кнопки плагинов в доке --- */
.plugin-dock-btn {
    pointer-events: auto;
    width: 44px;
    height: 44px;
    border: none;
    background: transparent;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-color, #aaa);
    transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
    flex-shrink: 0;
    position: relative;
    opacity: 0.55;
}
.plugin-dock-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    opacity: 0.85;
}
.plugin-dock-btn:active {
    transform: scale(0.92);
}
.plugin-dock-btn svg {
    width: 22px;
    height: 22px;
    fill: currentColor;
    pointer-events: none;
}

.plugin-dock-btn.is-background {
    opacity: 1;
    color: var(--text-color, #fff);
}
.plugin-dock-btn.is-background::after {
    content: '';
    position: absolute;
    bottom: 4px;
    left: 50%;
    transform: translateX(-50%);
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.85;
}

.plugin-dock-btn.is-active {
    opacity: 1;
    color: var(--text-color, #fff);
}
.plugin-dock-btn.is-active::after {
    content: '';
    position: absolute;
    bottom: 4px;
    left: 50%;
    transform: translateX(-50%);
    width: 18px;
    height: 2px;
    border-radius: 1px;
    background: currentColor;
}

.plugin-dock-btn::before {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.85);
    color: #ddd;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 10;
}
.plugin-dock-btn:hover::before {
    opacity: 1;
}

/* --- Контейнер панелей --- */
.plugin-panels {
    position: absolute;
    bottom: 64px;
    left: 0;
    right: 0;
    height: 0;
    z-index: 1000;
    pointer-events: none;
}

.plugin-toolbar {
    pointer-events: auto;
    opacity: 0;
    visibility: hidden;
    position: absolute;
    bottom: 0;
    left: 50%;
    transform: translate(-50%, 10px);
    transition: opacity 0.2s ease, visibility 0.2s ease, transform 0.2s ease;
}
.plugin-toolbar.visible {
    opacity: 1;
    visibility: visible;
    transform: translate(-50%, 0);
}

/* Мобильная адаптивность */
@media (max-width: 768px) {
    .plugin-dock {
        bottom: 8px;
        gap: 2px;
        padding: 4px 8px;
    }
    .plugin-dock-btn {
        width: 40px;
        height: 40px;
    }
    .plugin-dock-btn svg {
        width: 20px;
        height: 20px;
    }
    .plugin-dock-btn.is-active::after {
        width: 16px;
    }
    .plugin-panels {
        bottom: 56px;
    }
}

.fullscreen-active .plugin-dock {
    display: flex !important;
    opacity: 1 !important;
    z-index: 1100;
}

.fullscreen-active .plugin-panels {
    z-index: 1100;
}

@media (max-width: 768px) and (hover: none) and (pointer: coarse) {
    .fullscreen-active .plugin-dock {
        bottom: 20px;
    }
    .fullscreen-active .plugin-panels {
        bottom: 76px;
    }
}

@supports (height: 100dvh) {
    .fullscreen-active .project-container {
        height: 100dvh;
    }
}
`;
    document.head.appendChild(style);
}

// ============================================================
// PluginManager
// ============================================================

const _plugins = new Map();
const _moduleAPIs = new Map();
const _moduleInstances = new Map(); // 'moduleId:pluginId' -> { cleanup, panelUnmount, toolbarEl }

const PluginManager = {

    register(config) {
        if (!config.id) throw new Error('Plugin must have an id');
        if (_plugins.has(config.id)) {
            console.warn(`[PluginManager] Plugin "${config.id}" is already registered. Overwriting.`);
        }
        _plugins.set(config.id, {
            ...config,
            module: Array.isArray(config.module) ? config.module : [config.module],
        });
    },

    registerModuleAPI(moduleId, api) {
        _moduleAPIs.set(moduleId, api);
    },

    getModuleAPI(moduleId) {
        const api = _moduleAPIs.get(moduleId);
        if (!api) return null;
        const resolved = {};
        for (const key of Object.keys(api)) {
            resolved[key] = typeof api[key] === 'function' ? api[key]() : api[key];
        }
        return resolved;
    },

    getPluginsForModule(moduleId) {
        const result = [];
        for (const [, plugin] of _plugins) {
            if (plugin.module.includes(moduleId) || plugin.module.includes('*')) {
                result.push(plugin);
            }
        }
        return result;
    },

    /**
     * Создать UI (док + контейнер панелей) внутри контейнера модуля.
     * Автоматически запускает плагины с autoStart в фоне.
     *
     * @param {HTMLElement} container
     * @param {string} moduleId
     * @returns {Object} контроллер UI
     */
    initUI(container, moduleId) {
        _injectStyles();

        const plugins = this.getPluginsForModule(moduleId);
        if (plugins.length === 0) return { destroy: () => {} };

        // --- Фильтруем: показываем только включённые плагины ---
        const enabledPlugins = plugins.filter(p => _isPluginEnabled(p.id));

        // --- Док-панель ---
        const dock = document.createElement('div');
        dock.className = 'plugin-dock';
        container.appendChild(dock);

        // --- Контейнер для панелей ---
        const panelsContainer = document.createElement('div');
        panelsContainer.className = 'plugin-panels';
        container.appendChild(panelsContainer);

        // Кнопки плагинов
        const buttons = new Map();
        const runningPlugins = new Set();
        let activePluginId = null;

        // Создаём кнопки только для включённых плагинов
        enabledPlugins.forEach(plugin => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'plugin-dock-btn';
            btn.dataset.id = plugin.id;
            btn.dataset.tooltip = plugin.name;
            btn.setAttribute('aria-label', plugin.name);
            btn.innerHTML = `<svg><use xlink:href="assets/icons/sprite.svg#${escapeHtml(plugin.icon)}"></use></svg>`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                _togglePlugin(plugin.id);
            });
            dock.appendChild(btn);
            buttons.set(plugin.id, btn);
        });

        // --- Условная видимость кнопок ---
        function _shouldShowPlugin(plugin) {
            if (typeof plugin.condition !== 'function') return true;
            const moduleAPI = PluginManager.getModuleAPI(moduleId);
            if (!moduleAPI) return false;
            try {
                return !!plugin.condition(moduleAPI);
            } catch (e) {
                console.warn(`[PluginManager] condition() для плагина "${plugin.id}" выбросил исключение:`, e);
                return false;
            }
        }

        function _refreshButtonsVisibility() {
            let anyVisible = false;
            for (const plugin of enabledPlugins) {
                const btn = buttons.get(plugin.id);
                if (!btn) continue;
                const shouldShow = _shouldShowPlugin(plugin);
                btn.style.display = shouldShow ? '' : 'none';
                if (shouldShow) anyVisible = true;
                if (!shouldShow && runningPlugins.has(plugin.id)) {
                    _deactivatePlugin(plugin.id);
                }
            }
            dock.classList.toggle('no-plugins', !anyVisible);
        }

        _refreshButtonsVisibility();

        // Переоценка при загрузке модели
        const _modelLoadedHandler = () => {
            _refreshButtonsVisibility();
            // Автозапуск плагинов, которые стали видимыми после загрузки модели
            _autoStartPendingPlugins();
        };
        window.addEventListener('modelLoaded', _modelLoadedHandler);

        // --- Обновление состояния кнопок ---
        function _updateButtonState(pluginId) {
            const btn = buttons.get(pluginId);
            if (!btn) return;
            btn.classList.remove('is-active', 'is-background');
            if (pluginId === activePluginId) {
                btn.classList.add('is-active');
            } else if (runningPlugins.has(pluginId)) {
                btn.classList.add('is-background');
            }
        }

        function _updateAllButtons() {
            for (const id of buttons.keys()) _updateButtonState(id);
        }

        // --- Логика переключения ---
        function _togglePlugin(pluginId) {
            if (pluginId === activePluginId) {
                _deactivatePlugin(pluginId);
            } else {
                _activatePlugin(pluginId);
            }
        }

        function _initPluginInstance(pluginId) {
            const plugin = _plugins.get(pluginId);
            if (!plugin) return null;

            const instanceKey = `${moduleId}:${pluginId}`;
            const moduleAPI = PluginManager.getModuleAPI(moduleId);

            let cleanup = null;
            if (typeof plugin.init === 'function') {
                cleanup = plugin.init(moduleAPI);
            }

            const toolbarEl = document.createElement('div');
            toolbarEl.className = 'plugin-toolbar';
            toolbarEl.dataset.pluginId = pluginId;

            if (plugin.panel?.className) {
                toolbarEl.classList.add(...plugin.panel.className.split(' ').filter(Boolean));
            }
            if (plugin.panel?.html) {
                toolbarEl.innerHTML = plugin.panel.html;
            }
            panelsContainer.appendChild(toolbarEl);

            if (typeof plugin.panel?.onMount === 'function') {
                plugin.panel.onMount(toolbarEl, moduleAPI);
            }

            const instance = {
                cleanup: typeof cleanup === 'function' ? cleanup : null,
                panelUnmount: typeof plugin.panel?.onUnmount === 'function' ? plugin.panel.onUnmount : null,
                toolbarEl,
            };
            _moduleInstances.set(instanceKey, instance);
            runningPlugins.add(pluginId);
            return instance;
        }

        function _activatePlugin(pluginId) {
            const plugin = _plugins.get(pluginId);
            if (!plugin) return;
            if (pluginId === activePluginId) return;

            if (!runningPlugins.has(pluginId)) {
                _initPluginInstance(pluginId);
            }

            // Скрываем панель предыдущего активного
            if (activePluginId && activePluginId !== pluginId) {
                const prevInstance = _moduleInstances.get(`${moduleId}:${activePluginId}`);
                if (prevInstance?.toolbarEl) {
                    prevInstance.toolbarEl.classList.remove('visible');
                }
            }

            // Показываем панель нового активного
            const instance = _moduleInstances.get(`${moduleId}:${pluginId}`);
            if (instance?.toolbarEl) {
                requestAnimationFrame(() => {
                    instance.toolbarEl.classList.add('visible');
                });
            }

            activePluginId = pluginId;
            _updateAllButtons();
        }

        function _activatePluginBackground(pluginId) {
            if (runningPlugins.has(pluginId)) return;
            _initPluginInstance(pluginId);
            _updateButtonState(pluginId);
        }

        function _deactivatePlugin(pluginId) {
            if (!runningPlugins.has(pluginId)) return;

            const plugin = _plugins.get(pluginId);
            const instanceKey = `${moduleId}:${pluginId}`;
            const instance = _moduleInstances.get(instanceKey);

            if (instance) {
                if (typeof instance.panelUnmount === 'function') instance.panelUnmount();
                if (typeof instance.cleanup === 'function') instance.cleanup();
                if (instance.toolbarEl) {
                    instance.toolbarEl.classList.remove('visible');
                    setTimeout(() => instance.toolbarEl?.remove(), 200);
                }
                _moduleInstances.delete(instanceKey);
            }

            if (typeof plugin?.destroy === 'function') plugin.destroy();

            runningPlugins.delete(pluginId);

            if (activePluginId === pluginId) {
                activePluginId = null;
            }

            _updateAllButtons();
        }

        function _autoStartPendingPlugins() {
            for (const plugin of enabledPlugins) {
                if (runningPlugins.has(plugin.id)) continue;
                if (!_shouldShowPlugin(plugin)) continue;
                if (!_isPluginAutoStart(plugin.id)) continue;
                // Запускаем в фоне
                _activatePluginBackground(plugin.id);
            }
        }

        // Автозапуск при инициализации (для плагинов без condition)
        _autoStartPendingPlugins();

        function activatePlugin(id) { _activatePlugin(id); }
        function deactivatePlugin(id) { _deactivatePlugin(id); }
        function deactivateAll() {
            for (const id of [...runningPlugins]) _deactivatePlugin(id);
        }
        function isPluginActive(id) { return runningPlugins.has(id); }
        function getActivePluginIds() { return [...runningPlugins]; }
        function getActivePluginId() { return activePluginId; }

        /**
         * Включить/выключить плагин (из настроек).
         * Если выключаем — деактивируем и убираем кнопку.
         * Если включаем — добавляем кнопку и обновляем видимость.
         */
        function togglePluginEnabled(pluginId, enabled) {
            _setPluginEnabled(pluginId, enabled);

            if (enabled) {
                // Включаем: добавляем кнопку
                const plugin = _plugins.get(pluginId);
                if (!plugin || buttons.has(pluginId)) return;

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'plugin-dock-btn';
                btn.dataset.id = pluginId;
                btn.dataset.tooltip = plugin.name;
                btn.setAttribute('aria-label', plugin.name);
                btn.innerHTML = `<svg><use xlink:href="assets/icons/sprite.svg#${escapeHtml(plugin.icon)}"></use></svg>`;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    _togglePlugin(pluginId);
                });
                dock.appendChild(btn);
                buttons.set(pluginId, btn);

                _refreshButtonsVisibility();
                _autoStartPendingPlugins();
            } else {
                // Выключаем: деактивируем и убираем кнопку
                if (runningPlugins.has(pluginId)) {
                    _deactivatePlugin(pluginId);
                }
                const btn = buttons.get(pluginId);
                if (btn) {
                    btn.remove();
                    buttons.delete(pluginId);
                }
                _refreshButtonsVisibility();
            }
        }

        /**
         * Обновить автозапуск плагина.
         */
        function setPluginAutoStart(pluginId, autoStart) {
            _setPluginAutoStart(pluginId, autoStart);
        }

        /**
         * Перезагрузить список плагинов (вызвать после включения/выключения).
         */
        function reloadPlugins() {
            // Сначала деактивируем все, чьи кнопки должны пропасть
            for (const plugin of plugins) {
                if (!_isPluginEnabled(plugin.id) && runningPlugins.has(plugin.id)) {
                    _deactivatePlugin(plugin.id);
                }
            }
            _refreshButtonsVisibility();
            _autoStartPendingPlugins();
        }

        return {
            destroy: () => {
                deactivateAll();
                window.removeEventListener('modelLoaded', _modelLoadedHandler);
                dock.remove();
                panelsContainer.remove();
            },
            activatePlugin,
            deactivatePlugin,
            deactivateAll,
            isPluginActive,
            getActivePluginIds,
            getActivePluginId,
            getContainer: () => container,
            refreshVisibility: _refreshButtonsVisibility,
            togglePluginEnabled,
            setPluginAutoStart,
            reloadPlugins,
        };
    },

    has(id) {
        return _plugins.has(id);
    },

    get(id) {
        return _plugins.get(id) || null;
    },

    /**
     * Возвращает публичный API плагина (если он его предоставляет).
     */
    getPluginAPI(pluginId) {
        const plugin = _plugins.get(pluginId);
        return plugin?.getAPI ? plugin.getAPI() : null;
    },

    /**
     * Делегирует per-frame обновление всем активным плагинам.
     */
    frameUpdate(now) {
        for (const [key] of _moduleInstances) {
            const pluginId = key.split(':').pop();
            const plugin = _plugins.get(pluginId);
            if (typeof plugin?.onFrame === 'function') {
                plugin.onFrame(now);
            }
        }
    },

    // ============================================================
    // STORAGE API (для использования в ui-managers.js)
    // ============================================================

    STORAGE_KEYS,

    isPluginEnabled: _isPluginEnabled,
    setPluginEnabled: _setPluginEnabled,
    isPluginAutoStart: _isPluginAutoStart,
    setPluginAutoStart: _setPluginAutoStart,
    loadStorageJSON: _loadStorageJSON,
};

export default PluginManager;
