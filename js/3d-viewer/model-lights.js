/**
 * Настраивает освещение сцены с реалистичными тенями и контрастом
 * @param {THREE.Scene} scene - Сцена для добавления света
 */
export function setupLights(scene) {
    // 1. Окружающий свет - теперь только для подсветки теней
    const ambientLight = new THREE.AmbientLight(0x404060, 0.3); // Холодный оттенок, низкая интенсивность
    scene.add(ambientLight);

    // 2. Основной ключевой свет (сверху-спереди-слева) - создает основные тени и объем
    const keyLight = new THREE.DirectionalLight(0xffeedd, 1.2);
    keyLight.position.set(-20, 30, 20);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.bias = -0.0001;
    scene.add(keyLight);

    // 3. Заполняющий свет (справа-сзади) - мягко подсвечивает тени
    const fillLight = new THREE.DirectionalLight(0x6688aa, 0.6);
    fillLight.position.set(25, 15, -20);
    scene.add(fillLight);

    // 4. Контровой свет (сзади) - создает ореол и отделяет объект от фона
    const backLight = new THREE.DirectionalLight(0x88aaff, 0.5);
    backLight.position.set(0, 20, -40);
    scene.add(backLight);

    // 5. Нижний свет - для подсветки снизу (опционально)
    const bottomLight = new THREE.DirectionalLight(0x446688, 0.2);
    bottomLight.position.set(0, -20, 0);
    scene.add(bottomLight);

    // Дополнительно: добавить точечный свет для акцентов
    const pointLight = new THREE.PointLight(0xffaa88, 0.4, 100);
    pointLight.position.set(-15, 25, 25);
    scene.add(pointLight);
}