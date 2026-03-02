/**
 * Gallery Module
 * Отвечает за отображение и управление галереей проектов
 */

import { DataService } from './dataService.js';
import { projectStore } from './store.js';

// ============================================================
// Утилиты для работы с DOM
// ============================================================

const DomUtils = {
    /**
     * Создает HTML элемент карточки проекта
     * @param {Object} project - Объект проекта
     * @returns {HTMLElement} Элемент карточки
     */
    createProjectCardElement(project) {
        const card = document.createElement('div');
        card.className = 'model-card';
        card.dataset.id = project.id;

        card.innerHTML = `
            <div class="model-preview no-save">
                <img src="${project.previewImage}" alt="${project.name}"
                     onerror="this.src='https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=400&h=300&fit=crop'">
            </div>

            <div class="model-info">
                <h3>${project.name}</h3>
                <p class="model-description">${project.description}</p>
                <button class="open-model">
                    Открыть
                </button>
            </div>
        `;

        return card;
    },

    /**
     * Рендерит массив проектов в контейнер
     * @param {Array} projects - Массив проектов
     * @param {HTMLElement} container - Контейнер для рендеринга
     */
    renderProjects(projects, container) {
        const fragment = document.createDocumentFragment();

        projects.forEach(project => {
            const card = this.createProjectCardElement(project);
            fragment.appendChild(card);
        });

        container.innerHTML = '';
        container.appendChild(fragment);
    }
};

// ============================================================
// Обработчики событий
// ============================================================

const EventHandlers = {
    /**
     * Обработчик клика по карточке проекта
     * @param {Event} event - Событие клика
     */
    handleCardClick(event) {
        const card = event.currentTarget;
        const projectId = card.dataset.id;

        if (!event.target.closest('.open-model')) {
            Gallery.openProject(projectId);
        }
    },

    /**
     * Обработчик клика по кнопке "Открыть"
     * @param {Event} event - Событие клика
     */
    handleOpenButtonClick(event) {
        event.stopPropagation();
        const card = event.target.closest('.model-card');
        const projectId = card.dataset.id;
        Gallery.openProject(projectId);
    }
};

// ============================================================
// Основной модуль галереи
// ============================================================

export const Gallery = {
    /**
     * Инициализирует галерею
     */
    async init() {
        try {
            const gridContainer = document.getElementById('models-grid');
            if (!gridContainer) {
                console.log('Gallery container not found, skipping initialization');
                return;
            }

            // Загружаем проекты
            const projects = await DataService.loadProjects();

            if (projects.length === 0) {
                this.showNoProjectsMessage();
                return;
            }

            // Рендерим проекты
            DomUtils.renderProjects(projects, gridContainer);

            // Добавляем обработчики событий
            this.addEventListeners();

            console.log('Gallery initialized with', projects.length, 'projects');

        } catch (error) {
            console.error('Error initializing gallery:', error);
            this.showErrorMessage();
        }
    },

    /**
     * Добавляет обработчики событий к элементам галереи
     */
    addEventListeners() {
        // Обработчики для карточек
        document.querySelectorAll('.model-card').forEach(card => {
            card.addEventListener('click', EventHandlers.handleCardClick);
        });

        // Обработчики для кнопок "Открыть"
        document.querySelectorAll('.open-model').forEach(button => {
            button.addEventListener('click', EventHandlers.handleOpenButtonClick);
        });
    },

    /**
     * Открывает проект
     * @param {string} projectId - ID проекта
     */
    openProject(projectId) {
        // Сохраняем в store и localStorage
        DataService.setSelectedProject(projectId);
        window.location.href = 'project.html';
    },

    /**
     * Показывает сообщение об ошибке
     */
    showErrorMessage() {
        const gridContainer = document.getElementById('models-grid');
        if (gridContainer) {
            gridContainer.innerHTML = `
                <div class="error-message" style="
                    grid-column: 1/-1;
                    text-align: center;
                    padding: 40px;
                    color: #666;
                ">
                    <i class="fas fa-exclamation-triangle" style="font-size: 48px; margin-bottom: 20px;"></i>
                    <h3>Не удалось загрузить проекты</h3>
                    <p>Пожалуйста, проверьте подключение к интернету и попробуйте еще раз.</p>
                </div>
            `;
        }
    },

    /**
     * Показывает сообщение когда проектов нет
     */
    showNoProjectsMessage() {
        const gridContainer = document.getElementById('models-grid');
        if (gridContainer) {
            gridContainer.innerHTML = `
                <div class="empty-message" style="
                    grid-column: 1/-1;
                    text-align: center;
                    padding: 40px;
                    color: #666;
                ">
                    <i class="fas fa-folder-open" style="font-size: 48px; margin-bottom: 20px;"></i>
                    <h3>Проекты не найдены</h3>
                    <p>Список проектов пуст.</p>
                </div>
            `;
        }
    },

    /**
     * Обновляет галерею с новыми данными
     * @param {Array} projects - Массив проектов
     */
    update(projects) {
        const gridContainer = document.getElementById('models-grid');
        if (gridContainer) {
            DomUtils.renderProjects(projects, gridContainer);
            this.addEventListeners();
        }
    },

    /**
     * Получает текущие проекты из store
     * @returns {Array|null}
     */
    getProjects() {
        return projectStore.getData();
    }
};

// ============================================================
// Автоматическая инициализация
// ============================================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Gallery.init());
} else {
    Gallery.init();
}

// Экспортируем для внешнего доступа
window.Gallery = Gallery;

export default Gallery;
