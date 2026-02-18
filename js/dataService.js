/**
 * Сервис для работы с данными проектов
 */
export const DataService = {
    /**
     * Загружает все проекты из JSON файла
     * @returns {Promise<Array>} Массив проектов
     */
    async loadProjects() {
        try {
            const response = await fetch('projects.json');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            return data.projects || [];
        } catch (error) {
            console.error('Error loading projects:', error);
            return [];
        }
    },

    /**
     * Загружает данные конкретного проекта
     * @param {string} projectId - ID проекта
     * @returns {Promise<Object|null>} Объект проекта или null
     */
    async loadProjectData(projectId) {
        try {
            const response = await fetch('projects.json');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            const project = data.projects.find(p => p.id === projectId);
            return project || data.projects[0] || null;
        } catch (error) {
            console.error('Error loading project data:', error);
            return null;
        }
    },

    /**
     * Сохраняет выбранный проект в localStorage
     * @param {string} projectId - ID проекта
     */
    setSelectedProject(projectId) {
        localStorage.setItem('selectedProject', projectId);
    },

    /**
     * Получает выбранный проект из localStorage
     * @returns {string|null} ID проекта
     */
    getSelectedProject() {
        return localStorage.getItem('selectedProject');
    }
};