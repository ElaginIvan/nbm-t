/**
 * UI Managers Module — менеджеры интерфейса страницы проекта.
 * FullscreenManager: полноэкранный режим.
 * ResizeHandler: изменение панели, переключение вкладок.
 * SettingsManager: модальное окно настроек.
 */

import { store, onReady, escapeHtml } from './app.js';
import { SpecificationService } from './specification.js';
import PluginManager from './plugin-system.js';

// ============================================================
// FULLSCREEN MANAGER
// ============================================================

export const FullscreenManager = {
    isFullscreen: false,

    init() {
        this.toggleBtn = document.getElementById('toggle-fullscreen-btn');
        this.modelContainer = document.getElementById('model-container');
        this.drawingContainer = document.getElementById('drawing-container');
        this.infoPanel = document.querySelector('.info-panel');

        if (!this.toggleBtn) return;
        this.bindEvents();
    },

    bindEvents() {
        this.toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.toggleFullscreen();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isFullscreen) this.exitFullscreen();
        });
    },

    toggleFullscreen() {
        this.isFullscreen ? this.exitFullscreen() : this.enterFullscreen();
    },

    enterFullscreen() {
        const activeContainer = this.modelContainer.classList.contains('active')
            ? this.modelContainer
            : this.drawingContainer;

        this.infoPanel.style.display = 'none';

        const resizeHandle = document.getElementById('resize-handle');
        if (resizeHandle) resizeHandle.style.display = 'none';

        document.body.classList.add('fullscreen-active');
        activeContainer.classList.add('fullscreen-expanded');

        const projectContainer = document.querySelector('.project-container');
        if (projectContainer) projectContainer.classList.add('fullscreen-wide');

        this.isFullscreen = true;
        this._updateButtonIcon();

        if (activeContainer === this.modelContainer && window.onWindowResize) {
            setTimeout(() => window.onWindowResize(), 50);
        }
        if (activeContainer === this.drawingContainer) {
            this._setupDrawingControls();
        }
    },

    exitFullscreen() {
        if (!this.isFullscreen) return;

        const activeContainer = this.modelContainer.classList.contains('active')
            ? this.modelContainer
            : this.drawingContainer;

        this.infoPanel.style.display = '';

        const resizeHandle = document.getElementById('resize-handle');
        if (resizeHandle) resizeHandle.style.display = '';

        document.body.classList.remove('fullscreen-active');
        this.modelContainer.classList.remove('fullscreen-expanded');
        this.drawingContainer.classList.remove('fullscreen-expanded');

        const projectContainer = document.querySelector('.project-container');
        if (projectContainer) projectContainer.classList.remove('fullscreen-wide');

        this.isFullscreen = false;
        this._updateButtonIcon();

        if (activeContainer === this.modelContainer) {
            activeContainer.style.transition = 'height 0.3s ease';
            const onEnd = () => {
                activeContainer.removeEventListener('transitionend', onEnd);
                activeContainer.style.transition = '';
                if (window.onWindowResize) window.onWindowResize();
            };
            activeContainer.addEventListener('transitionend', onEnd);
            setTimeout(() => {
                if (activeContainer.style.transition) {
                    activeContainer.removeEventListener('transitionend', onEnd);
                    activeContainer.style.transition = '';
                    if (window.onWindowResize) window.onWindowResize();
                }
            }, 350);
        } else {
            setTimeout(() => { if (window.onWindowResize) window.onWindowResize(); }, 50);
        }

        this._restoreDrawingControls();
    },

    _updateButtonIcon() {
        const icon = this.isFullscreen ? 'compress' : 'expand';
        // Только href у <use>: замена innerHTML при клике отсоединяет <svg> —
        // цель события, и проверка «клик мимо таблицы» теряла мультивыбор.
        const use = this.toggleBtn.querySelector('use');
        if (use) {
            const href = `assets/icons/sprite.svg#${icon}`;
            use.setAttribute('href', href);
            use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
        } else {
            this.toggleBtn.innerHTML = `<svg><use xlink:href="assets/icons/sprite.svg#${escapeHtml(icon)}"></use></svg>`;
        }
    },

    _setupDrawingControls() {
        const controls = this.drawingContainer?.querySelector('.drawing-controls');
        if (!controls) return;
        controls.classList.add('fullscreen-controls');
        if (this._isMobile()) controls.style.bottom = '80px';
    },

    _restoreDrawingControls() {
        const controls = this.drawingContainer?.querySelector('.drawing-controls');
        if (!controls) return;
        controls.classList.remove('fullscreen-controls');
        controls.style.bottom = '';
    },

    _isMobile() {
        return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    },

    forceExit() {
        if (this.isFullscreen) this.exitFullscreen();
    }
};

window.FullscreenManager = FullscreenManager;

// ============================================================
// RESIZE HANDLER
// ============================================================

const MIN_HEIGHT = 60;
const RESIZE_THROTTLE_DELAY = 50;

export class ResizeHandler {
    constructor() {
        this.handle = document.getElementById('resize-handle');
        this.infoPanel = document.querySelector('.info-panel');
        this.modelContainer = document.getElementById('model-container');
        this.drawingContainer = document.getElementById('drawing-container');
        this.viewToggleBtn = document.getElementById('view-toggle-btn');

        this.isResizing = false;
        this.startY = 0;
        this.startHeight = 0;
        this.minHeight = MIN_HEIGHT;
        // maxHeight вычисляется на старте перетаскивания: фиксация в конструкторе устаревала после ресайза окна.
        this.maxHeight = window.innerHeight - MIN_HEIGHT;

        this.lastResizeCall = 0;
        this.resizeThrottleDelay = RESIZE_THROTTLE_DELAY;
        this.resizeTimeout = null;

        const restored = this._restoreViewState();
        this.currentView = restored;
        store.setState('ui.currentView', restored, { silent: true });

        this._init();
        this._initViewToggle();
        this._restoreHeight();
        this._showCurrentView();
        this._updateToggleIcon();
    }

    _init() {
        this.handle.addEventListener('mousedown', (e) => {
            if (!this._isToggleButton(e.target)) this._startResize(e);
        });

        this.handle.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const target = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
            if (!this._isToggleButton(target)) {
                e.preventDefault();
                this._startResizeTouch(e);
            }
        }, { passive: false });

        document.addEventListener('mousemove', (e) => { if (this.isResizing) this._onMouseMove(e); });
        document.addEventListener('mouseup', () => { if (this.isResizing) this._stopResize(); });
        document.addEventListener('touchmove', (e) => {
            if (this.isResizing && e.touches.length === 1) {
                e.preventDefault();
                this._onTouchMove(e);
            }
        }, { passive: false });
        document.addEventListener('touchend', () => { if (this.isResizing) this._stopResize(); });
        document.addEventListener('touchcancel', () => { if (this.isResizing) this._stopResize(); });

        store.subscribe('ui.currentView', (view) => {
            if (view && view !== this.currentView) {
                this.currentView = view;
                this._showCurrentView();
                this._updateToggleIcon();
            }
        });
    }

    _isToggleButton(element) {
        return element === this.viewToggleBtn || element.closest('#view-toggle-btn') === this.viewToggleBtn;
    }

    _startResize(e) {
        e.preventDefault();
        e.stopPropagation();
        this.isResizing = true;
        this.maxHeight = window.innerHeight - MIN_HEIGHT;
        this.startY = e.clientY;
        this.startHeight = parseInt(getComputedStyle(this.infoPanel).height, 10);
        this.handle.classList.add('active');
        this.infoPanel.style.transition = 'none';
        document.body.style.cursor = 'row-resize';
    }

    _startResizeTouch(e) {
        this.isResizing = true;
        this.maxHeight = window.innerHeight - MIN_HEIGHT;
        this.startY = e.touches[0].clientY;
        this.startHeight = parseInt(getComputedStyle(this.infoPanel).height, 10);
        this.handle.classList.add('active');
        this.infoPanel.style.transition = 'none';
    }

    _onMouseMove(e) {
        if (!this.isResizing) return;
        this._updateHeight(this.startHeight + (this.startY - e.clientY));
        this._throttledWindowResize();
    }

    _onTouchMove(e) {
        if (!this.isResizing) return;
        this._updateHeight(this.startHeight + (this.startY - e.touches[0].clientY));
        this._throttledWindowResize();
    }

    _throttledWindowResize() {
        const now = Date.now();
        if (now - this.lastResizeCall >= this.resizeThrottleDelay) {
            this._callWindowResize();
            this.lastResizeCall = now;
        } else {
            if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => this._callWindowResize(), this.resizeThrottleDelay);
        }
    }

    _callWindowResize() {
        if (typeof window.onWindowResize === 'function') window.onWindowResize();
    }

    _updateHeight(newHeight) {
        newHeight = Math.max(this.minHeight, Math.min(this.maxHeight, newHeight));
        this.infoPanel.style.height = `${newHeight}px`;
        store.setState('ui.infoPanelHeight', newHeight);

        const handleHeight = this.handle.offsetHeight || 20;
        const containerHeight = Math.max(100, window.innerHeight - newHeight - handleHeight - 80);

        if (this.modelContainer.classList.contains('active')) {
            this.modelContainer.style.height = `${containerHeight}px`;
        }
        if (this.drawingContainer.classList.contains('active')) {
            this.drawingContainer.style.height = `${containerHeight}px`;
        }
    }

    _stopResize() {
        if (!this.isResizing) return;
        this.isResizing = false;
        this.handle.classList.remove('active');
        this.infoPanel.style.transition = '';
        document.body.style.cursor = '';

        if (this.resizeTimeout) {
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = null;
        }

        this._callWindowResize();
        this._saveHeight();
    }

    _saveHeight() {
        const height = parseInt(getComputedStyle(this.infoPanel).height, 10);
        localStorage.setItem('infoPanelHeight', height);
        store.setState('ui.infoPanelHeight', height);
    }

    _restoreHeight() {
        let savedHeight = store.getState('ui.infoPanelHeight') || localStorage.getItem('infoPanelHeight');
        this._updateHeight(savedHeight ? parseInt(savedHeight, 10) : window.innerHeight * 0.4);
    }

    _initViewToggle() {
        if (!this.viewToggleBtn) return;

        this.viewToggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        this.viewToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._toggleView();
        });
        this.viewToggleBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        this.viewToggleBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._toggleView();
        }, { passive: false });
        this.viewToggleBtn.addEventListener('touchcancel', (e) => e.stopPropagation());
    }

    _toggleView() {
        this.currentView = this.currentView === 'specification' ? 'cutting' : 'specification';
        store.setState('ui.currentView', this.currentView);
        localStorage.setItem('currentView', this.currentView);
        this._showCurrentView();
        this._updateToggleIcon();
    }

    _showCurrentView() {
        document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
        const currentPane = document.getElementById(this.currentView);
        if (currentPane) currentPane.classList.add('active');

        // Только одиночный режим: в мульти-режиме подсветка сбросила бы выбор.
        if (this.currentView === 'specification'
            && !store.getState('specification.multiSelectMode')
            && store.getState('specification.lastSelectedPart')) {
            setTimeout(() => {
                const selectedPart = store.getState('specification.lastSelectedPart');
                document.querySelectorAll('.part-row').forEach(row => {
                    const match = row.getAttribute('data-part-name') === selectedPart;
                    row.classList.toggle('active', match);
                    if (match) SpecificationService.highlightParts(selectedPart, true);
                });
            }, 10);
        }
    }

    _updateToggleIcon() {
        const icon = this.currentView === 'specification' ? 'cut' : 'list-alt';
        this.viewToggleBtn.innerHTML = `<svg><use xlink:href="assets/icons/sprite.svg#${escapeHtml(icon)}"></use></svg>`;
    }

    _restoreViewState() {
        const saved = localStorage.getItem('currentView');
        return (saved === 'specification' || saved === 'cutting') ? saved : 'specification';
    }

    setView(view) {
        if (view === 'specification' || view === 'cutting') {
            this.currentView = view;
            store.setState('ui.currentView', view);
            localStorage.setItem('currentView', view);
            this._showCurrentView();
            this._updateToggleIcon();
        }
    }
}

// ============================================================
// SETTINGS MANAGER
// ============================================================

export const SettingsManager = {
    modal: null,

    init() {
        this.openBtn = document.getElementById('settings-btn');
        if (!this.openBtn) return;

        this._createModal();
        this._bindEvents();
        this._loadSettings();
    },

    _createModal() {
        this.modal = document.createElement('div');
        this.modal.id = 'settings-modal';
        this.modal.className = 'settings-modal';
        this.modal.innerHTML = `
            <div class="settings-modal-content">
                <div class="settings-header">
                    <h2>Настройки</h2>
                    <button class="settings-close" id="settings-close">
                        <svg><use xlink:href="assets/icons/sprite.svg#close"></use></svg>
                    </button>
                </div>
                <div class="settings-body">
                    <div class="settings-section">
                        <h3>Внешний вид</h3>
                        <div class="setting-item">
                            <label for="theme-mode-select">Тема оформления</label>
                            <select id="theme-mode-select">
                                <option value="auto">Авто (системная)</option>
                                <option value="light">Светлая</option>
                                <option value="dark">Тёмная</option>
                            </select>
                        </div>
                    </div>
                    <div class="settings-section">
                        <h3>Плагины</h3>
                        <div id="plugin-settings-table" class="plugin-table"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(this.modal);
    },

    _bindEvents() {
        this.openBtn.addEventListener('click', (e) => { e.preventDefault(); this.open(); });

        const closeBtn = document.getElementById('settings-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.close());

        this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) this.close();
        });

        this._bindSettingsHandlers();
        this._buildPluginAutoList();
    },

    _bindSettingsHandlers() {
        const themeSelect = document.getElementById('theme-mode-select');
        if (themeSelect) {
            themeSelect.addEventListener('change', (e) => {
                this._saveSetting('themeMode', e.target.value);
                this._applyTheme(e.target.value);
            });
        }
    },

    open() {
        this.modal.classList.add('active');
        document.body.classList.add('settings-open');
    },

    close() {
        this.modal.classList.remove('active');
        document.body.classList.remove('settings-open');
    },

    isOpen() {
        return this.modal?.classList.contains('active');
    },

    _loadSettings() {
        const settings = store.getState('ui.settings');
        const themeSelect = document.getElementById('theme-mode-select');
        if (themeSelect && settings?.themeMode) themeSelect.value = settings.themeMode;
    },

    _saveSetting(key, value) {
        const currentSettings = store.getState('ui.settings') || {};
        const settings = { ...currentSettings, [key]: value };
        store.setState('ui.settings', settings);
        localStorage.setItem('uiSettings', JSON.stringify(settings));
    },

    _applyTheme(mode) {
        if (mode === 'auto') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', mode);
        }
    },

    _buildPluginAutoList() {
        const table = document.getElementById('plugin-settings-table');
        if (!table) return;

        // Список плагинов берётся из реестра plugins/registry.js (PluginManager);
        // поле modules показывает привязку (3D / 2D / оба).
        const allPlugins = PluginManager.getAllPlugins();
        if (allPlugins.length === 0) {
            table.innerHTML = `<div class="plugin-table-empty">Нет зарегистрированных плагинов.</div>`;
            return;
        }

        // Стабильный порядок вывода: 3D-плагины, затем 2D, затем кросс-модульные.
        const _rank = (mods) => {
            if (mods.includes('*')) return 3;
            if (mods.length > 1) return 2; // кросс-модульный
            if (mods.includes('2d-viewer')) return 1;
            return 0;
        };
        const knownPlugins = allPlugins
            .map(p => ({
                id: p.id,
                name: p.name,
                description: p.meta?.description || '',
                modules: p.modules || [],
                autoStartDefault: p.meta?.autoStart === true,
            }))
            .sort((a, b) => {
                const ra = _rank(a.modules), rb = _rank(b.modules);
                if (ra !== rb) return ra - rb;
                return a.name.localeCompare(b.name, 'ru');
            });

        const _moduleBadge = (mods) => {
            if (!mods || mods.length === 0) return '<span class="plugin-mod-badge mod-none">нет привязки</span>';
            if (mods.includes('*')) return '<span class="plugin-mod-badge mod-all">все модули</span>';
            return mods.map(m => {
                const label = m === '3d-viewer' ? '3D' : m === '2d-viewer' ? '2D' : m;
                return `<span class="plugin-mod-badge mod-${m}">${label}</span>`;
            }).join('');
        };

        const header = document.createElement('div');
        header.className = 'plugin-table-header';
        header.innerHTML = `
            <span class="plugin-table-name">Плагин</span>
            <div class="plugin-table-checks">
                <span class="plugin-table-col-title">Вкл</span>
                <span class="plugin-table-col-title">Авто</span>
            </div>
        `;
        table.appendChild(header);

        knownPlugins.forEach(p => {
            const isEnabled = PluginManager.isPluginEnabled(p.id);
            const isAutoStart = PluginManager.isPluginAutoStart(p.id);

            const row = document.createElement('div');
            row.className = 'plugin-table-row' + (!isEnabled ? ' disabled' : '');
            row.innerHTML = `
                <span class="plugin-table-name">
                    <span class="plugin-table-name-label">${p.name}</span>
                    <span class="plugin-table-badges">${_moduleBadge(p.modules)}</span>
                    ${p.description ? `<span class="plugin-table-desc">${p.description}</span>` : ''}
                </span>
                <div class="plugin-table-checks">
                    <label class="plugin-table-check" title="Включён">
                        <input type="checkbox" data-plugin-id="${p.id}" data-role="enabled" ${isEnabled ? 'checked' : ''}>
                        <span class="plugin-table-check-visual"></span>
                    </label>
                    <label class="plugin-table-check" title="Автозапуск">
                        <input type="checkbox" data-plugin-id="${p.id}" data-role="autostart" ${isAutoStart ? 'checked' : ''} ${!isEnabled ? 'disabled' : ''}>
                        <span class="plugin-table-check-visual"></span>
                    </label>
                </div>
            `;
            table.appendChild(row);

            const cbEnabled = row.querySelector('[data-role="enabled"]');
            const cbAutostart = row.querySelector('[data-role="autostart"]');

            cbEnabled.addEventListener('change', (e) => {
                e.stopPropagation();
                const enabled = cbEnabled.checked;
                PluginManager.setPluginEnabled(p.id, enabled);
                row.classList.toggle('disabled', !enabled);

                if (!enabled) {
                    cbAutostart.checked = false;
                    cbAutostart.disabled = true;
                    PluginManager.setPluginAutoStart(p.id, false);
                } else {
                    cbAutostart.disabled = false;
                }

                // Применяем ко всем модулям плагина (3D-док и 2D-док сразу).
                if (window._pluginUIController) {
                    window._pluginUIController.togglePluginEnabled(p.id, enabled);
                }
                if (window._pluginUIController2d) {
                    window._pluginUIController2d.togglePluginEnabled(p.id, enabled);
                }
            });

            cbAutostart.addEventListener('change', (e) => {
                e.stopPropagation();
                PluginManager.setPluginAutoStart(p.id, cbAutostart.checked);
            });
        });
    }
};

// ============================================================
// ИНИЦИАЛИЗАЦИЯ (страница проекта)
// ============================================================

// specification.js, cutting.js, 2d-viewer.js загружаются динамически,
// чтобы избежать circular dependencies и не тянуть их в index.html
onReady(() => {
    if (document.getElementById('project-data')) {
        import('./specification.js').then(({ ProjectPage }) => {
            ProjectPage.init();
        });
        FullscreenManager.init();
        window.resizeHandler = new ResizeHandler();
        SettingsManager.init();
        import('./cutting.js').then(({ waitForProjectInitialization }) => {
            waitForProjectInitialization();
        });
        import('./2d-viewer.js').then(({ DrawingViewer }) => {
            if (document.getElementById('toggle-3d-2d-btn')) DrawingViewer.init();
        });
    }
});