/**
 * Plugin System
 * Единая система управления плагинами для всех модулей (3D, 2D и т.д.)
 *
 * Архитектура:
 * - PluginManager.register() — регистрация плагина (делается в файле плагина)
 * - PluginManager.registerModuleAPI() — модуль предоставляяет свой API
 * - PluginManager.initUI(container, moduleId) — создание сайдбара + контейнера панелей
 *
 * UI:
 * - Справа тонкая полоска-триггер (6px)
 * - По клику/тапу выезжает панелька с иконками плагинов (50px)
 * - Каждый плагин togglable — можно включить несколько одновременно
 * - Панели стекаются снизу вверх, центрируются по горизонтали
 *
 * Условная видимость:
 * - Плагин может объявить поле condition: (api) => boolean
 * - Если condition возвращает false — кнопка плагина не отображается в сайдбаре
 * - PluginManager автоматически переоценивает condition при modelLoaded
 * - Если активный плагин стал невидим (condition стал false) — он деактивируется
 */

// ============================================================
// ЛОКАЛЬНАЯ УТИЛИТА (без импорта из app.js, чтобы не создавать цикл зависимостей)
// ============================================================

function _escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ============================================================
// ВНУТРЕННИЕ СТИЛИ (инжектятся один раз)
// ============================================================

const _styleId = 'plugin-system-styles';

function _injectStyles() {
    if (document.getElementById(_styleId)) return;
    const style = document.createElement('style');
    style.id = _styleId;
    style.textContent = `
/* --- Триггер (правая полоска) --- */
.plugin-trigger {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 6px;
    height: 100px;
    background: var(--border-color);
    opacity: 0.8;
    border-radius: 3px 0 0 3px;
    cursor: pointer;
    z-index: 100;
    transition: background 0.2s ease, width 0.2s ease;
    touch-action: none;
}
.plugin-trigger:hover,
.plugin-trigger.touching {
    background: rgba(255, 255, 255, 0.22);
    width: 8px;
}

/* --- Сайдбар (панелька с иконками) --- */
.plugin-sidebar {
    position: absolute;
    right: -61px;
    top: 50%;
    transform: translateY(-50%);
    width: 55px;
    max-height: 70%;
    overflow-y: auto;
    background: var(--button-color, rgba(24, 24, 28, 0.96));
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-radius: 12px 0 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-right: none;
    padding: 8px 5px;
    z-index: 101;
    transition: right 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    box-shadow: -2px 0 12px rgba(0, 0, 0, 0.4);
}
.plugin-sidebar.open {
    right: 0;
}

/* --- Кнопки плагинов в сайдбаре --- */
.plugin-sidebar-btn {
    width: 40px;
    height: 40px;
    border: 1px solid transparent;
    background: transparent;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-color, #aaa);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    flex-shrink: 0;
    position: relative;
}
.plugin-sidebar-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
}
.plugin-sidebar-btn.active {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.3);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.plugin-sidebar-btn svg {
    width: 21px;
    height: 21px;
    fill: var(--text-color, #aaa);
}
.plugin-sidebar-btn:hover svg,
.plugin-sidebar-btn.active svg {
    fill: #fff;
}
/* Тултип */
.plugin-sidebar-btn::after {
    content: attr(data-tooltip);
    position: absolute;
    right: calc(100% + 8px);
    top: 50%;
    transform: translateY(-50%);
    background: rgba(0, 0, 0, 0.85);
    color: #ddd;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
}
.plugin-sidebar-btn:hover::after {
    opacity: 1;
}

/* --- Контейнер панелей (стек снизу вверх, центрирование) --- */
.plugin-panels {
    position: absolute;
    bottom: 20px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column-reverse;
    align-items: center;
    gap: 10px;
    z-index: 1000;
    pointer-events: none;
}

/* --- Отдельная панель плагина --- */
.plugin-toolbar {
    pointer-events: auto;
    opacity: 0;
    visibility: hidden;
    transform: translateY(10px);
    transition: opacity 0.2s ease, visibility 0.2s ease, transform 0.2s ease;
    position: relative;
}
.plugin-toolbar.visible {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
}

@media (max-width: 768px) {
    .plugin-panels {
        bottom: 15px;
    }
    .fullscreen-active .plugin-panels {
        bottom: 80px;
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
const _moduleInstances = new Map(); // 'moduleId:pluginId' → { cleanup, panelUnmount, toolbarEl }

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
     * Создать UI (сайдбар + контейнер панелей) внутри контейнера модуля.
     * @param {HTMLElement} container
     * @param {string} moduleId
     */
    initUI(container, moduleId) {
        _injectStyles();

        const plugins = this.getPluginsForModule(moduleId);
        if (plugins.length === 0) return { destroy: () => {} };

        // --- Триггер ---
        const trigger = document.createElement('div');
        trigger.className = 'plugin-trigger';
        container.appendChild(trigger);

        // --- Сайдбар ---
        const sidebar = document.createElement('div');
        sidebar.className = 'plugin-sidebar';
        container.appendChild(sidebar);

        // --- Контейнер для панелей (стек) ---
        const panelsContainer = document.createElement('div');
        panelsContainer.className = 'plugin-panels';
        container.appendChild(panelsContainer);

        // Кнопки плагинов
        const buttons = new Map();
        const activePlugins = new Set(); // Set активных pluginId

        plugins.forEach(plugin => {
            const btn = document.createElement('button');
            btn.className = 'plugin-sidebar-btn';
            btn.dataset.id = plugin.id;
            btn.dataset.tooltip = plugin.name;
            btn.setAttribute('aria-label', plugin.name);
            btn.innerHTML = `<svg><use xlink:href="assets/icons/sprite.svg#${_escapeHtml(plugin.icon)}"></use></svg>`;
            btn.addEventListener('click', () => _togglePlugin(plugin.id));
            sidebar.appendChild(btn);
            buttons.set(plugin.id, btn);
        });

        // --- Условная видимость кнопок (через plugin.condition) ---
        function _shouldShowPlugin(plugin) {
            // Если condition не задан — показываем всегда (обратная совместимость)
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
            for (const plugin of plugins) {
                const btn = buttons.get(plugin.id);
                if (!btn) continue;
                const shouldShow = _shouldShowPlugin(plugin);
                btn.style.display = shouldShow ? '' : 'none';
                // Если плагин стал невидим, но был активен — деактивируем
                if (!shouldShow && activePlugins.has(plugin.id)) {
                    _deactivatePlugin(plugin.id);
                }
            }
            // Скрываем триггер целиком, если видимых плагинов нет
            const anyVisible = plugins.some(p => _shouldShowPlugin(p));
            trigger.style.display = anyVisible ? '' : 'none';
        }

        // Первичная оценка (модель может быть уже загружена — например, при поздней инициализации)
        _refreshButtonsVisibility();

        // Переоценка при каждой загрузке модели
        const _modelLoadedHandler = () => _refreshButtonsVisibility();
        window.addEventListener('modelLoaded', _modelLoadedHandler);

        // --- Логика сайдбара ---
        let sidebarOpen = false;

        function openSidebar() {
            sidebarOpen = true;
            sidebar.classList.add('open');
        }

        function closeSidebar() {
            sidebarOpen = false;
            sidebar.classList.remove('open');
        }

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebarOpen ? closeSidebar() : openSidebar();
        });

        trigger.addEventListener('touchstart', () => {
            trigger.classList.add('touching');
        }, { passive: true });
        trigger.addEventListener('touchend', () => {
            trigger.classList.remove('touching');
        }, { passive: true });

        document.addEventListener('click', (e) => {
            if (sidebarOpen && !sidebar.contains(e.target) && !trigger.contains(e.target) && !panelsContainer.contains(e.target)) {
                closeSidebar();
            }
        });

        // --- Множественная активация/деактивация ---
        function _togglePlugin(pluginId) {
            if (activePlugins.has(pluginId)) {
                _deactivatePlugin(pluginId);
            } else {
                _activatePlugin(pluginId);
            }
        }

        function _activatePlugin(pluginId) {
            if (activePlugins.has(pluginId)) return;

            const plugin = _plugins.get(pluginId);
            if (!plugin) return;

            const instanceKey = `${moduleId}:${pluginId}`;
            const moduleAPI = PluginManager.getModuleAPI(moduleId);

            // Вызываем init плагина
            let cleanup = null;
            if (typeof plugin.init === 'function') {
                cleanup = plugin.init(moduleAPI);
            }

            // Создаём отдельный элемент панели для этого плагина
            const toolbarEl = document.createElement('div');
            toolbarEl.className = 'plugin-toolbar';
            toolbarEl.dataset.pluginId = pluginId;

            if (plugin.panel?.className) {
                toolbarEl.classList.add(...plugin.panel.className.split(' '));
            }

            if (plugin.panel?.html) {
                toolbarEl.innerHTML = plugin.panel.html;
            }

            panelsContainer.appendChild(toolbarEl);

            // Вызываем onMount
            if (typeof plugin.panel?.onMount === 'function') {
                plugin.panel.onMount(toolbarEl, moduleAPI);
            }

            // Анимация появления
            requestAnimationFrame(() => {
                toolbarEl.classList.add('visible');
            });

            buttons.get(pluginId)?.classList.add('active');
            activePlugins.add(pluginId);

            _moduleInstances.set(instanceKey, {
                cleanup: typeof cleanup === 'function' ? cleanup : null,
                panelUnmount: typeof plugin.panel?.onUnmount === 'function' ? plugin.panel.onUnmount : null,
                toolbarEl,
            });

            closeSidebar();
        }

        function _deactivatePlugin(pluginId) {
            if (!activePlugins.has(pluginId)) return;

            const plugin = _plugins.get(pluginId);
            const instanceKey = `${moduleId}:${pluginId}`;
            const instance = _moduleInstances.get(instanceKey);

            if (instance) {
                if (typeof instance.panelUnmount === 'function') instance.panelUnmount();
                if (typeof instance.cleanup === 'function') instance.cleanup();
                if (instance.toolbarEl) {
                    instance.toolbarEl.classList.remove('visible');
                    // Удаляем после анимации
                    setTimeout(() => instance.toolbarEl?.remove(), 200);
                }
                _moduleInstances.delete(instanceKey);
            }

            if (typeof plugin?.destroy === 'function') plugin.destroy();

            buttons.get(pluginId)?.classList.remove('active');
            activePlugins.delete(pluginId);
        }

        function activatePlugin(pluginId) {
            _activatePlugin(pluginId);
        }

        function deactivatePlugin(pluginId) {
            _deactivatePlugin(pluginId);
        }

        function deactivateAll() {
            for (const id of [...activePlugins]) {
                _deactivatePlugin(id);
            }
        }

        function isPluginActive(pluginId) {
            return activePlugins.has(pluginId);
        }

        function getActivePluginIds() {
            return [...activePlugins];
        }

        return {
            destroy: () => {
                deactivateAll();
                window.removeEventListener('modelLoaded', _modelLoadedHandler);
                trigger.remove();
                sidebar.remove();
                panelsContainer.remove();
            },
            activatePlugin,
            deactivatePlugin,
            deactivateAll,
            isPluginActive,
            getActivePluginIds,
            getContainer: () => container,
            refreshVisibility: _refreshButtonsVisibility,
        };
    },

    has(id) {
        return _plugins.has(id);
    },

    get(id) {
        return _plugins.get(id) || null;
    },
};

export default PluginManager;