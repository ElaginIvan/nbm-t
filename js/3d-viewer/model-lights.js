/**
 * Настраивает техническое освещение для разглядывания деталей модели
 * @param {THREE.Scene} scene - Сцена для добавления света
 */
export function setupLights(scene) {
    // Минимальный окружающий свет - только чтобы убрать абсолютно черные тени
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
    scene.add(ambientLight);

    // 1. ПЕРЕДНИЙ СВЕТ (самый важный) - яркий, спереди-сверху
    const frontLight = new THREE.DirectionalLight(0xffffff, 1.2);
    frontLight.position.set(0, 20, 30); // Прямо спереди и чуть сверху
    scene.add(frontLight);

    // 2. НИЖНИЙ ПЕРЕДНИЙ СВЕТ - чтобы подсветить снизу
    const bottomFrontLight = new THREE.DirectionalLight(0xffffff, 0.8);
    bottomFrontLight.position.set(0, -20, 25); // Снизу-спереди
    scene.add(bottomFrontLight);

    // 3. ЛЕВЫЙ ПЕРЕДНИЙ СВЕТ - для подсветки левой стороны спереди
    const leftFrontLight = new THREE.DirectionalLight(0xffffff, 0.7);
    leftFrontLight.position.set(-25, 10, 20); // Слева-спереди
    scene.add(leftFrontLight);

    // 4. ПРАВЫЙ ПЕРЕДНИЙ СВЕТ - для подсветки правой стороны спереди
    const rightFrontLight = new THREE.DirectionalLight(0xffffff, 0.7);
    rightFrontLight.position.set(25, 10, 20); // Справа-спереди
    scene.add(rightFrontLight);

    // 5. ВЕРХНИЙ СВЕТ - общий верхний свет
    const topLight = new THREE.DirectionalLight(0xffffff, 0.6);
    topLight.position.set(0, 30, 0); // Строго сверху
    scene.add(topLight);

    // 6. ЗАДНИЙ СВЕТ (слабее) - только чтобы контур не терялся
    const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
    backLight.position.set(0, 10, -30); // Сзади
    scene.add(backLight);
}