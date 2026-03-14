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

                        <div class="setting-item">
                            <label for="model-metalness-range">Металличность: <span id="model-metalness-value">0.1</span></label>
                            <input type="range" id="model-metalness-range" min="0" max="1" step="0.01" value="0.1">
                        </div>

                        <div class="setting-item">
                            <label for="model-roughness-range">Шероховатость: <span id="model-roughness-value">0.75</span></label>
                            <input type="range" id="model-roughness-range" min="0" max="1" step="0.01" value="0.75">
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

        // Металличность
        const metalnessRange = document.getElementById('model-metalness-range');
        const metalnessValue = document.getElementById('model-metalness-value');
        if (metalnessRange && metalnessValue) {
            metalnessRange.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                metalnessValue.textContent = value.toFixed(2);
                this.saveSetting('modelMetalness', value);
                this.applyModelMetalness(value);
            });
        }

        // Шероховатость
        const roughnessRange = document.getElementById('model-roughness-range');
        const roughnessValue = document.getElementById('model-roughness-value');
        if (roughnessRange && roughnessValue) {
            roughnessRange.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                roughnessValue.textContent = value.toFixed(2);
                this.saveSetting('modelRoughness', value);
                this.applyModelRoughness(value);
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

        const metalnessRange = document.getElementById('model-metalness-range');
        const metalnessValue = document.getElementById('model-metalness-value');
        if (metalnessRange && settings.modelMetalness !== undefined) {
            metalnessRange.value = settings.modelMetalness;
            if (metalnessValue) {
                metalnessValue.textContent = parseFloat(settings.modelMetalness).toFixed(2);
            }
        }

        const roughnessRange = document.getElementById('model-roughness-range');
        const roughnessValue = document.getElementById('model-roughness-value');
        if (roughnessRange && settings.modelRoughness !== undefined) {
            roughnessRange.value = settings.modelRoughness;
            if (roughnessValue) {
                roughnessValue.textContent = parseFloat(settings.modelRoughness).toFixed(2);
            }
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

        // Обновляем цвет заглушек сечения
        if (window.ModelCut && typeof window.ModelCut.updateCapColor === 'function') {
            window.ModelCut.updateCapColor();
        }
    },

    applyModelMetalness(value) {
        // Применяем металличность к модели
        if (window.ModelViewer && window.ModelViewer.isModelLoaded()) {
            const model = window.ModelViewer.getModel();
            if (model) {
                model.traverse((child) => {
                    if (child.isMesh && child.material) {
                        child.material.metalness = value;
                    }
                });
            }
        }
    },

    applyModelRoughness(value) {
        // Применяем шероховатость к модели
        if (window.ModelViewer && window.ModelViewer.isModelLoaded()) {
            const model = window.ModelViewer.getModel();
            if (model) {
                model.traverse((child) => {
                    if (child.isMesh && child.material) {
                        child.material.roughness = value;
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

// Применяем тему и настройки модели сразу при загрузке (до инициализации)
(function applySavedSettings() {
    const savedSettings = localStorage.getItem('uiSettings');
    if (savedSettings) {
        try {
            const { themeMode, modelColor, modelMetalness, modelRoughness } = JSON.parse(savedSettings);

            // Применяем тему
            if (themeMode) {
                if (themeMode === 'auto') {
                    document.documentElement.removeAttribute('data-theme');
                } else {
                    document.documentElement.setAttribute('data-theme', themeMode);
                }
            }

            // Применяем цвет модели (после её загрузки)
            if (modelColor && window.ModelViewer && window.ModelViewer.isModelLoaded()) {
                const model = window.ModelViewer.getModel();
                if (model) {
                    model.traverse((child) => {
                        if (child.isMesh && child.material) {
                            child.material.color.set(modelColor);
                        }
                    });
                }
            }

            // Применяем металличность и шероховатость (после загрузки модели)
            if ((modelMetalness !== undefined || modelRoughness !== undefined) &&
                window.ModelViewer && window.ModelViewer.isModelLoaded()) {
                const model = window.ModelViewer.getModel();
                if (model) {
                    model.traverse((child) => {
                        if (child.isMesh && child.material) {
                            if (modelMetalness !== undefined) {
                                child.material.metalness = modelMetalness;
                            }
                            if (modelRoughness !== undefined) {
                                child.material.roughness = modelRoughness;
                            }
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('Failed to apply saved settings:', e);
        }
    }
})();

window.SettingsManager = SettingsManager;
export default SettingsManager;
