/**
 * Презентационное освещение для контейнера ТБО
 * @param {THREE.Scene} scene - Сцена
 * @param {THREE.WebGLRenderer} renderer - Рендерер (опционально)
 */
export function setupPresentationLights(scene, renderer = null) {
    // НЕ ТРОГАЕМ настройки рендерера если они не переданы
    // или применяем только безопасные
    
    if (renderer) {
        // ТОЛЬКО безопасные настройки
        try {
            // Не включаем shadowMap если не уверены
            // renderer.shadowMap.enabled = false; // оставляем как есть
            
            // Мягкий tone mapping который точно работает
            renderer.toneMapping = THREE.ReinhardToneMapping; // Вместо ACES
            renderer.toneMappingExposure = 1.1;
        } catch (e) {
            console.warn('Не удалось применить настройки рендерера', e);
        }
    }

    // 1. Базовое заполнение (как в рабочем варианте)
    const ambientLight = new THREE.AmbientLight(0x404060, 0.2);
    scene.add(ambientLight);

    // 2. ОСНОВНОЙ СВЕТ (Ключевой) - теплый и яркий
    const keyLight = new THREE.DirectionalLight(0xfff0e0, 1.5);
    keyLight.position.set(5, 15, 12);
    // БЕЗ ТЕНЕЙ - пока не убедимся что они работают
    // keyLight.castShadow = false;
    scene.add(keyLight);

    // 3. НИЖНЯЯ ПОДСВЕТКА
    const bottomLight = new THREE.DirectionalLight(0xaaccff, 0.3);
    bottomLight.position.set(0, -12, 5);
    scene.add(bottomLight);

    // 4. ЗАПОЛНЯЮЩИЙ СВЕТ СПЕРЕДИ
    const fillLight = new THREE.DirectionalLight(0xffddcc, 0.7);
    fillLight.position.set(-15, 8, 20);
    scene.add(fillLight);

    // 5. КОНТРОВОЙ СВЕТ СЗАДИ
    const backLight = new THREE.DirectionalLight(0xcceeff, 0.8);
    backLight.position.set(20, 5, -20);
    scene.add(backLight);

    // 6. ДОПОЛНИТЕЛЬНЫЙ БОКОВОЙ
    const sideLight = new THREE.DirectionalLight(0xffffff, 0.5);
    sideLight.position.set(-10, 10, -5);
    scene.add(sideLight);

    console.log('Презентационное освещение применено');
}
