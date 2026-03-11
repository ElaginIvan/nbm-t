/**
 * Settings Manager Module
 * Отвечает за открытие/закрытие окна настроек
 */

import { store } from './store.js';

export const SettingsManager = {
    modal: null,
    openBtn: null,
    closeBtn: null,

    init() {
        this.openBtn = document.getElementById('settings-btn');
        if (!this.openBtn) {
            console.warn('Settings button not found');
            return;
        }

        this.createModal();
        this.bindEvents();
        this.loadSettings();
        this.applyTheme(store.getState('ui.settings.themeMode'));
        console.log('Settings manager initialized');
    },

    createModal() {
        // Создаём модальное окно
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
                    <!-- Настройки темы -->
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

                    <!-- Настройки 3D модели -->
                    <div class="settings-section">
                        <h3>3D Модель</h3>

                        <div class="setting-item">
                            <label for="model-color-picker">Цвет модели</label>
                            <input type="color" id="model-color-picker" value="#CCCCCC">
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(this.modal);
    },

    bindEvents() {
        // Открытие
        this.openBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.open();
        });

        // Закрытие по крестику
        this.closeBtn = document.getElementById('settings-close');
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.close());
        }

        // Закрытие по клику вне окна
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.close();
            }
        });

        // Закрытие по ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) {
                this.close();
            }
        });

        // Обработчики настроек
        this.bindSettingsHandlers();
    },

    bindSettingsHandlers() {
        // Тема оформления
        const themeSelect = document.getElementById('theme-mode-select');
        if (themeSelect) {
            themeSelect.addEventListener('change', (e) => {
                this.saveSetting('themeMode', e.target.value);
                this.applyTheme(e.target.value);
            });
        }

        // Цвет модели
        const colorPicker = document.getElementById('model-color-picker');
        if (colorPicker) {
            colorPicker.addEventListener('input', (e) => {
                this.saveSetting('modelColor', e.target.value);
                this.applyModelColor(e.target.value);
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
        return this.modal.classList.contains('active');
    },

    loadSettings() {
        const settings = store.getState('ui.settings');

        // Загружаем значения в форму
        const themeSelect = document.getElementById('theme-mode-select');
        if (themeSelect && settings.themeMode) {
            themeSelect.value = settings.themeMode;
        }

        const colorPicker = document.getElementById('model-color-picker');
        if (colorPicker && settings.modelColor) {
            colorPicker.value = settings.modelColor;
        }
    },

    saveSetting(key, value) {
        const settings = store.getState('ui.settings') || {};
        settings[key] = value;
        store.setState('ui.settings', settings);
        localStorage.setItem('uiSettings', JSON.stringify(settings));
        console.log(`Setting saved: ${key} = ${value}`);
    },

    applyTheme(mode) {
        // Применяем тему через data-атрибут
        if (mode === 'auto') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', mode);
        }
    },

    applyModelColor(color) {
        // Применяем цвет к модели через ModelViewer
        if (window.ModelViewer && window.ModelViewer.isModelLoaded()) {
            const model = window.ModelViewer.getModel();
            if (model) {
                model.traverse((child) => {
                    if (child.isMesh && child.material) {
                        child.material.color.set(color);
                    }
                });
            }
        }
    },
};

// Автоматическая инициализация
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SettingsManager.init());
} else {
    SettingsManager.init();
}

// Применяем тему сразу при загрузке (до инициализации)
(function applySavedTheme() {
    const savedSettings = localStorage.getItem('uiSettings');
    if (savedSettings) {
        try {
            const { themeMode } = JSON.parse(savedSettings);
            if (themeMode) {
                if (themeMode === 'auto') {
                    document.documentElement.removeAttribute('data-theme');
                } else {
                    document.documentElement.setAttribute('data-theme', themeMode);
                }
            }
        } catch (e) {
            console.warn('Failed to apply saved theme:', e);
        }
    }
})();

window.SettingsManager = SettingsManager;
export default SettingsManager;
