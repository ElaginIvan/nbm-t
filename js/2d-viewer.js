/**
 * 2D Viewer Module
 * Просмотр 2D чертежей
 *
 * Содержит:
 * - ZoomManager (зум и панорамирование)
 * - UIManager (переключение 3D/2D, управление навигацией по листам)
 * - DrawingLoader (загрузка чертежей с кэшированием)
 * - InputHandlers (мышь, тач, колесо)
 * - DrawingViewer (главный модуль)
 */

import { store, getProjectId, escapeHtml } from './app.js';
import PluginManager from './plugin-system.js';

// ============================================================
// ZOOM MANAGER
// ============================================================

const ZoomManager = {
    zoomLevel: 1,
    minZoom: 0.1,
    maxZoom: 10,
    imagePos: { x: 0, y: 0 },

    resetZoom() {
        this.zoomLevel = 1;
        this.imagePos = { x: 0, y: 0 };
        this.applyZoom();
    },

    applyZoom() {
        const img = document.getElementById('drawing-image');
        if (!img) return;
        img.style.transformOrigin = '0 0';
        img.style.transform = `translate(${this.imagePos.x}px, ${this.imagePos.y}px) scale(${this.zoomLevel})`;
    }
};

// ============================================================
// UI MANAGER
// ============================================================

const UIManager = {
    updateView(mode) {
        const modelContainer = document.getElementById('model-container');
        const drawingContainer = document.getElementById('drawing-container');
        const imageElement = document.getElementById('drawing-image');
        const placeholder = document.getElementById('drawing-placeholder');

        if (mode === '3D') {
            if (modelContainer) { modelContainer.classList.add('active'); modelContainer.classList.remove('disabled'); }
            if (drawingContainer) drawingContainer.classList.remove('active');
        } else {
            if (modelContainer) modelContainer.classList.remove('active');
            if (drawingContainer) drawingContainer.classList.add('active');

            if (imageElement && placeholder) {
                const hasImage = imageElement.src && imageElement.src !== window.location.href;
                imageElement.style.display = hasImage ? 'block' : 'none';
                placeholder.style.display = hasImage ? 'none' : 'block';
            }
        }
        store.setState('ui.currentMode', mode);
    },

    updateToggleButton(mode) {
        const btn = document.getElementById('toggle-3d-2d-btn');
        if (!btn) return;
        const icon = mode === '3D' ? 'image' : 'cube';
        btn.innerHTML = `<svg class="icon" aria-hidden="true"><use xlink:href="assets/icons/sprite.svg#${escapeHtml(icon)}"></use></svg>`;
    },

    createMultiDrawingControls(drawingLoader) {
        const controls = document.querySelector('.drawing-controls');
        if (!controls) return;
        this.removeMultiDrawingControls();

        const prevBtn = document.createElement('button');
        prevBtn.className = 'drawing-btn prev-drawing';
        prevBtn.title = 'Предыдущий лист';
        prevBtn.innerHTML = '<svg><use xlink:href="assets/icons/sprite.svg#chevron-left"></use></svg>';
        controls.appendChild(prevBtn);

        const indicator = document.createElement('div');
        indicator.className = 'drawing-indicator';
        indicator.innerHTML = '<span class="current-sheet">1</span> / <span class="total-sheets">1</span>';
        controls.appendChild(indicator);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'drawing-btn next-drawing';
        nextBtn.title = 'Следующий лист';
        nextBtn.innerHTML = '<svg><use xlink:href="assets/icons/sprite.svg#chevron-right"></use></svg>';
        controls.appendChild(nextBtn);

        prevBtn.addEventListener('click', () => drawingLoader.switchDrawing(-1));
        nextBtn.addEventListener('click', () => drawingLoader.switchDrawing(1));
        this.updateDrawingIndicator(drawingLoader);
    },

    removeMultiDrawingControls() {
        const controls = document.querySelector('.drawing-controls');
        if (!controls) return;
        const prevBtn = controls.querySelector('.prev-drawing');
        const nextBtn = controls.querySelector('.next-drawing');
        const indicator = controls.querySelector('.drawing-indicator');
        if (prevBtn) prevBtn.remove();
        if (nextBtn) nextBtn.remove();
        if (indicator) indicator.remove();
    },

    updateDrawingIndicator(drawingLoader) {
        const loader = drawingLoader || window.DrawingLoader;
        if (!loader || !loader.currentDrawings) return;
        const { files, currentIndex } = loader.currentDrawings;
        const currentEl = document.querySelector('.current-sheet');
        const totalEl = document.querySelector('.total-sheets');
        const prevBtn = document.querySelector('.prev-drawing');
        const nextBtn = document.querySelector('.next-drawing');
        if (currentEl) currentEl.textContent = currentIndex + 1;
        if (totalEl) totalEl.textContent = files.length;
        if (files.length <= 1) {
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
        } else {
            if (prevBtn) prevBtn.style.display = 'flex';
            if (nextBtn) nextBtn.style.display = 'flex';
        }
    }
};

// ============================================================
// DRAWING LOADER
// ============================================================

const drawingsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

const DrawingLoader = {
    currentDrawings: null,

    getCachedDrawings(designation, projectId) {
        const key = `${projectId}:${designation}`;
        const cached = drawingsCache.get(key);
        if (!cached) return null;
        if (Date.now() - cached.timestamp > CACHE_TTL) { drawingsCache.delete(key); return null; }
        return cached.data;
    },

    cacheDrawings(designation, projectId, drawings) {
        drawingsCache.set(`${projectId}:${designation}`, { data: drawings, timestamp: Date.now() });
    },

    async loadDrawing(designation, projectId) {
        if (!designation || !projectId) return false;
        const cleanDesignation = designation.replace(/:\d+$/, '').trim();

        let drawings = this.getCachedDrawings(cleanDesignation, projectId);
        if (drawings === null) {
            drawings = await this.findDrawingsByPattern(cleanDesignation, projectId);
            this.cacheDrawings(cleanDesignation, projectId, drawings);
        }

        if (drawings.length === 0) {
            this.showNoDrawingFound(cleanDesignation);
            store.setState('drawing.currentPart', null);
            this.currentDrawings = null;
            UIManager.removeMultiDrawingControls();
            return false;
        }

        store.setState('drawing.currentPart', designation);
        this.currentDrawings = { files: drawings, currentIndex: 0, designation: cleanDesignation };
        if (drawings.length === 1) {
            this.loadSingleDrawing(drawings[0]);
            UIManager.removeMultiDrawingControls();
        } else {
            this.loadMultipleDrawings(drawings, cleanDesignation);
            UIManager.createMultiDrawingControls(this);
        }
        return true;
    },

    async findDrawingsByPattern(designation, projectId) {
        const drawings = [];
        const maxSheets = 10;

        const project = store.getState('project.data');
        const drawingsDir = project.drawingsPath;

        const basePath = `${drawingsDir}/${designation}.avif`;
        try {
            const response = await fetch(basePath, { method: 'HEAD' });
            if (response.ok) {
                drawings.push({ path: basePath, name: `${designation}.avif`, sheetNumber: 1, isBase: true });
            }
        } catch (e) { /* не найден */ }

        for (let sheetNumber = 1; sheetNumber <= maxSheets; sheetNumber++) {
            const pathWithSheet = `${drawingsDir}/${designation} Лист-${sheetNumber}.avif`;
            try {
                const response = await fetch(pathWithSheet, { method: 'HEAD' });
                if (response.ok) {
                    drawings.push({ path: pathWithSheet, name: `${designation} Лист-${sheetNumber}.avif`, sheetNumber, isBase: false });
                } else {
                    break;
                }
            } catch (e) { break; }
        }

        if (drawings.length === 0) {
            for (let sheetNumber = 1; sheetNumber <= maxSheets; sheetNumber++) {
                const pathNoSpace = `${drawingsDir}/${designation}Лист-${sheetNumber}.avif`;
                try {
                    const response = await fetch(pathNoSpace, { method: 'HEAD' });
                    if (response.ok) {
                        drawings.push({ path: pathNoSpace, name: `${designation}Лист-${sheetNumber}.avif`, sheetNumber, isBase: false });
                    } else {
                        break;
                    }
                } catch (e) { break; }
            }
        }

        return drawings.sort((a, b) => {
            if (a.isBase && !b.isBase) return -1;
            if (!a.isBase && b.isBase) return 1;
            return a.sheetNumber - b.sheetNumber;
        });
    },

    loadSingleDrawing(drawing) {
        const imageElement = document.getElementById('drawing-image');
        const placeholder = document.getElementById('drawing-placeholder');
        if (!imageElement || !placeholder) return;

        placeholder.innerHTML = `
            <svg class="icon icon--spin" aria-hidden="true">
                <use xlink:href="assets/icons/sprite.svg#spinner"></use>
            </svg>
            <p>Загрузка чертежа...</p>`;
        placeholder.style.display = 'block';
        imageElement.style.display = 'none';

        const img = new Image();
        img.onload = () => {
            imageElement.src = img.src;
            imageElement.style.display = 'block';
            placeholder.style.display = 'none';
        };
        img.onerror = () => {
            placeholder.innerHTML = `
            <svg class="icon icon--warning" aria-hidden="true">
                <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
            </svg>
            <p>Ошибка загрузки чертежа: ${escapeHtml(drawing.name)}</p>`;
        };
        img.src = drawing.path;
    },

    loadMultipleDrawings(drawings, designation) {
        this.currentDrawings = { files: drawings, currentIndex: 0, designation };
        this.loadDrawingFromList(0);
    },

    loadDrawingFromList(index) {
        if (!this.currentDrawings || !this.currentDrawings.files[index]) return;
        const drawing = this.currentDrawings.files[index];
        const imageElement = document.getElementById('drawing-image');
        const placeholder = document.getElementById('drawing-placeholder');
        if (!imageElement || !placeholder) return;

        placeholder.innerHTML = `
        <svg class="icon icon--spin" aria-hidden="true">
            <use xlink:href="assets/icons/sprite.svg#spinner"></use>
        </svg>
        <p>Загрузка листа ${index + 1} из ${this.currentDrawings.files.length}...</p>`;
        placeholder.style.display = 'block';
        imageElement.style.display = 'none';
        this.currentDrawings.currentIndex = index;

        const img = new Image();
        img.onload = () => {
            imageElement.src = img.src;
            imageElement.style.display = 'block';
            placeholder.style.display = 'none';
            UIManager.updateDrawingIndicator(this);
        };
        img.onerror = () => {
            placeholder.innerHTML = `
            <svg class="icon icon--warning" aria-hidden="true">
                <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
            </svg>
            <p>Ошибка загрузки листа ${index + 1}</p>`;
        };
        img.src = drawing.path;
    },

    showNoDrawingFound(designation) {
        const placeholder = document.getElementById('drawing-placeholder');
        const imageElement = document.getElementById('drawing-image');
        if (placeholder) {
            placeholder.innerHTML = `
            <svg class="icon icon--warning" aria-hidden="true">
                <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
            </svg>
            <p>Чертеж "${escapeHtml(designation)}" не найден</p>`;
            placeholder.style.display = 'block';
        }
        if (imageElement) imageElement.style.display = 'none';
    },

    switchDrawing(direction) {
        if (!this.currentDrawings) return;
        const { files, currentIndex } = this.currentDrawings;
        const newIndex = (currentIndex + direction + files.length) % files.length;
        this.loadDrawingFromList(newIndex);
    }
};
window.DrawingLoader = DrawingLoader;

// ============================================================
// INPUT HANDLERS
// ============================================================

const InputHandlers = {
    isDragging: false,
    isZooming: false,
    dragStart: { x: 0, y: 0 },
    initialDistance: null,
    initialZoom: 1,

    initMouseHandlers(drawingViewer, zoomManager) {
        const imageElement = document.getElementById('drawing-image');
        const drawingWrapper = document.querySelector('.drawing-wrapper');

        if (imageElement) {
            imageElement.addEventListener('mousedown', (e) => this.handleMouseDown(e, zoomManager));
            imageElement.addEventListener('dblclick', (e) => this.handleDoubleClick(e, zoomManager));
        }
        if (drawingWrapper) {
            drawingWrapper.addEventListener('mousedown', (e) => {
                if (e.target === drawingWrapper) this.handleMouseDown(e, zoomManager);
            });
            drawingWrapper.addEventListener('dblclick', (e) => this.handleDoubleClick(e, zoomManager));
        }

        document.addEventListener('mouseup', () => this.handleMouseUp());
        document.addEventListener('mousemove', (e) => this.handleMouseMove(e, zoomManager));

        const drawingContainer = document.getElementById('drawing-container');
        if (drawingContainer) {
            drawingContainer.addEventListener('wheel', (e) => this.handleWheel(e, zoomManager), { passive: false });
        }
    },

    initTouchHandlers(drawingViewer, zoomManager) {
        const drawingWrapper = document.querySelector('.drawing-wrapper');
        if (!drawingWrapper) return;
        drawingWrapper.addEventListener('touchstart', (e) => this.handleTouchStart(e, zoomManager), { passive: true });
        drawingWrapper.addEventListener('touchmove', (e) => this.handleTouchMove(e, zoomManager), { passive: true });
        drawingWrapper.addEventListener('touchend', (e) => this.handleTouchEnd(e, zoomManager));
    },

    handleMouseDown(e, zoomManager) {
        if (store.getState('ui.currentMode') !== '2D') return;
        e.preventDefault(); e.stopPropagation();
        this.isDragging = true;
        this.dragStart.x = e.clientX - zoomManager.imagePos.x;
        this.dragStart.y = e.clientY - zoomManager.imagePos.y;
        const img = document.getElementById('drawing-image');
        const wrapper = document.querySelector('.drawing-wrapper');
        if (img) { img.style.cursor = 'grabbing'; img.classList.add('dragging'); }
        if (wrapper) wrapper.style.cursor = 'grabbing';
    },

    handleMouseMove(e, zoomManager) {
        if (!this.isDragging) return;
        e.preventDefault(); e.stopPropagation();
        zoomManager.imagePos.x = e.clientX - this.dragStart.x;
        zoomManager.imagePos.y = e.clientY - this.dragStart.y;
        zoomManager.applyZoom();
    },

    handleMouseUp() {
        if (!this.isDragging) return;
        this.isDragging = false;
        const img = document.getElementById('drawing-image');
        const wrapper = document.querySelector('.drawing-wrapper');
        if (img) { img.style.cursor = 'grab'; img.classList.remove('dragging'); }
        if (wrapper) wrapper.style.cursor = 'default';
    },

    handleWheel(e, zoomManager) {
        if (store.getState('ui.currentMode') !== '2D') return;
        e.preventDefault(); e.stopPropagation();

        const drawingContainer = document.getElementById('drawing-container');
        if (!drawingContainer) return;

        const delta = Math.sign(e.deltaY);
        const zoomFactor = delta > 0 ? 0.9 : 1.1;
        const rect = drawingContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const oldZoom = zoomManager.zoomLevel;
        const newZoom = Math.max(zoomManager.minZoom, Math.min(zoomManager.maxZoom, oldZoom * zoomFactor));
        if (newZoom === oldZoom) return;

        // Точка под курсором должна оставаться на месте после зума.
        // При transform-origin: 0 0 и transform: translate(imagePos) scale(zoom):
        //   screen_pos = imagePos + zoom * local_pos
        // Чтобы точка P_local осталась под (mouseX, mouseY):
        //   newImagePos = mouse - (newZoom/oldZoom) * (mouse - oldImagePos)
        const k = newZoom / oldZoom;
        zoomManager.imagePos.x = mouseX - k * (mouseX - zoomManager.imagePos.x);
        zoomManager.imagePos.y = mouseY - k * (mouseY - zoomManager.imagePos.y);
        zoomManager.zoomLevel = newZoom;
        zoomManager.applyZoom();
    },

    handleTouchStart(e, zoomManager) {
        if (store.getState('ui.currentMode') !== '2D') return;
        if (e.touches.length === 2) {
            e.preventDefault(); e.stopPropagation();
            this.isZooming = true; this.isDragging = false;
            this.initialDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
            this.initialZoom = zoomManager.zoomLevel;
            this.dragStart.x = (e.touches[0].clientX + e.touches[1].clientX) / 2 - zoomManager.imagePos.x;
            this.dragStart.y = (e.touches[0].clientY + e.touches[1].clientY) / 2 - zoomManager.imagePos.y;
        } else if (e.touches.length === 1) {
            e.preventDefault(); e.stopPropagation();
            this.isDragging = true; this.isZooming = false;
            this.dragStart.x = e.touches[0].clientX - zoomManager.imagePos.x;
            this.dragStart.y = e.touches[0].clientY - zoomManager.imagePos.y;
            const img = document.getElementById('drawing-image');
            if (img) img.classList.add('dragging');
        }
    },

    handleTouchMove(e, zoomManager) {
        if (store.getState('ui.currentMode') !== '2D') return;
        if (this.isZooming && e.touches.length === 2) {
            e.preventDefault(); e.stopPropagation();
            const currentDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
            if (this.initialDistance) {
                const scaleFactor = currentDistance / this.initialDistance;
                const oldZoom = zoomManager.zoomLevel;
                const newZoomLevel = Math.max(zoomManager.minZoom, Math.min(zoomManager.maxZoom, this.initialZoom * scaleFactor));
                if (newZoomLevel === oldZoom) return;

                // Точка между пальцами должна оставаться на месте после зума.
                // См. комментарий в handleWheel для формулы.
                const drawingContainer = document.getElementById('drawing-container');
                if (!drawingContainer) return;
                const rect = drawingContainer.getBoundingClientRect();
                const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
                const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
                const k = newZoomLevel / oldZoom;
                zoomManager.imagePos.x = centerX - k * (centerX - zoomManager.imagePos.x);
                zoomManager.imagePos.y = centerY - k * (centerY - zoomManager.imagePos.y);
                zoomManager.zoomLevel = newZoomLevel;
                zoomManager.applyZoom();
            }
        } else if (this.isDragging && e.touches.length === 1) {
            e.preventDefault(); e.stopPropagation();
            zoomManager.imagePos.x = e.touches[0].clientX - this.dragStart.x;
            zoomManager.imagePos.y = e.touches[0].clientY - this.dragStart.y;
            zoomManager.applyZoom();
        }
    },

    handleTouchEnd(e, zoomManager) {
        if (this.isZooming) { this.isZooming = false; this.initialDistance = null; this.initialZoom = 1; }
        if (this.isDragging) {
            this.isDragging = false;
            const img = document.getElementById('drawing-image');
            if (img) img.classList.remove('dragging');
        }
        if (e.touches.length === 0) { this.isDragging = false; this.isZooming = false; }
    },

    handleDoubleClick(e, zoomManager) {
        if (store.getState('ui.currentMode') !== '2D') return;
        e.preventDefault(); e.stopPropagation();
        zoomManager.resetZoom();
    },

    getTouchDistance(touch1, touch2) {
        const dx = touch2.clientX - touch1.clientX;
        const dy = touch2.clientY - touch1.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }
};

// ============================================================
// DRAWING VIEWER
// ============================================================

const DrawingViewer = {
    _pluginUI: null,

    init() {
        this._setupCursors();
        this._bindEvents();
        UIManager.updateToggleButton(store.getState('ui.currentMode') || '3D');
        this._initPluginSystem();
    },

    _initPluginSystem() {
        const container = document.getElementById('drawing-container');
        if (!container) return;

        const computed = getComputedStyle(container);
        if (computed.position === 'static') {
            container.style.position = 'relative';
        }

        PluginManager.registerModuleAPI('2d-viewer', {
            get container() { return document.getElementById('drawing-container'); },
            get imageElement() { return document.getElementById('drawing-image'); },
            get zoomManager() { return ZoomManager; },
            get drawingLoader() { return DrawingLoader; },
            get store() { return store; },
        });

        this._pluginUI = PluginManager.initUI(container, '2d-viewer');
    },

    _setupCursors() {
        const img = document.getElementById('drawing-image');
        const wrapper = document.querySelector('.drawing-wrapper');
        if (img) img.style.cursor = 'grab';
        if (wrapper) wrapper.style.cursor = 'default';
    },

    _bindEvents() {
        const toggleBtn = document.getElementById('toggle-3d-2d-btn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => { e.preventDefault(); this._toggleMode(); });
        }
        InputHandlers.initMouseHandlers(this, ZoomManager);
        InputHandlers.initTouchHandlers(this, ZoomManager);
    },

    _toggleMode() {
        const oldMode = store.getState('ui.currentMode') || '3D';
        const newMode = oldMode === '3D' ? '2D' : '3D';

        store.setState('ui.currentMode', newMode);
        UIManager.updateView(newMode);
        UIManager.updateToggleButton(newMode);
        this._setupCursors();

        document.dispatchEvent(new CustomEvent('viewModeChanged', { detail: { mode: newMode, oldMode } }));

        if (newMode === '2D') {
            let activeRow = document.querySelector('.part-row.active');
            if (!activeRow) {
                activeRow = document.querySelector('.part-row');
                if (activeRow) {
                    document.querySelectorAll('.part-row').forEach(r => r.classList.remove('active'));
                    activeRow.classList.add('active');
                    const partName = activeRow.getAttribute('data-part-name');
                    if (window.SpecificationService) window.SpecificationService.highlightParts(partName, true);
                }
            }
            if (activeRow) {
                this.loadDrawing(activeRow.getAttribute('data-part-name'));
            }
        }

        if (typeof window.onWindowResize === 'function') {
            setTimeout(() => { try { window.onWindowResize(); } catch (e) { /* ignore */ } }, 50);
        }
    },

    async loadDrawing(designation) {
        const projectId = document.getElementById('project-data')?.getAttribute('data-project-id');
        if (!projectId) return false;

        const success = await DrawingLoader.loadDrawing(designation, projectId);

        if (success && DrawingLoader.currentDrawings?.files.length > 1) {
            UIManager.createMultiDrawingControls(DrawingLoader);
        } else {
            UIManager.removeMultiDrawingControls();
        }

        ZoomManager.resetZoom();
        return success;
    },

};

window.DrawingViewer = DrawingViewer;

// ============================================================
// ЭКСПОРТ
// ============================================================

export { DrawingViewer, ZoomManager, DrawingLoader, UIManager };