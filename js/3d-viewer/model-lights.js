/**
 * Презентационное освещение для контейнера ТБО
 * С мягкими тенями и студийным качеством
 */
export function setupStudioLights(scene) {
    // 1. Базовое заполнение (очень слабое, только чтобы подсветить тени)
    const ambientLight = new THREE.AmbientLight(0x404060, 0.1);
    scene.add(ambientLight);

    // 2. ОСНОВНОЙ СВЕТ - Большой мягкий софтбокс спереди-сверху
    const mainLight = new THREE.RectAreaLight(0xffffff, 3, 15, 10);
    mainLight.position.set(5, 12, 15);
    mainLight.lookAt(0, 2, 0);
    scene.add(mainLight);
    
    // Визуализация источника (поможет при настройке)
    // const mainLightHelper = new THREE.RectAreaLightHelper(mainLight);
    // scene.add(mainLightHelper);

    // 3. ЗАПОЛНЯЮЩИЙ СВЕТ - Мягкий свет сбоку, чтобы убрать черные тени
    const fillLight = new THREE.RectAreaLight(0xccddff, 1.5, 10, 8);
    fillLight.position.set(-8, 5, 8);
    fillLight.lookAt(0, 2, 0);
    scene.add(fillLight);

    // 4. КОНТРОВОЙ СВЕТ - Сзади-сбоку, создает объем
    const backLight = new THREE.RectAreaLight(0xffffff, 1.2, 12, 8);
    backLight.position.set(-3, 6, -12);
    backLight.lookAt(0, 2, 0);
    scene.add(backLight);

    // 5. ВЕРХНИЙ АКЦЕНТ - Чтобы подчеркнуть верхнюю крышку
    const topLight = new THREE.PointLight(0xffffff, 0.8);
    topLight.position.set(0, 15, 5);
    scene.add(topLight);
}
