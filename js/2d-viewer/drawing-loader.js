/**
 * Модуль загрузки и управления чертежами
 * Интегрирован с drawingStore
 */

import { drawingStore } from '../store.js';

// Кэш для результатов поиска чертежей
const drawingsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

// Структура кэша: Map<key, {data, timestamp}>
// key: `${projectId}:${designation}`

export const DrawingLoader = {
    currentDrawings: null,

    /**
     * Очищает устаревшие записи в кэше
     */
    cleanupCache() {
        const now = Date.now();
        for (const [key, value] of drawingsCache.entries()) {
            if (now - value.timestamp > CACHE_TTL) {
                drawingsCache.delete(key);
            }
        }
    },

    /**
     * Получает из кэша результаты поиска чертежей
     * @param {string} designation - Обозначение детали
     * @param {string} projectId - ID проекта
     * @returns {Array|null} Массив чертежей или null
     */
    getCachedDrawings(designation, projectId) {
        const key = `${projectId}:${designation}`;
        const cached = drawingsCache.get(key);
        
        if (!cached) return null;
        
        // Проверяем актуальность
        if (Date.now() - cached.timestamp > CACHE_TTL) {
            drawingsCache.delete(key);
            return null;
        }
        
        return cached.data;
    },

    /**
     * Сохраняет результаты поиска чертежей в кэш
     * @param {string} designation - Обозначение детали
     * @param {string} projectId - ID проекта
     * @param {Array} drawings - Массив чертежей
     */
    cacheDrawings(designation, projectId, drawings) {
        const key = `${projectId}:${designation}`;
        drawingsCache.set(key, {
            data: drawings,
            timestamp: Date.now()
        });
    },

    /**
     * Загружает чертежи для детали
     */
    async loadDrawing(designation, projectId) {
        if (!designation || !projectId) {
            console.warn('Cannot load drawing: no designation or project ID');
            return false;
        }

        const cleanDesignation = designation.replace(/:\d+$/, '').trim();
        console.log('🔍 Поиск чертежей для:', cleanDesignation);

        // Проверяем кэш
        const cachedDrawings = this.getCachedDrawings(cleanDesignation, projectId);
        
        if (cachedDrawings !== null) {
            console.log('💾 Чертежи загружены из кэша:', cachedDrawings.length);
            // Используем кэшированные данные
            if (cachedDrawings.length === 0) {
                this.showNoDrawingFound(cleanDesignation);
                drawingStore.setCurrentPart(null);
                this.currentDrawings = null;
                if (window.UIManager) {
                    window.UIManager.removeMultiDrawingControls();
                }
                return false;
            }
            
            // Восстанавливаем из кэша
            drawingStore.setCurrentPart(designation);
            this.currentDrawings = {
                files: cachedDrawings,
                currentIndex: 0,
                designation: cleanDesignation
            };
            
            if (cachedDrawings.length === 1) {
                this.loadSingleDrawing(cachedDrawings[0]);
                if (window.UIManager) {
                    window.UIManager.removeMultiDrawingControls();
                }
            } else {
                this.loadMultipleDrawings(cachedDrawings, cleanDesignation);
                if (window.UIManager) {
                    window.UIManager.createMultiDrawingControls(this);
                }
            }
            return true;
        }

        // Сохраняем текущую деталь в store
        drawingStore.setCurrentPart(designation);

        const drawings = await this.findDrawingsByPattern(cleanDesignation, projectId);
        
        // Кэшируем результат
        this.cacheDrawings(cleanDesignation, projectId, drawings);

        if (drawings.length === 0) {
            this.showNoDrawingFound(cleanDesignation);

            // Очищаем состояние
            drawingStore.setCurrentPart(null);
            this.currentDrawings = null;

            // Удаляем элементы управления
            if (window.UIManager) {
                window.UIManager.removeMultiDrawingControls();
            }

            return false;
        }

        console.log(`✅ Найдено чертежей: ${drawings.length}`, drawings);

        // Сохраняем состояние
        this.currentDrawings = {
            files: drawings,
            currentIndex: 0,
            designation: cleanDesignation
        };

        if (drawings.length === 1) {
            this.loadSingleDrawing(drawings[0]);

            if (window.UIManager) {
                window.UIManager.removeMultiDrawingControls();
            }
        } else {
            this.loadMultipleDrawings(drawings, cleanDesignation);

            if (window.UIManager) {
                window.UIManager.createMultiDrawingControls(this);
            }
        }

        return true;
    },

    /**
     * Ищет чертежи по паттерну
     */
    async findDrawingsByPattern(designation, projectId) {
        const drawings = [];
        let sheetNumber = 1;
        const maxSheets = 10;

        // Базовый чертеж без листа
        const basePath = `models/${projectId}/png/${designation}.png`;
        try {
            const response = await fetch(basePath, { method: 'HEAD' });
            if (response.ok) {
                drawings.push({
                    path: basePath,
                    name: `${designation}.png`,
                    sheetNumber: 1,
                    isBase: true
                });
            }
        } catch (error) {
            // Базовый чертеж не найден
        }

        // Чертежи с листами (с пробелом)
        sheetNumber = 1;
        while (sheetNumber <= maxSheets) {
            const pathWithSheet = `models/${projectId}/png/${designation} Лист-${sheetNumber}.png`;

            try {
                const response = await fetch(pathWithSheet, { method: 'HEAD' });
                if (response.ok && response.status === 200) {
                    drawings.push({
                        path: pathWithSheet,
                        name: `${designation} Лист-${sheetNumber}.png`,
                        sheetNumber: sheetNumber,
                        isBase: false
                    });
                    sheetNumber++;
                } else {
                    // Файл не найден — прекращаем поиск
                    break;
                }
            } catch (error) {
                // Ошибка сети — прекращаем поиск
                break;
            }
        }

        // Альтернативный формат (без пробела) — ищем только если ничего не найдено
        if (drawings.length === 0) {
            sheetNumber = 1;
            while (sheetNumber <= maxSheets) {
                const pathNoSpace = `models/${projectId}/png/${designation}Лист-${sheetNumber}.png`;

                try {
                    const response = await fetch(pathNoSpace, { method: 'HEAD' });
                    if (response.ok && response.status === 200) {
                        drawings.push({
                            path: pathNoSpace,
                            name: `${designation}Лист-${sheetNumber}.png`,
                            sheetNumber: sheetNumber,
                            isBase: false
                        });
                        sheetNumber++;
                    } else {
                        break;
                    }
                } catch (error) {
                    break;
                }
            }
        }

        console.log(`🔎 Найдено чертежей для "${designation}": ${drawings.length}`);
        
        return drawings.sort((a, b) => {
            if (a.isBase && !b.isBase) return -1;
            if (!a.isBase && b.isBase) return 1;
            return a.sheetNumber - b.sheetNumber;
        });
    },

    /**
     * Загружает один чертеж
     */
    loadSingleDrawing(drawing) {
        const imageElement = document.getElementById('drawing-image');
        const placeholder = document.getElementById('drawing-placeholder');

        placeholder.innerHTML = `
            <i class="fas fa-spinner fa-spin"></i>
            <p>Загрузка чертежа...</p>
        `;
        placeholder.style.display = 'block';
        imageElement.style.display = 'none';

        const img = new Image();
        img.onload = () => {
            imageElement.src = img.src;
            imageElement.style.display = 'block';
            placeholder.style.display = 'none';
            console.log('✅ Чертеж загружен:', drawing.name);
        };

        img.onerror = () => {
            placeholder.innerHTML = `
                <i class="fas fa-exclamation-triangle"></i>
                <p>Ошибка загрузки чертежа: ${drawing.name}</p>
            `;
        };

        img.src = drawing.path;
    },

    /**
     * Загружает несколько чертежей
     */
    loadMultipleDrawings(drawings, designation) {
        this.currentDrawings = {
            files: drawings,
            currentIndex: 0,
            designation: designation
        };

        this.loadDrawingFromList(0);
    },

    /**
     * Загружает чертеж из списка по индексу
     */
    loadDrawingFromList(index) {
        if (!this.currentDrawings || !this.currentDrawings.files[index]) {
            return;
        }

        const drawing = this.currentDrawings.files[index];
        const imageElement = document.getElementById('drawing-image');
        const placeholder = document.getElementById('drawing-placeholder');

        placeholder.innerHTML = `
            <i class="fas fa-spinner fa-spin"></i>
            <p>Загрузка листа ${index + 1} из ${this.currentDrawings.files.length}...</p>
        `;
        placeholder.style.display = 'block';
        imageElement.style.display = 'none';

        this.currentDrawings.currentIndex = index;

        const img = new Image();
        img.onload = () => {
            imageElement.src = img.src;
            imageElement.style.display = 'block';
            placeholder.style.display = 'none';
            console.log(`✅ Лист ${index + 1} загружен:`, drawing.name);

            if (window.UIManager) {
                window.UIManager.updateDrawingIndicator(this);
            }
        };

        img.onerror = () => {
            placeholder.innerHTML = `
                <i class="fas fa-exclamation-triangle"></i>
                <p>Ошибка загрузки листа ${index + 1}</p>
            `;
            console.error(`❌ Ошибка загрузки:`, drawing.path);
        };

        img.src = drawing.path;
    },

    /**
     * Показывает сообщение об отсутствии чертежа
     */
    showNoDrawingFound(designation) {
        const placeholder = document.getElementById('drawing-placeholder');
        placeholder.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i>
            <p>Чертеж "${designation}" не найден</p>
        `;
        placeholder.style.display = 'block';

        const imageElement = document.getElementById('drawing-image');
        imageElement.style.display = 'none';
    },

    /**
     * Переключает между чертежами
     */
    switchDrawing(direction) {
        if (!this.currentDrawings) return;

        const { files, currentIndex } = this.currentDrawings;
        const newIndex = (currentIndex + direction + files.length) % files.length;

        this.loadDrawingFromList(newIndex);
    },

    /**
     * Получает текущий индекс чертежа
     */
    getCurrentIndex() {
        return this.currentDrawings?.currentIndex || 0;
    },

    /**
     * Получает количество чертежей
     */
    getDrawingsCount() {
        return this.currentDrawings?.files.length || 0;
    }
};

// Экспортируем для глобального использования
window.DrawingLoader = DrawingLoader;

export default DrawingLoader;
