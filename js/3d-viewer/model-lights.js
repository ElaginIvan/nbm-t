/**
 * Настраивает профессиональное освещение сцены
 * @param {THREE.Scene} scene - Сцена для добавления света
 */
export function setupLights(scene) {
    // 1. Фоновое освещение (замена AmbientLight)
    // Небо (теплее), земля (холоднее) - создает естественный градиент
    const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 0.4);
    scene.add(hemiLight);

    // 2. Ключевой свет (Main/Key Light) - основной источник
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
    mainLight.position.set(5, 10, 7); // Справа-сверху-спереди
    mainLight.castShadow = true;      // Включаем тени (опционально)
    
    // Настройка качества теней (если включены)
    if (mainLight.castShadow) {
        mainLight.shadow.mapSize.set(1024, 1024);
        mainLight.shadow.camera.near = 0.5;
        mainLight.shadow.camera.far = 50;
    }
    scene.add(mainLight);

    // 3. Заполняющий свет (Fill Light) - мягкий, с противоположной стороны
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
    fillLight.position.set(-5, 2, -5); // Слева-снизу-сзади
    scene.add(fillLight);

    // 4. Контровой свет (Rim Light) - подсвечивает контуры модели
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
    rimLight.position.set(0, 5, -10); // Сзади
    scene.add(rimLight);
    
    // Возвращаем источники, если нужно будет анимировать их позже
    return { mainLight, fillLight, rimLight, hemiLight };
}
