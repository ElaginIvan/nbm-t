/**
 * Настраивает освещение сцены
 * @param {THREE.Scene} scene - Сцена для добавления света
 */
export function setupLights(scene) {
    // Основное освещение
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8); // Увеличиваем ambient
    scene.add(ambientLight);

    // 1. Верхний свет
    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.6);
    directionalLight1.position.set(0, 50, 0);
    scene.add(directionalLight1);

    // 2. Нижний свет (чтобы было видно снизу)
    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
    directionalLight2.position.set(0, -50, 0);
    scene.add(directionalLight2);

    // 3. Свет спереди-слева
    const directionalLight3 = new THREE.DirectionalLight(0xffffff, 0.6);
    directionalLight3.position.set(-30, 20, 30);
    scene.add(directionalLight3);

    // 4. Свет сзади-справа
    const directionalLight4 = new THREE.DirectionalLight(0xffffff, 0.6);
    directionalLight4.position.set(30, 10, -30);
    scene.add(directionalLight4);
}