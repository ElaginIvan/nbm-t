/**
 * Cutting Module — раскрой материалов.
 * Самодостаточный модуль: читает cutting.csv (путь — из projects.json, поле cuttingFile).
 * Фильтрует фасонный/профильный прокат, выполняет FFD-раскрой, рендерит карту раскроя.
 * 3D-подсветка деталей и 2D-чертежи — через глобальные API window.ModelViewer / window.DrawingViewer.
 */

import { store, escapeHtml, getProjectId, decodeCSV, parseCSV } from './app.js';

// ============================================================
// КОНФИГУРАЦИЯ ФИЛЬТРА МАТЕРИАЛОВ
// ============================================================

/** Формы материалов, подлежащие линейному раскрою (первое слово колонки «Материал»). */
const LINEAR_CUTTING_MATERIALS = [
    'труба',
    'круг',
    'арматура',
    'уголок',
    'швеллер',
    'двутавр',
    'полоса',
];

/** Проверяет, входит ли первое слово материала в LINEAR_CUTTING_MATERIALS. */
function isLinearCuttingMaterial(materialString) {
    if (!materialString || typeof materialString !== 'string') return false;
    const firstWord = materialString.trim().split(/\s+/)[0].toLowerCase();
    return LINEAR_CUTTING_MATERIALS.includes(firstWord);
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

/** Очищает имя от суффикса экземпляра (например «:2»). Копия логики specification.js для самодостаточности. */
function cleanDesignationName(name) {
    return name ? name.replace(/:\d+$/, '').trim() : '';
}

// ============================================================
// ОБРАБОТКА ДАННЫХ CUTTING.CSV
// ============================================================

/** Группирует данные cutting.csv по типу материала: каждая группа — длины с количеством и обозначениями. */
function groupCuttingData(csvData) {
    const materialsMap = new Map();

    for (const row of csvData) {
        const designation = row['Обозначение'];
        const material = row['Материал'];
        const lengthStr = row['Длина'];
        const quantityStr = row['КОЛ.'] || row['Кол.'] || row['Количество'];

        // --- Фильтр: только линейные (фасонные) материалы ---
        if (!isLinearCuttingMaterial(material)) continue;

        // --- Длина обязательна для линейного раскроя ---
        const length = parseFloat(lengthStr);
        if (!length || length <= 0 || isNaN(length)) continue;

        // --- Количество ---
        const quantity = parseInt(quantityStr, 10) || 1;
        if (quantity <= 0) continue;

        // --- Группировка по полному описанию материала ---
        const materialKey = material.trim();
        if (!materialsMap.has(materialKey)) {
            materialsMap.set(materialKey, []);
        }

        const cleanDesignation = cleanDesignationName(designation);
        for (let i = 0; i < quantity; i++) {
            materialsMap.get(materialKey).push({ length, designation: cleanDesignation });
        }
    }

    // Упаковываем: внутри каждого материала группируем одинаковые длины,
    // сохраняя список обозначений
    const result = {};
    materialsMap.forEach((parts, materialType) => {
        const lengthGroups = {};
        parts.forEach(part => {
            const lengthKey = part.length.toString();
            if (!lengthGroups[lengthKey]) {
                lengthGroups[lengthKey] = { length: part.length, quantity: 0, designations: new Set() };
            }
            lengthGroups[lengthKey].quantity++;
            if (part.designation) {
                lengthGroups[lengthKey].designations.add(part.designation);
            }
        });
        result[materialType] = Object.values(lengthGroups).map(g => ({
            length: g.length,
            quantity: g.quantity,
            designations: Array.from(g.designations)
        }));
    });

    return result;
}

// ============================================================
// 3D ПОДСВЕТКА ДЕТАЛЕЙ (самодостаточная реализация, без импорта specification.js)
// ============================================================

/** Состояние подсветки 3D-модели. */
const _highlight = {
    selectedDesignations: null,
    savedMeshStates: null
};

/** Уведомляет об изменении состава видимых деталей (для перерисовки карты теней). */
function _notifyVisibilityChanged() {
    window.dispatchEvent(new Event('model-visibility-changed'));
}

/** Сохраняет видимость и emissive всех мешей (для последующего восстановления). */
function _saveMeshStates(model) {
    const states = new Map();
    model.traverse(child => {
        if (!child.isMesh) return;
        states.set(child.uuid, {
            visible: child.visible,
            emissiveHex: (child.material && child.material.emissive)
                ? child.material.emissive.getHex()
                : 0
        });
    });
    return states;
}

/** Восстанавливает меши к сохранённому состоянию. */
function _restoreMeshStates(model) {
    if (!_highlight.savedMeshStates) return;
    model.traverse(child => {
        if (!child.isMesh) return;
        const state = _highlight.savedMeshStates.get(child.uuid);
        if (state) {
            child.visible = state.visible;
            if (child.material && child.material.emissive) {
                child.material.emissive.setHex(state.emissiveHex);
            }
        }
        child.material.dithering = true;
    });
}

/** Находит все меши модели, чьё имя совпадает с обозначением (после очистки суффиксов). */
function _findMeshesByDesignation(model, designation) {
    const meshes = new Set();
    const cleanTarget = cleanDesignationName(designation);
    if (!cleanTarget) return meshes;

    model.traverse(obj => {
        const rawName = (obj.userData && obj.userData.name) ? obj.userData.name : obj.name;
        const cleanName = cleanDesignationName(rawName);
        if (cleanName === cleanTarget) {
            obj.traverse(child => {
                if (child.isMesh) meshes.add(child);
            });
        }
    });
    return meshes;
}

/** Показывает только указанные детали, остальные скрывает. */
function highlightDesignationsInModel(designations) {
    const model = window.ModelViewer ? window.ModelViewer.getModel() : null;
    if (!model) return;

    // Сохраняем оригинальные состояния при первом вызове
    if (!_highlight.savedMeshStates) {
        _highlight.savedMeshStates = _saveMeshStates(model);
    }

    // Сначала восстанавливаем всё
    _restoreMeshStates(model);

    if (!designations || designations.length === 0) {
        _highlight.selectedDesignations = null;
        return _notifyVisibilityChanged();
    }

    // Собираем меши всех указанных обозначений
    const meshesToShow = new Set();
    for (const designation of designations) {
        const found = _findMeshesByDesignation(model, designation);
        found.forEach(m => meshesToShow.add(m));
    }

    if (meshesToShow.size === 0) {
        _highlight.selectedDesignations = null;
        return _notifyVisibilityChanged();
    }

    // Скрываем все, кроме целевых
    model.traverse(child => {
        if (!child.isMesh) return;
        if (meshesToShow.has(child)) {
            child.visible = true;
            if (child.material && child.material.emissive) {
                child.material.emissive.setHex(0x1a3a5c);
            }
        } else {
            child.visible = false;
        }
    });

    _highlight.selectedDesignations = designations;
    _notifyVisibilityChanged();
}

/** Сбрасывает подсветку: показывает все детали в исходном состоянии. */
function resetModelHighlight() {
    const model = window.ModelViewer ? window.ModelViewer.getModel() : null;
    if (!model) return;
    _restoreMeshStates(model);
    _highlight.selectedDesignations = null;
    _notifyVisibilityChanged();
}

// ============================================================
// ОБРАБОТЧИК КЛИКА ПО ДЕТАЛИ В РАСКРОЕ
// ============================================================

/** Обрабатывает клик по детали в раскрое: toggle выделения, подсветка в 3D, чертёж в 2D. */
function handlePartClick(designations) {
    if (!designations || designations.length === 0) return;

    const current = _highlight.selectedDesignations;

    // Проверяем: это повторный клик по тем же обозначениям? (toggle off)
    const isSame = current &&
        current.length === designations.length &&
        current.every((d, i) => d === designations[i]);

    if (isSame) {
        // Снять выделение
        resetModelHighlight();
        _clearActivePartClass();
    } else {
        // Выделить новые детали
        highlightDesignationsInModel(designations);

        // Показать чертёж, если есть 2D-просмотрщик
        if (window.DrawingViewer && window.DrawingViewer.loadDrawing) {
            const firstDesignation = designations[0];
            if (firstDesignation) {
                window.DrawingViewer.loadDrawing(firstDesignation);
            }
        }

        // Подсветить все сегменты с теми же обозначениями на всех хлыстах
        _highlightMatchingParts(designations);
    }
}

/** Подсвечивает сегменты карты раскроя с теми же обозначениями. */
function _highlightMatchingParts(designations) {
    _clearActivePartClass();
    document.querySelectorAll('.cutting-part[data-designations]').forEach(el => {
        try {
            const elDesignations = JSON.parse(el.getAttribute('data-designations'));
            if (elDesignations.some(d => designations.includes(d))) {
                el.classList.add('part--active');
            }
        } catch (e) { /* ignore malformed JSON */ }
    });
}

/** Убирает класс .part--active со всех сегментов раскроя. */
function _clearActivePartClass() {
    document.querySelectorAll('.cutting-part.part--active').forEach(el => {
        el.classList.remove('part--active');
    });
}

// ============================================================
// CUTTING SERVICE
// ============================================================

export const CuttingService = {
    /** Загружает данные из cutting.csv (путь из projects.json). Не зависит от спецификации и 3D-модели. */
    async loadCuttingData() {
        try {
            const projectData = store.getState('project.data');
            const cuttingFile = projectData?.cuttingFile;

            if (!cuttingFile) {
                console.warn('Cutting: в проекте не указан путь к cutting.csv (поле cuttingFile в projects.json)');
                return {};
            }

            const response = await fetch(cuttingFile);
            if (!response.ok) {
                console.warn(`Cutting: не удалось загрузить ${cuttingFile} (HTTP ${response.status})`);
                return {};
            }

            const buffer = await response.arrayBuffer();
            const csvText = decodeCSV(buffer);
            const csvData = parseCSV(csvText);

            if (!csvData || csvData.length === 0) {
                console.warn('Cutting: cutting.csv пуст или не содержит данных');
                return {};
            }

            const materialsData = groupCuttingData(csvData);
            store.setState('cutting.materialsData', materialsData);

            return materialsData;
        } catch (error) {
            console.error('Error loading cutting data:', error);
            return {};
        }
    },

    /** Линейный раскрой по алгоритму First-Fit Decreasing. Каждый элемент несёт designation для кликабельности сегментов. */
    async performCutting(options = {}) {
        const { stockLength = 6000, kerf = 0, multiplicity = 1 } = options;

        let materialsData = store.getState('cutting.materialsData');
        if (Object.keys(materialsData).length === 0) {
            materialsData = await this.loadCuttingData();
        }
        if (Object.keys(materialsData).length === 0) return new Map();

        const allResults = new Map();

        for (const [materialName, parts] of Object.entries(materialsData)) {
            const partsToCut = [];
            for (const item of parts) {
                if (item.length > stockLength) continue;
                const totalQuantity = item.quantity * multiplicity;
                for (let i = 0; i < totalQuantity; i++) {
                    partsToCut.push({
                        length: item.length,
                        designation: item.designations[0] || null
                    });
                }
            }
            if (partsToCut.length === 0) continue;

            // Сортировка по убыванию длины (FFD)
            partsToCut.sort((a, b) => b.length - a.length);

            const cuttingPlan = [];
            // Накопительные суммы занятости по каждому хлысту (O(P×S) вместо O(P×S×P)).
            const stockUsed = [];   // сумма длин деталей хлыста
            const stockCount = [];  // кол-во деталей в хлысте
            for (const part of partsToCut) {
                let placed = false;
                for (let si = 0; si < cuttingPlan.length; si++) {
                    const cnt = stockCount[si];
                    const usedLength = cnt > 0 ? stockUsed[si] + (cnt - 1) * kerf : 0;
                    if (stockLength - usedLength >= part.length + (cnt > 0 ? kerf : 0)) {
                        cuttingPlan[si].push(part);
                        stockUsed[si] += part.length;
                        stockCount[si]++;
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    cuttingPlan.push([part]);
                    stockUsed.push(part.length);
                    stockCount.push(1);
                }
            }

            // Группируем одинаковые карты раскроя
            const groupedPlan = new Map();
            for (const stock of cuttingPlan) {
                const key = stock.map(p => p.length).sort((a, b) => a - b).join(',');
                if (groupedPlan.has(key)) {
                    groupedPlan.get(key).count++;
                } else {
                    groupedPlan.set(key, { parts: stock, count: 1 });
                }
            }

            allResults.set(materialName, { plan: groupedPlan });
        }

        store.setState('cutting.results', allResults);
        return allResults;
    },

    getSettings() {
        return store.getState('cutting.settings');
    },
    updateSetting(key, value) {
        store.setState('cutting.settings', { ...store.getState('cutting.settings'), [key]: value });
    },
    clear() {
        store.setState('cutting.materialsData', {});
        store.setState('cutting.results', null);
    }
};

// ============================================================
// CUTTING CALCULATOR — UI
// ============================================================

function visualizeAllResults(allResults, stockLength, kerf, multiplicity) {
    const resultsContainer = document.getElementById('results-container');
    const summaryContainer = document.getElementById('summary-container');

    resultsContainer.innerHTML = '';
    summaryContainer.style.display = 'none';

    // Сбрасываем подсветку 3D при новом раскрое
    resetModelHighlight();

    if (allResults.size === 0) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <svg class="icon" aria-hidden="true">
                    <use xlink:href="assets/icons/sprite.svg#cut"></use>
                </svg>
                <h3>Нет деталей для линейного раскроя</h3>
                <p>В cutting.csv отсутствуют фасонные материалы (труба, круг, арматура, швеллер)</p>
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

            // Группируем одинаковые детали визуально, собирая обозначения
            const groupedParts = [];
            let currentGroup = null;
            for (const part of parts) {
                if (currentGroup && currentGroup.length === part.length) {
                    currentGroup.count++;
                    if (part.designation && !currentGroup.designations.includes(part.designation)) {
                        currentGroup.designations.push(part.designation);
                    }
                } else {
                    if (currentGroup) groupedParts.push(currentGroup);
                    currentGroup = {
                        length: part.length,
                        count: 1,
                        designations: part.designation ? [part.designation] : []
                    };
                }
            }
            if (currentGroup) groupedParts.push(currentGroup);

            let usedLengthWithKerf = 0;
            let totalNumberOfParts = 0;
            groupedParts.forEach(group => {
                usedLengthWithKerf += group.length * group.count;
                totalNumberOfParts += group.count;
            });
            // Единая kerf-математика с алгоритмом FFD: N деталей — (N-1) резов.
            if (totalNumberOfParts > 0) {
                usedLengthWithKerf += (totalNumberOfParts - 1) * kerf;
            }

            groupedParts.forEach((group, groupIndex) => {
                // Ширина сегмента: длина деталей группы + резы МЕЖДУ ними ((count-1) шт.).
                const groupTotalLength = group.length * group.count + (group.count - 1) * kerf;
                const groupWidth = groupTotalLength / stockLength * 100;

                const partElement = document.createElement('div');
                partElement.className = 'part cutting-part';
                partElement.style.width = `${groupWidth}%`;
                partElement.textContent = group.count > 1 ? `${group.length}×${group.count}` : `${group.length}`;

                // Tooltip с обозначениями
                if (group.designations.length > 0) {
                    partElement.title = group.designations.join(', ');
                    partElement.setAttribute('data-designations', JSON.stringify(group.designations));
                    partElement.style.cursor = 'pointer';

                    // Клик: подсветить в 3D + показать чертёж в 2D
                    partElement.addEventListener('click', (e) => {
                        e.stopPropagation();
                        handlePartClick(group.designations);
                    });
                }

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
                <p>Чтение cutting.csv</p>
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
                        <h3>Нет данных для линейного раскроя</h3>
                        <p>Убедитесь, что в cutting.csv есть детали из фасонного проката</p>
                        <p>Допустимые материалы: фасонный, сортовой и трубный прокат (кроме листового)</p>
                        <p style="font-size: 0.8rem; opacity: 0.7;">Также проверьте, что в projects.json указано поле cuttingFile</p>
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

/** Показывает сообщение об ошибке инициализации в контейнере результатов. */
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