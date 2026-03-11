/**
 * Сервис для работы с данными проектов
 * С кэшированием и обработкой ошибок
 */

import { store } from './store.js';

// Кэш для проектов
const projectsCache = {
    data: null,
    timestamp: 0,
    ttl: 5 * 60 * 1000 // 5 минут
};

// Флаг загрузки
let isLoadingProjects = false;
let projectsLoadPromise = null;

export const DataService = {
    /**
     * Загружает все проекты из JSON файла с кэшированием
     * @returns {Promise<Array>} Массив проектов
     */
    async loadProjects() {
        // Проверяем кэш
        const now = Date.now();
        if (projectsCache.data && (now - projectsCache.timestamp) < projectsCache.ttl) {
            console.log('Projects loaded from cache');
            return projectsCache.data;
        }

        // Если уже загружается, ждём существующий запрос
        if (isLoadingProjects) {
            return projectsLoadPromise;
        }

        isLoadingProjects = true;
        
        projectsLoadPromise = (async () => {
            try {
                const response = await fetch('projects.json', {
                    headers: {
                        'Cache-Control': 'no-cache'
                    }
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();
                const projects = data.projects || [];
                
                // Обновляем кэш
                projectsCache.data = projects;
                projectsCache.timestamp = now;
                
                console.log('Projects loaded successfully:', projects.length, 'items');
                return projects;
                
            } catch (error) {
                console.error('Error loading projects:', error);
                store.setState('project.error', error.message);
                
                // Возвращаем кэш если есть
                if (projectsCache.data) {
                    console.log('Returning cached projects due to error');
                    return projectsCache.data;
                }
                return [];
            } finally {
                isLoadingProjects = false;
                projectsLoadPromise = null;
            }
        })();

        return projectsLoadPromise;
    },

    /**
     * Загружает данные конкретного проекта
     * @param {string} projectId - ID проекта
     * @returns {Promise<Object|null>} Объект проекта или null
     */
    async loadProjectData(projectId) {
        try {
            const projects = await this.loadProjects();
            
            if (!projectId) {
                console.warn('No project ID provided');
                return projects[0] || null;
            }
            
            const project = projects.find(p => p.id === projectId);
            
            if (!project) {
                console.warn(`Project "${projectId}" not found, using first project`);
                return projects[0] || null;
            }
            
            // Обновляем store
            store.setState('project.data', project);
            store.setState('project.currentId', projectId);
            
            return project;
        } catch (error) {
            console.error('Error loading project data:', error);
            store.setState('project.error', error.message);
            return null;
        }
    },

    /**
     * Сохраняет выбранный проект в localStorage и store
     * @param {string} projectId - ID проекта
     */
    setSelectedProject(projectId) {
        localStorage.setItem('selectedProject', projectId);
        store.setState('project.currentId', projectId);
    },

    /**
     * Получает выбранный проект из localStorage
     * @returns {string|null} ID проекта
     */
    getSelectedProject() {
        // Сначала пробуем из store
        const fromStore = store.getState('project.currentId');
        if (fromStore) {
            return fromStore;
        }

        // Затем из localStorage
        return localStorage.getItem('selectedProject');
    },

    /**
     * Очищает кэш проектов
     */
    clearCache() {
        projectsCache.data = null;
        projectsCache.timestamp = 0;
    },

    /**
     * Проверяет, загружены ли проекты
     * @returns {boolean}
     */
    isProjectsLoaded() {
        return projectsCache.data !== null;
    },

    /**
     * Получает проект из кэша без загрузки
     * @param {string} projectId - ID проекта
     * @returns {Object|null}
     */
    getCachedProject(projectId) {
        if (!projectsCache.data) {
            return null;
        }
        return projectsCache.data.find(p => p.id === projectId);
    }
};