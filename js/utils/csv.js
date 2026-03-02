/**
 * Утилиты для работы с CSV файлами
 * Объединяет дублирующуюся логику из project.js и cutting.js
 */

/**
 * Кодировки для проверки
 */
const ENCODINGS = {
    UTF8: 'utf-8',
    WINDOWS1251: 'windows-1251'
};

/**
 * Проверяет, содержит ли текст кириллические символы
 * @param {string} text - Текст для проверки
 * @returns {boolean} true если содержит кириллицу
 */
export function hasCyrillic(text) {
    return /[а-яА-ЯЁё]/.test(text);
}

/**
 * Определяет кодировку текста
 * @param {ArrayBuffer} buffer - ArrayBuffer с данными
 * @returns {string} Название кодировки
 */
export function detectEncoding(buffer) {
    // Пробуем UTF-8
    const utf8Text = new TextDecoder(ENCODINGS.UTF8).decode(buffer);
    
    if (hasCyrillic(utf8Text)) {
        return ENCODINGS.UTF8;
    }
    
    // Пробуем Windows-1251
    const windows1251Text = new TextDecoder(ENCODINGS.WINDOWS1251).decode(buffer);
    if (hasCyrillic(windows1251Text)) {
        console.log('CSV loaded as Windows-1251');
        return ENCODINGS.WINDOWS1251;
    }
    
    console.log('CSV loaded as UTF-8');
    return ENCODINGS.UTF8;
}

/**
 * Загружает текст из ArrayBuffer с правильной кодировкой
 * @param {ArrayBuffer} buffer - ArrayBuffer с данными
 * @returns {string} Декодированный текст
 */
export function decodeCSV(buffer) {
    const encoding = detectEncoding(buffer);
    return new TextDecoder(encoding).decode(buffer);
}

/**
 * Разделяет строку CSV с учётом кавычек
 * @param {string} line - Строка CSV
 * @param {string} delimiter - Разделитель (по умолчанию ';')
 * @returns {Array<string>} Массив значений
 */
export function splitCSVLine(line, delimiter = ';') {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === delimiter && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    // Добавляем последнее значение
    result.push(current);
    return result;
}

/**
 * Нормализует переносы строк в тексте
 * @param {string} text - Исходный текст
 * @returns {string} Нормализованный текст
 */
export function normalizeLineEndings(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Парсит CSV текст в массив объектов
 * @param {string} csvText - CSV текст
 * @param {string} delimiter - Разделитель (по умолчанию ';')
 * @returns {Array<Object>} Массив объектов с ключами из заголовков
 */
export function parseCSV(csvText, delimiter = ';') {
    // Нормализуем переносы строк
    const normalizedText = normalizeLineEndings(csvText);
    const lines = normalizedText.split('\n');
    const result = [];

    if (lines.length === 0) {
        console.warn('CSV file is empty');
        return result;
    }

    // Находим заголовки (первая непустая строка)
    let headerLineIndex = 0;
    while (headerLineIndex < lines.length && lines[headerLineIndex].trim() === '') {
        headerLineIndex++;
    }

    if (headerLineIndex >= lines.length) {
        console.warn('No headers found in CSV');
        return result;
    }

    const headers = splitCSVLine(lines[headerLineIndex], delimiter).map(h => h.trim());

    // Создаем карту для быстрого поиска по обозначениям (удаляем дубликаты)
    const uniqueMap = new Map();

    // Обрабатываем остальные строки
    for (let i = headerLineIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values = splitCSVLine(line, delimiter);
        const obj = {};

        headers.forEach((header, index) => {
            obj[header] = values[index] !== undefined ? values[index].trim() : '';
        });

        // Сохраняем в карту для удаления дубликатов по обозначению
        if (obj['Обозначение']) {
            const designation = obj['Обозначение'].trim();
            if (!uniqueMap.has(designation)) {
                uniqueMap.set(designation, obj);
            }
        } else {
            // Если нет обозначения, добавляем как есть
            result.push(obj);
        }
    }

    // Преобразуем карту обратно в массив
    result.push(...uniqueMap.values());

    console.log(`Parsed ${result.length} unique rows from CSV`);
    return result;
}

/**
 * Загружает и парсит CSV файл
 * @param {string} url - URL CSV файла
 * @returns {Promise<Array<Object>>} Массив объектов
 */
export async function loadCSV(url) {
    try {
        const response = await fetch(url);
        
        if (!response.ok) {
            console.warn(`CSV file not found: ${url}`);
            return [];
        }

        // Получаем данные как ArrayBuffer для правильной обработки кодировки
        const buffer = await response.arrayBuffer();
        const csvText = decodeCSV(buffer);
        
        return parseCSV(csvText);
    } catch (error) {
        console.error('Error loading CSV data:', error);
        return [];
    }
}

/**
 * Находит данные по обозначению в CSV
 * @param {string} designation - Обозначение для поиска
 * @param {Array<Object>} csvData - Массив данных CSV
 * @param {Object} options - Опции поиска
 * @returns {Object|null} Найденные данные или null
 */
export function findInCSV(designation, csvData, options = {}) {
    const { exactMatch = false } = options;

    if (!csvData || csvData.length === 0) {
        return null;
    }

    const cleanDesignation = designation?.trim() || '';

    // Ищем точное совпадение
    const exact = csvData.find(item => {
        const csvDesignation = item['Обозначение']?.trim() || '';
        return csvDesignation === cleanDesignation;
    });

    if (exact || exactMatch) {
        return exact;
    }

    // Ищем частичное совпадение
    const partial = csvData.find(item => {
        const csvDesignation = item['Обозначение']?.trim() || '';
        if (!csvDesignation) return false;

        return csvDesignation.startsWith(cleanDesignation) ||
               cleanDesignation.startsWith(csvDesignation);
    });

    return partial || null;
}

/**
 * Создаёт карту для быстрого поиска по обозначению
 * @param {Array<Object>} csvData - Массив данных CSV
 * @param {string} keyField - Поле для использования как ключ (по умолчанию 'Обозначение')
 * @returns {Map<string, Object>} Карта данных
 */
export function createCSVMap(csvData, keyField = 'Обозначение') {
    const map = new Map();
    
    csvData.forEach(item => {
        const key = item[keyField]?.trim();
        if (key) {
            map.set(key, item);
        }
    });
    
    return map;
}

/**
 * Извлекает базовое обозначение без суффиксов
 * @param {string} designation - Обозначение (напр. "КТ-01.001-01")
 * @returns {string} Базовое обозначение (напр. "КТ-01.001")
 */
export function getBaseDesignation(designation) {
    if (!designation) return '';
    
    // Удаляем суффиксы типа -01, -02 в конце
    const withoutSuffix = designation.replace(/-\d+$/, '');
    
    // Или извлекаем по паттерну "БУКВЫ-ЦИФРЫ.ЦИФРЫ"
    const match = designation.match(/^([A-ZА-ЯЁ]+-\d+\.\d+)/);
    if (match) {
        return match[1];
    }
    
    return withoutSuffix;
}

/**
 * Группирует элементы по базовому обозначению
 * @param {Array} items - Массив элементов
 * @param {function} getDesignation - Функция для получения обозначения
 * @returns {Map<string, Array>} Карта сгруппированных элементов
 */
export function groupByBaseDesignation(items, getDesignation) {
    const groups = new Map();
    
    items.forEach(item => {
        const designation = getDesignation(item);
        const baseDesignation = getBaseDesignation(designation);
        
        if (!groups.has(baseDesignation)) {
            groups.set(baseDesignation, []);
        }
        groups.get(baseDesignation).push(item);
    });
    
    return groups;
}
