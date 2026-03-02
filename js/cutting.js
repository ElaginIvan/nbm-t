/**
 * Cutting Calculator Module
 * Отвечает за раскрой материалов с использованием данных из спецификации
 */

import { CuttingService, getProjectId } from './services/cuttingService.js';
import { cuttingStore, specificationStore } from './store.js';

// ============================================================
// Визуализация результатов
// ============================================================

/**
 * Визуализирует результаты раскроя
 */
function visualizeAllResults(allResults, stockLength, kerf, multiplicity) {
    const resultsContainer = document.getElementById('results-container');
    const summaryContainer = document.getElementById('summary-container');

    resultsContainer.innerHTML = '';
    summaryContainer.style.display = 'none';

    if (allResults.size === 0) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-cut"></i>
                <h3>Нет деталей для раскроя</h3>
                <p>Проверьте данные в спецификации</p>
            </div>
        `;
        return;
    }

    let grandTotalWaste = 0;
    let grandTotalStocks = 0;
    let grandTotalParts = 0;

    // Создаем сводку
    const summaryHTML = `
        <div class="summary-header">
            <h3>Сводка раскроя</h3>
            <div class="summary-info">
                <p><strong>Длина заготовки:</strong> ${stockLength} мм</p>
                <p><strong>Ширина реза:</strong> ${kerf} мм</p>
                <p><strong>Кратность:</strong> ${multiplicity}</p>
            </div>
        </div>
    `;

    summaryContainer.innerHTML = summaryHTML;
    summaryContainer.style.display = 'block';

    // Обрабатываем каждый материал
    for (const [materialName, data] of allResults.entries()) {
        const materialSection = document.createElement('section');
        materialSection.className = 'material-section';

        const materialTitle = document.createElement('h2');
        materialTitle.textContent = materialName;
        materialSection.appendChild(materialTitle);

        let materialTotalWaste = 0;
        let materialTotalStocks = 0;
        let materialTotalParts = 0;

        data.plan.forEach((groupData) => {
            const { parts, count } = groupData;
            materialTotalStocks += count;
            materialTotalParts += parts.length * count;

            const stockElement = document.createElement('div');
            stockElement.className = 'cutting-plan-item';

            const title = document.createElement('h3');
            title.textContent = `${materialName} L=${stockLength} мм (${count} шт.)`;
            stockElement.appendChild(title);

            const stockWrapper = document.createElement('div');
            stockWrapper.className = 'stock-wrapper';
            const stockVisual = document.createElement('div');
            stockVisual.className = 'stock';

            // Группируем одинаковые детали
            const groupedParts = [];
            let currentGroup = null;

            for (const part of parts) {
                if (currentGroup && currentGroup.length === part.length) {
                    currentGroup.count++;
                } else {
                    if (currentGroup) groupedParts.push(currentGroup);
                    currentGroup = { length: part.length, count: 1 };
                }
            }
            if (currentGroup) groupedParts.push(currentGroup);

            // Расчет использованной длины
            let usedLengthWithKerf = 0;
            let totalNumberOfParts = 0;

            groupedParts.forEach(group => {
                usedLengthWithKerf += group.length * group.count;
                totalNumberOfParts += group.count;
            });

            // Добавляем резы
            usedLengthWithKerf += totalNumberOfParts * kerf;

            const numberOfGroups = groupedParts.length;

            // Визуализация деталей
            groupedParts.forEach((group, groupIndex) => {
                const groupTotalLength = group.length * group.count;
                const groupCutsLength = group.count * kerf;
                const groupWidth = (groupTotalLength + groupCutsLength) / stockLength * 100;

                const partElement = document.createElement('div');
                partElement.className = 'part';
                partElement.style.width = `${groupWidth}%`;
                partElement.textContent = group.count > 1 ? `${group.length}×${group.count}` : `${group.length}`;
                stockVisual.appendChild(partElement);

                // Визуализация реза между группами
                if (groupIndex < numberOfGroups - 1) {
                    const cutElement = document.createElement('div');
                    cutElement.className = 'cut-visual';
                    cutElement.style.width = `${(kerf / stockLength) * 100}%`;
                    stockVisual.appendChild(cutElement);
                }
            });

            // Остаток (отход)
            const waste = stockLength - usedLengthWithKerf;
            materialTotalWaste += waste * count;

            if (waste > 0) {
                const wasteElement = document.createElement('div');
                wasteElement.className = 'waste';
                wasteElement.style.width = `${(waste / stockLength) * 100}%`;
                wasteElement.textContent = waste > 10 ? `${Math.round(waste)}` : '';
                stockVisual.appendChild(wasteElement);
            }

            stockWrapper.appendChild(stockVisual);
            stockElement.appendChild(stockWrapper);

            const wasteLabel = document.createElement('p');
            wasteLabel.className = 'waste-label';
            wasteLabel.textContent = `Остаток: ${Math.round(waste)} мм`;
            stockWrapper.appendChild(wasteLabel);

            materialSection.appendChild(stockElement);
        });

        // Сводка по материалу
        const materialSummary = document.createElement('div');
        materialSummary.className = 'material-summary';
        materialSummary.innerHTML = `
            <h4>Сводка по ${materialName}</h4>
            <div class="summary-stats">
                <p><strong>Заготовок:</strong> ${materialTotalStocks} шт.</p>
                <p><strong>Деталей:</strong> ${materialTotalParts} шт.</p>
                <p><strong>Общий отход:</strong> ${Math.round(materialTotalWaste)} мм</p>
                <p><strong>Эффективность:</strong> ${Math.round((1 - materialTotalWaste / (materialTotalStocks * stockLength)) * 100)}%</p>
            </div>
        `;
        materialSection.appendChild(materialSummary);
        resultsContainer.appendChild(materialSection);

        // Общая статистика
        grandTotalWaste += materialTotalWaste;
        grandTotalStocks += materialTotalStocks;
        grandTotalParts += materialTotalParts;
    }

    // Общая сводка
    const totalSummary = document.createElement('div');
    totalSummary.className = 'total-summary';
    totalSummary.innerHTML = `
        <h4>Общая статистика</h4>
        <div class="summary-stats">
            <p><strong>Всего заготовок:</strong> ${grandTotalStocks} шт.</p>
            <p><strong>Всего деталей:</strong> ${grandTotalParts} шт.</p>
            <p><strong>Общий отход:</strong> ${Math.round(grandTotalWaste)} мм</p>
            <p><strong>Общая эффективность:</strong> ${Math.round((1 - grandTotalWaste / (grandTotalStocks * stockLength)) * 100)}%</p>
        </div>
    `;
    summaryContainer.appendChild(totalSummary);

    // Прокручиваем к результатам
    resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================
// Инициализация
// ============================================================

/**
 * Инициализация калькулятора раскроя
 */
async function initializeCuttingCalculator() {
    const cutButton = document.getElementById('cutButton');
    const resultsContainer = document.getElementById('results-container');
    const summaryContainer = document.getElementById('summary-container');

    if (!cutButton) {
        console.error('Cut button not found');
        return;
    }

    // Функция для выполнения раскроя
    const performCutting = async () => {
        const stockLengthSelect = document.getElementById('stockLengthSelect');
        const kerfSelect = document.getElementById('kerfSelect');
        const multiplicityInput = document.getElementById('multiplicity');

        const stockLength = parseInt(stockLengthSelect.value);
        const kerf = parseFloat(kerfSelect.value);
        const multiplicity = parseInt(multiplicityInput.value);

        if (isNaN(multiplicity) || multiplicity < 1) {
            alert('Пожалуйста, введите корректное значение кратности (целое число > 0).');
            return;
        }

        // Сохраняем настройки в store
        cuttingStore.updateSetting('stockLength', stockLength);
        cuttingStore.updateSetting('kerf', kerf);
        cuttingStore.updateSetting('multiplicity', multiplicity);

        // Показываем индикатор загрузки
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-spinner fa-spin"></i>
                <h3>Загрузка данных...</h3>
                <p>Пожалуйста, подождите</p>
            </div>
        `;

        // Выполняем раскрой через сервис
        try {
            const results = await CuttingService.performCutting({
                stockLength,
                kerf,
                multiplicity
            });

            if (results.size === 0) {
                resultsContainer.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-exclamation-triangle"></i>
                        <h3>Нет данных для раскроя</h3>
                        <p>Убедитесь, что файл spec.csv содержит данные о материалах в столбце "Описание"</p>
                        <p>Формат материала: "Труба 40х60х2 L=400" или "Лист 1500х2000х4"</p>
                    </div>
                `;
                return;
            }

            visualizeAllResults(results, stockLength, kerf, multiplicity);
        } catch (error) {
            console.error('Error during cutting:', error);
            resultsContainer.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-exclamation-triangle"></i>
                    <h3>Ошибка при раскрое</h3>
                    <p>${error.message}</p>
                </div>
            `;
        }
    };

    // Назначаем обработчик
    cutButton.addEventListener('click', performCutting);

    // Показываем начальное состояние
    resultsContainer.innerHTML = `
        <div class="empty-state">
            <svg>
                <use xlink:href="assets/icons/sprite.svg#cut">
            </use></svg>
            <h3 class="info-start">Готов к работе</h3>
            <p class="info-start">Настройте параметры и нажмите "Раскроить"</p>
        </div>
    `;
}

/**
 * Ожидание инициализации проекта
 */
function waitForProjectInitialization() {
    let checkCount = 0;
    const maxChecks = 30;

    const checkInterval = setInterval(() => {
        checkCount++;

        const projectId = getProjectId();

        if (projectId) {
            clearInterval(checkInterval);
            console.log('Project initialized, ID:', projectId);

            initializeCuttingCalculator().then(() => {
                console.log('Cutting calculator initialized');
            }).catch(error => {
                console.error('Error initializing cutting calculator:', error);
            });
        } else if (checkCount >= maxChecks) {
            clearInterval(checkInterval);
            console.warn('Project initialization timeout');

            const resultsContainer = document.getElementById('results-container');
            if (resultsContainer) {
                resultsContainer.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-exclamation-triangle"></i>
                        <h3>Не удалось определить проект</h3>
                        <p>Пожалуйста, перезагрузите страницу или вернитесь на главную страницу</p>
                        <a href="index.html" class="cut-btn" style="margin-top: 20px; display: inline-block;">
                            Вернуться на главную
                        </a>
                    </div>
                `;
            }
        } else {
            console.log(`Waiting for project initialization... (${checkCount}/${maxChecks})`);
        }
    }, 500);
}

/**
 * Инициализация страницы раскроя
 */
function initCuttingPage() {
    console.log('Initializing cutting page...');
    waitForProjectInitialization();
}

// Запускаем инициализацию при загрузке
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCuttingPage);
} else {
    initCuttingPage();
}

// Экспортируем для внешнего доступа
window.CuttingService = CuttingService;

export default {
    initializeCuttingCalculator,
    performCutting: CuttingService.performCutting,
    getSettings: CuttingService.getSettings
};
