/**
 * Получает путь к модели из project-data
 * @returns {string} Путь к модели
 */
export function getModelPath() {
    const projectData = document.getElementById('project-data');
    return projectData ? projectData.getAttribute('data-model-path') : '';
}

/**
 * Показывает сообщение об ошибке
 * @param {string} message - Сообщение об ошибке
 */
export function showErrorMessage(message) {
    const container = document.getElementById('model-container');
    if (container) {
        container.innerHTML = `
            <div class="empty-state empty-state--error">
                <i class="fas fa-exclamation-triangle"></i>
                <h3>Ошибка загрузки</h3>
                <p>${message}</p>
            </div>
        `;
    }
}

// Экспортируем для глобального использования
window.showErrorMessage = showErrorMessage;