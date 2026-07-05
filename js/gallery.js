/**
 * Gallery Module
 * Галерея проектов (страница index.html)
 *
 * Выделено из app.js — содержит:
 * - GalleryDomUtils — создание карточек проектов
 * - Gallery — загрузка, рендер и навигация по проектам
 */

import { DataService, escapeHtml } from './app.js';

// ============================================================
// DOM-утилиты галереи
// ============================================================

const GalleryDomUtils = {
    createProjectCardElement(project) {
        const card = document.createElement('div');
        card.className = 'model-card';
        card.dataset.id = project.id;
        card.innerHTML = `
            <div class="model-preview no-save">
                <img src="${escapeHtml(project.previewImage)}" alt="${escapeHtml(project.name)}"
                     onerror="this.src='https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=400&h=300&fit=crop'">
            </div>
            <div class="model-info">
                <h3>${escapeHtml(project.name)}</h3>
                <p class="model-description">${escapeHtml(project.description)}</p>
                <button class="open-model">Открыть</button>
            </div>
        `;
        return card;
    },

    renderProjects(projects, container) {
        const fragment = document.createDocumentFragment();
        projects.forEach(project => fragment.appendChild(this.createProjectCardElement(project)));
        container.innerHTML = '';
        container.appendChild(fragment);
    }
};

// ============================================================
// Gallery
// ============================================================

const Gallery = {
    async init() {
        try {
            const gridContainer = document.getElementById('models-grid');
            if (!gridContainer) return;

            const projects = await DataService.loadProjects();
            if (projects.length === 0) {
                this._showMessage(gridContainer, 'folder-open', 'Проекты не найдены', 'Список проектов пуст.');
                return;
            }

            GalleryDomUtils.renderProjects(projects, gridContainer);
            this._bindCardEvents(gridContainer);
        } catch (error) {
            console.error('Error initializing gallery:', error);
            const gridContainer = document.getElementById('models-grid');
            if (gridContainer) {
                this._showMessage(gridContainer, 'triangle-exclamation',
                    'Не удалось загрузить проекты',
                    'Пожалуйста, проверьте подключение к интернету и попробуйте еще раз.');
            }
        }
    },

    /**
     * Привязка обработчиков клика к карточкам проектов.
     */
    _bindCardEvents(container) {
        container.querySelectorAll('.model-card').forEach(card => {
            card.addEventListener('click', (e) => {
                this.openProject(card.dataset.id);
            });
        });
    },

    openProject(projectId) {
        DataService.setSelectedProject(projectId);
        window.location.href = 'project.html';
    },

    /** Общий рендер сообщений в галерее (пусто/ошибка/нет проектов) */
    _showMessage(container, icon, title, text) {
        container.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #666;">
                <svg aria-hidden="true" style="width: 52px; height: 52px; fill: #666; margin-bottom: 20px;">
                    <use xlink:href="assets/icons/sprite.svg#${escapeHtml(icon)}"></use>
                </svg>
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(text)}</p>
            </div>
        `;
    },
};

// Автоинициализация на странице галереи
Gallery.init();

export default Gallery;