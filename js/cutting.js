/**
 * Cutting Module
 * Раскрой материалов
 *
 * Содержит:
 * - CuttingService (загрузка данных, выполнение раскроя)
 * - CuttingCalculator (UI: кнопка, визуализация результатов)
 */

import { store, escapeHtml, getProjectId, decodeCSV, parseCSV } from './app.js';
import { SpecificationService } from './specification.js';

// ============================================================
// CUTTING SERVICE
// ============================================================

function parseMaterialString(materialString) {
    if (!materialString) return null;
    const match = materialString.match(/^(.*?)\s*L\s*=\s*(\d+\.?\d*)\s*$/i);
    if (match) return { type: match[1].trim(), length: parseFloat(match[2]) };
    return { type: materialString.trim(), length: null };
}

function groupMaterialsByType(csvData, modelStructure) {
    const materialsMap = new Map();
    const quantityMap = new Map();
    modelStructure.forEach(item => {
        if (!item.name) return;
        const cleanItemName = item.name.trim();
        const quantity = item.instanceCount || 1;
        quantityMap.set(cleanItemName, quantity);
        const parts = cleanItemName.split(/[-_.]/);
        if (parts.length > 1) {
            const baseName = parts[0] + '.' + parts[1];
            if (baseName !== cleanItemName) {
                quantityMap.set(baseName, (quantityMap.get(baseName) || 0) + quantity);
            }
        }
        const match = cleanItemName.match(/^([A-ZА-ЯЁ]+-\d+\.\d+)/);
        if (match && match[1] !== cleanItemName) {
            quantityMap.set(match[1], (quantityMap.get(match[1]) || 0) + quantity);
        }
    });
    csvData.forEach((row) => {
        const designation = row['Обозначение'];
        const material = row['Описание'];
        if (!designation || !material) return;
        const parsedMaterial = parseMaterialString(material);
        if (!parsedMaterial || !parsedMaterial.type || parsedMaterial.length === null) return;
        let quantity = 1;
        const parts = designation.split('-');
        const baseKey = parts.length >= 2 && parts[1]
            ? parts[0] + '.' + parts[1].split('.')[0]
            : null;
        const searchKeys = [
            designation,
            designation.replace(/-\d+$/, ''),
            designation.match(/^([A-ZА-ЯЁ]+-\d+\.\d+)/)?.[1],
            baseKey
        ].filter(Boolean);
        for (const key of searchKeys) {
            if (quantityMap.has(key)) { quantity = quantityMap.get(key); break; }
        }
        if (quantity === 1) {
            const csvQuantity = parseInt(row['КОЛ.']) || parseInt(row['Кол.']) || parseInt(row['Количество']) || 1;
            quantity = csvQuantity;
        }
        if (quantity <= 0) return;
        const key = parsedMaterial.type;
        const length = parsedMaterial.length;
        if (!materialsMap.has(key)) materialsMap.set(key, []);
        for (let i = 0; i < quantity; i++) materialsMap.get(key).push({ length });
    });
    const result = {};
    materialsMap.forEach((parts, materialType) => {
        const groupedParts = {};
        parts.forEach(part => {
            const lengthKey = part.length.toString();
            if (!groupedParts[lengthKey]) groupedParts[lengthKey] = { length: part.length, quantity: 0 };
            groupedParts[lengthKey].quantity++;
        });
        result[materialType] = Object.values(groupedParts);
    });
    return result;
}

export const CuttingService = {
    async loadCuttingData() {
        try {
            store.setState('cutting.isLoading', true);
            const projectId = getProjectId();
            if (!projectId) return {};
            const csvPath = `models/${projectId}/spec.csv`;
            const response = await fetch(csvPath);
            if (!response.ok) return {};
            const buffer = await response.arrayBuffer();
            const csvText = decodeCSV(buffer);
            const csvData = parseCSV(csvText);
            const modelStructure = store.getState('specification.structure') || [];
            const materialsData = groupMaterialsByType(csvData, modelStructure);
            store.setState('cutting.materialsData', materialsData);
            return materialsData;
        } catch (error) {
            console.error('Error loading cutting data:', error);
            return {};
        } finally {
            store.setState('cutting.isLoading', false);
        }
    },

    async performCutting(options = {}) {
        const { stockLength = 6000, kerf = 0, multiplicity = 1 } = options;
        let materialsData = store.getState('cutting.materialsData');
        if (Object.keys(materialsData).length === 0) materialsData = await this.loadCuttingData();
        if (Object.keys(materialsData).length === 0) return new Map();
        const allResults = new Map();
        for (const [materialName, parts] of Object.entries(materialsData)) {
            const partsToCut = [];
            for (const item of parts) {
                if (item.length > stockLength) continue;
                const totalQuantity = item.quantity * multiplicity;
                for (let i = 0; i < totalQuantity; i++) partsToCut.push({ length: item.length });
            }
            if (partsToCut.length === 0) continue;
            partsToCut.sort((a, b) => b.length - a.length);
            const cuttingPlan = [];
            for (const part of partsToCut) {
                let placed = false;
                for (const stock of cuttingPlan) {
                    const stockCount = stock.length;
                    const usedLength = stockCount > 0
                        ? stock.reduce((sum, p) => sum + p.length, 0) + (stockCount - 1) * kerf
                        : 0;
                    if (stockLength - usedLength >= part.length + (stockCount > 0 ? kerf : 0)) {
                        stock.push(part);
                        placed = true;
                        break;
                    }
                }
                if (!placed) cuttingPlan.push([part]);
            }
            const groupedPlan = new Map();
            for (const stock of cuttingPlan) {
                const key = stock.map(p => p.length).sort((a, b) => a - b).join(',');
                if (groupedPlan.has(key)) groupedPlan.get(key).count++;
                else groupedPlan.set(key, { parts: stock, count: 1 });
            }
            allResults.set(materialName, { plan: groupedPlan });
        }
        store.setState('cutting.results', allResults);
        return allResults;
    },

    getSettings() { return store.getState('cutting.settings'); },
    updateSetting(key, value) { store.setState('cutting.settings', { ...store.getState('cutting.settings'), [key]: value }); },
    clear() { store.setState('cutting.materialsData', {}); store.setState('cutting.results', null); store.setState('cutting.isLoading', false); }
};

// ============================================================
// CUTTING CALCULATOR — UI
// ============================================================

function visualizeAllResults(allResults, stockLength, kerf, multiplicity) {
    const resultsContainer = document.getElementById('results-container');
    const summaryContainer = document.getElementById('summary-container');

    resultsContainer.innerHTML = '';
    summaryContainer.style.display = 'none';

    if (allResults.size === 0) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <svg class="icon" aria-hidden="true">
                    <use xlink:href="assets/icons/sprite.svg#cut"></use>
                </svg>
                <h3>Нет деталей для раскроя</h3>
                <p>Проверьте данные в спецификации</p>
            </div>
        `;
        return;
    }

    let grandTotalWaste = 0;
    let grandTotalStocks = 0;
    let grandTotalParts = 0;

    summaryContainer.innerHTML = `
        <div class="summary-header">
            <h3>Сводка раскроя</h3>
            <div class="summary-info">
                <p><strong>Длина заготовки:</strong> ${stockLength} мм</p>
                <p><strong>Ширина реза:</strong> ${kerf} мм</p>
                <p><strong>Кратность:</strong> ${multiplicity}</p>
            </div>
        </div>
    `;
    summaryContainer.style.display = 'block';

    const fragment = document.createDocumentFragment();

    for (const [materialName, data] of allResults.entries()) {
        const materialSection = document.createElement('section');
        materialSection.className = 'material-section';

        const materialTitle = document.createElement('h2');
        materialTitle.textContent = materialName;
        materialSection.appendChild(materialTitle);

        let materialTotalWaste = 0;
        let materialTotalStocks = 0;
        let materialTotalParts = 0;

        data.plan.forEach(({ parts, count }) => {
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

            let usedLengthWithKerf = 0;
            let totalNumberOfParts = 0;
            groupedParts.forEach(group => {
                usedLengthWithKerf += group.length * group.count;
                totalNumberOfParts += group.count;
            });
            usedLengthWithKerf += totalNumberOfParts * kerf;

            groupedParts.forEach((group, groupIndex) => {
                const groupTotalLength = group.length * group.count;
                const groupCutsLength = group.count * kerf;
                const groupWidth = (groupTotalLength + groupCutsLength) / stockLength * 100;

                const partElement = document.createElement('div');
                partElement.className = 'part';
                partElement.style.width = `${groupWidth}%`;
                partElement.textContent = group.count > 1 ? `${group.length}×${group.count}` : `${group.length}`;
                stockVisual.appendChild(partElement);

                if (groupIndex < groupedParts.length - 1) {
                    const cutElement = document.createElement('div');
                    cutElement.className = 'cut-visual';
                    cutElement.style.width = `${(kerf / stockLength) * 100}%`;
                    stockVisual.appendChild(cutElement);
                }
            });

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

            const wasteLabel = document.createElement('p');
            wasteLabel.className = 'waste-label';
            wasteLabel.textContent = `Остаток: ${Math.round(waste)} мм`;
            stockWrapper.appendChild(wasteLabel);

            stockElement.appendChild(stockWrapper);
            materialSection.appendChild(stockElement);
        });

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
        fragment.appendChild(materialSection);

        grandTotalWaste += materialTotalWaste;
        grandTotalStocks += materialTotalStocks;
        grandTotalParts += materialTotalParts;
    }

    resultsContainer.appendChild(fragment);

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
    resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export async function initializeCuttingCalculator() {
    const cutButton = document.getElementById('cutButton');
    const resultsContainer = document.getElementById('results-container');
    const summaryContainer = document.getElementById('summary-container');

    if (!cutButton) return;

    const performCutting = async () => {
        const stockLength = parseInt(document.getElementById('stockLengthSelect').value);
        const kerf = parseFloat(document.getElementById('kerfSelect').value);
        const multiplicity = parseInt(document.getElementById('multiplicity').value);

        if (isNaN(multiplicity) || multiplicity < 1) {
            alert('Пожалуйста, введите корректное значение кратности (целое число > 0).');
            return;
        }

        store.setState('cutting.settings.stockLength', stockLength);
        store.setState('cutting.settings.kerf', kerf);
        store.setState('cutting.settings.multiplicity', multiplicity);

        resultsContainer.innerHTML = `
            <div class="empty-state">
                <svg class="icon icon--spin" aria-hidden="true">
                    <use xlink:href="assets/icons/sprite.svg#spinner"></use>
                </svg>
                <h3>Загрузка данных...</h3>
                <p>Пожалуйста, подождите</p>
            </div>
        `;

        try {
            const results = await CuttingService.performCutting({ stockLength, kerf, multiplicity });

            if (results.size === 0) {
                resultsContainer.innerHTML = `
                    <div class="empty-state">
                    <svg class="icon icon--warning" aria-hidden="true">
                        <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
                    </svg>
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
                    <svg class="icon icon--warning" aria-hidden="true">
                        <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
                    </svg>
                    <h3>Ошибка при раскрое</h3>
                    <p>${escapeHtml(error.message)}</p>
                </div>
            `;
        }
    };

    cutButton.addEventListener('click', performCutting);

    resultsContainer.innerHTML = `
        <div class="empty-state">
            <svg class="icon" aria-hidden="true">
                <use xlink:href="assets/icons/sprite.svg#cut"></use>
            </svg>
            <h3 class="info-start">Готов к работе</h3>
            <p class="info-start">Настройте параметры и нажмите "Раскроить"</p>
        </div>
    `;
}

export function waitForProjectInitialization() {
    let checkCount = 0;
    const maxChecks = 30;

    const checkInterval = setInterval(() => {
        checkCount++;
        const projectId = getProjectId();

        if (projectId) {
            clearInterval(checkInterval);
            initializeCuttingCalculator().catch(error => {
                showCuttingInitError(error);
            });
        } else if (checkCount >= maxChecks) {
            clearInterval(checkInterval);
            const resultsContainer = document.getElementById('results-container');
            if (resultsContainer) {
                resultsContainer.innerHTML = `
                    <div class="empty-state">
                    <svg class="icon icon--warning" aria-hidden="true">
                        <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
                    </svg>
                        <h3>Не удалось определить проект</h3>
                        <p>Пожалуйста, перезагрузите страницу или вернитесь на главную страницу</p>
                        <a href="index.html" class="cut-btn" style="margin-top: 20px; display: inline-block;">Вернуться на главную</a>
                    </div>
                `;
            }
        }
    }, 500);
}

/**
 * Показывает сообщение об ошибке инициализации в контейнере результатов.
 * Вызывается, если initializeCuttingCalculator упал с исключением.
 */
function showCuttingInitError(error) {
    console.error('Error initializing cutting calculator:', error);
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;
    resultsContainer.innerHTML = `
        <div class="empty-state">
            <svg class="icon icon--warning" aria-hidden="true">
                <use xlink:href="assets/icons/sprite.svg#triangle-exclamation"></use>
            </svg>
            <h3>Не удалось инициализировать раскрой</h3>
            <p>${escapeHtml(error?.message || String(error))}</p>
            <p style="font-size: 0.85rem; opacity: 0.7;">Пожалуйста, перезагрузите страницу</p>
        </div>
    `;
}