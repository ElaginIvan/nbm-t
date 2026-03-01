// --- КАЛЬКУЛЯТОР РАСКРОЯ (АВТОМАТИЧЕСКОЕ ПОЛУЧЕНИЕ ДАННЫХ ИЗ SPEC.CSV) ---

// Глобальные переменные для хранения данных
let cuttingMaterialsData = {};

/**
 * Парсит строку материала для получения типа и длины
 * @param {string} materialString - Строка с материалом (напр. "Труба 40х60х2 L=400")
 * @returns {Object|null} Объект с type и length или null
 */
function parseMaterialString(materialString) {
    if (!materialString) return null;
    
    // Ищем паттерн "L=число" в конце строки
    const match = materialString.match(/^(.*?)\s*L\s*=\s*(\d+\.?\d*)\s*$/i);
    
    if (match) {
        return {
            type: match[1].trim(), // Тип материала (напр. "Труба 40х60х2")
            length: parseFloat(match[2]) // Длина в мм
        };
    }
    
    
    // Если не нашли длину, возвращаем весь текст как тип
    return {
        type: materialString.trim(),
        length: null
    };
}

/**
 * Получает ID проекта из различных источников
 * @returns {string|null} ID проекта или null
 */
function getProjectId() {
    // Пробуем получить из project-data элемента
    const projectData = document.getElementById('project-data');
    if (projectData && projectData.getAttribute('data-project-id')) {
        return projectData.getAttribute('data-project-id');
    }
    
    // Пробуем получить из URL
    const urlParams = new URLSearchParams(window.location.search);
    const projectIdFromUrl = urlParams.get('project');
    if (projectIdFromUrl) {
        return projectIdFromUrl;
    }
    
    // Пробуем получить из localStorage
    const projectIdFromStorage = localStorage.getItem('selectedProject');
    if (projectIdFromStorage) {
        return projectIdFromStorage;
    }
    
    return null;
}

/**
 * Загружает данные для раскроя из CSV файла и структуры модели
 */
async function loadCuttingData() {
    try {
        // Получаем ID проекта
        const projectId = getProjectId();
        
        if (!projectId) {
            console.warn('Project ID not found. Waiting for project initialization...');
            return null; // Возвращаем null вместо пустого объекта
        }

        console.log('Loading cutting data for project:', projectId);
        
        // Формируем путь к CSV файлу спецификации
        const csvPath = `models/${projectId}/spec.csv`;
        console.log('CSV path:', csvPath);
        
        const response = await fetch(csvPath);
        if (!response.ok) {
            console.warn(`CSV file not found: ${csvPath}`);
            return {};
        }

        // Получаем данные как ArrayBuffer для правильной обработки кодировки
        const buffer = await response.arrayBuffer();
        let csvText = new TextDecoder('utf-8').decode(buffer);
        
        // Проверяем кодировку
        if (!hasCyrillic(csvText)) {
            csvText = new TextDecoder('windows-1251').decode(buffer);
        }

        // Парсим CSV
        const csvData = parseCuttingCSV(csvText);
        
        // Получаем структуру модели для количества деталей
        const modelStructure = window.Specification?.structure || [];
        
        console.log('CSV data loaded:', csvData.length, 'rows');
        console.log('Model structure:', modelStructure.length, 'items');
        
        // Группируем данные по материалу
        const materialsData = groupMaterialsByType(csvData, modelStructure);
        
        console.log('Cutting data processed:', Object.keys(materialsData).length, 'materials');
        return materialsData;
        
    } catch (error) {
        console.error('Error loading cutting data:', error);
        return {};
    }
}

/**
 * Проверяет, содержит ли текст кириллические символы
 */
function hasCyrillic(text) {
    return /[а-яА-ЯЁё]/.test(text);
}

/**
 * Парсит CSV текст для раскроя
 */
function parseCuttingCSV(csvText) {
    // Нормализуем переносы строк
    csvText = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    const lines = csvText.split('\n');
    const result = [];
    
    if (lines.length === 0) return result;
    
    // Находим заголовки
    let headerLineIndex = 0;
    while (headerLineIndex < lines.length && lines[headerLineIndex].trim() === '') {
        headerLineIndex++;
    }
    
    if (headerLineIndex >= lines.length) return result;
    
    const headersLine = lines[headerLineIndex];
    console.log('CSV headers line:', headersLine);
    
    // Разделяем заголовки с учетом кавычек
    const headers = splitCSVLine(headersLine).map(h => h.trim());
    console.log('Parsed headers:', headers);
    
    // Обрабатываем строки
    for (let i = headerLineIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const values = splitCSVLine(line);
        const obj = {};
        
        headers.forEach((header, index) => {
            obj[header] = values[index] !== undefined ? values[index].trim() : '';
        });
        
        // Очищаем обозначение
        if (obj['Обозначение']) {
            obj['Обозначение'] = obj['Обозначение'].trim();
        }
        
        result.push(obj);
    }
    
    return result;
}

/**
 * Разделяет строку CSV с учетом кавычек
 */
function splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ';' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current);
    return result;
}

/**
 * Группирует материалы по типу с учетом количества из модели
 */
function groupMaterialsByType(csvData, modelStructure) {
    const materialsMap = new Map();
    
    console.log('Grouping materials from CSV:', csvData.length, 'rows');
    console.log('Model structure items:', modelStructure.length);
    
    // Создаем карту для быстрого поиска количества по обозначению
    const quantityMap = new Map();
    
    // Заполняем карту количеств из структуры модели
    modelStructure.forEach(item => {
        if (item.name) {
            const cleanName = item.name.trim();
            const quantity = item.instanceCount || 1;
            
            // Добавляем в карту
            quantityMap.set(cleanName, quantity);
            
            // Также проверяем частичные совпадения (без суффиксов)
            const parts = cleanName.split(/[-_.]/);
            if (parts.length > 1) {
                const baseName = parts[0] + '.' + parts[1];
                if (baseName !== cleanName) {
                    if (quantityMap.has(baseName)) {
                        quantityMap.set(baseName, quantityMap.get(baseName) + quantity);
                    } else {
                        quantityMap.set(baseName, quantity);
                    }
                }
            }
            
            // Для обозначений типа "КТ-01.001"
            const match = cleanName.match(/^([A-ZА-ЯЁ]+-\d+\.\d+)/);
            if (match && match[1] !== cleanName) {
                const baseDesignation = match[1];
                if (quantityMap.has(baseDesignation)) {
                    quantityMap.set(baseDesignation, quantityMap.get(baseDesignation) + quantity);
                } else {
                    quantityMap.set(baseDesignation, quantity);
                }
            }
        }
    });
    
    console.log('Quantity map:', Array.from(quantityMap.entries()));
    
    // Обрабатываем данные из CSV
    csvData.forEach((row, index) => {
        const designation = row['Обозначение'];
        const material = row['Описание'];
        const name = row['Наименование'];
        
        console.log(`Row ${index}:`, { designation, material, name });
        
        if (!designation || !material) return;
        
        // Парсим материал
        const parsedMaterial = parseMaterialString(material);
        if (!parsedMaterial || !parsedMaterial.type || parsedMaterial.length === null) {
            console.log('Skipping material without length:', material);
            return;
        }
        
        // Находим количество из модели
        let quantity = 1;
        
        // Пробуем разные варианты поиска количества
        const searchKeys = [
            designation,
            designation.replace(/-\d+$/, ''),
            designation.match(/^([A-ZА-ЯЁ]+-\d+\.\d+)/)?.[1],
            designation.split('-')[0] + '.' + designation.split('-')[1]?.split('.')[0]
        ].filter(Boolean);
        
        for (const key of searchKeys) {
            if (quantityMap.has(key)) {
                quantity = quantityMap.get(key);
                console.log(`Found quantity ${quantity} for ${designation} using key: ${key}`);
                break;
            }
        }
        
        // Если не нашли в модели, используем количество из CSV
        if (quantity === 1) {
            const csvQuantity = parseInt(row['КОЛ.']) || parseInt(row['Кол.']) || parseInt(row['Количество']) || 1;
            quantity = csvQuantity;
            console.log(`Using CSV quantity ${quantity} for ${designation}`);
        }
        
        // Проверяем, что количество > 0
        if (quantity <= 0) return;
        
        const key = parsedMaterial.type;
        const length = parsedMaterial.length;
        
        if (!materialsMap.has(key)) {
            materialsMap.set(key, []);
        }
        
        // Добавляем деталь с нужным количеством
        for (let i = 0; i < quantity; i++) {
            materialsMap.get(key).push({ length });
        }
        
        console.log(`Added ${quantity} items of ${key} (${length}mm) for ${designation}`);
    });
    
    // Преобразуем Map в объект
    const result = {};
    materialsMap.forEach((parts, materialType) => {
        // Группируем одинаковые длины для более эффективного отображения
        const groupedParts = {};
        parts.forEach(part => {
            const lengthKey = part.length.toString();
            if (!groupedParts[lengthKey]) {
                groupedParts[lengthKey] = { length: part.length, quantity: 0 };
            }
            groupedParts[lengthKey].quantity++;
        });
        
        result[materialType] = Object.values(groupedParts);
        console.log(`Material ${materialType}:`, result[materialType]);
    });
    
    return result;
}

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
        
        // Показываем индикатор загрузки
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-spinner fa-spin"></i>
                <h3>Загрузка данных...</h3>
                <p>Пожалуйста, подождите</p>
            </div>
        `;
        
        // Загружаем данные, если еще не загружены
        if (Object.keys(cuttingMaterialsData).length === 0) {
            cuttingMaterialsData = await loadCuttingData();
        }
        
        if (Object.keys(cuttingMaterialsData).length === 0) {
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
        
        const allResults = new Map();
        
        // Итерируемся по каждому материалу
        for (const [materialName, parts] of Object.entries(cuttingMaterialsData)) {
            const partsToCut = [];
            
            // Подготавливаем детали с учетом кратности
            for (const item of parts) {
                if (item.length > stockLength) {
                    alert(`Ошибка: Деталь длиной ${item.length}мм из материала "${materialName}" не помещается на заготовку ${stockLength}мм.`);
                    return;
                }
                
                // Умножаем количество на кратность
                const totalQuantity = item.quantity * multiplicity;
                for (let i = 0; i < totalQuantity; i++) {
                    partsToCut.push({ length: item.length });
                }
            }
            
            if (partsToCut.length === 0) continue;
            
            // Алгоритм FFD (First Fit Decreasing)
            partsToCut.sort((a, b) => b.length - a.length);
            const cuttingPlan = [];
            
            for (const part of partsToCut) {
                let placed = false;
                
                for (const stock of cuttingPlan) {
                    // Расчет использованной длины с учетом резов
                    let usedLength = 0;
                    if (stock.length > 0) {
                        // Сумма длин всех деталей
                        usedLength = stock.reduce((sum, p) => sum + p.length, 0);
                        // Добавляем резы (каждая деталь требует рез)
                        usedLength += stock.length * kerf;
                    }
                    
                    // Проверяем, поместится ли деталь
                    const requiredLength = part.length + kerf;
                    if (stockLength - usedLength >= requiredLength) {
                        stock.push(part);
                        placed = true;
                        break;
                    }
                }
                
                if (!placed) {
                    cuttingPlan.push([part]);
                }
            }
            
            // Группировка одинаковых раскроев
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
        
        visualizeAllResults(allResults, stockLength, kerf, multiplicity);
    };
    
    // Назначаем обработчик
    cutButton.addEventListener('click', performCutting);
    
    // Показываем начальное состояние
    resultsContainer.innerHTML = `
        <div class="empty-state">
            <svg>
                <use xlink:href="assets/icons/sprite.svg#cut">
            </use></svg>
            <h3 class = "info-start">Готов к работе</h3>
            <p class = "info-start">Настройте параметры и нажмите "Раскроить"</p>
        </div>
    `;
}

/**
 * Визуализация результатов раскроя
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

/**
 * Ожидание инициализации проекта
 */
function waitForProjectInitialization() {
    let checkCount = 0;
    const maxChecks = 30; // 15 секунд максимум
    
    const checkInterval = setInterval(() => {
        checkCount++;
        
        // Проверяем наличие project-data элемента с projectId
        const projectId = getProjectId();
        
        if (projectId) {
            clearInterval(checkInterval);
            console.log('Project initialized, ID:', projectId);
            
            // Инициализируем калькулятор раскроя
            initializeCuttingCalculator().then(() => {
                console.log('Cutting calculator initialized');
            }).catch(error => {
                console.error('Error initializing cutting calculator:', error);
            });
        } else if (checkCount >= maxChecks) {
            clearInterval(checkInterval);
            console.warn('Project initialization timeout');
            
            // Все равно пытаемся инициализировать с сообщением об ошибке
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
    }, 500); // Проверяем каждые 500мс
}

/**
 * Инициализация страницы раскроя
 */
function initCuttingPage() {
    console.log('Initializing cutting page...');
    
    // Начинаем ожидание инициализации проекта
    waitForProjectInitialization();
}

// Запускаем инициализацию при загрузке
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCuttingPage);
} else {
    initCuttingPage();
}