import * as THREE from 'three';

/**
 * Настраивает освещение сцены
 * @param {THREE.Scene} scene - Сцена для добавления света
 */
export function setupLights(scene) {
    // Основное освещение
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    // Основной источник света с тенями (сверху-слева)
    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 1.6);
    directionalLight1.position.set(-20, 20, 30); // X - Y - Z
    scene.add(directionalLight1);

    // Источник света (сверху-справа)
    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 1.6);
    directionalLight2.position.set(20, 20, 30); // X - Y - Z

    // Настраиваем тени высокого качества
    directionalLight2.castShadow = true;
    directionalLight2.shadow.mapSize.width = 4096;
    directionalLight2.shadow.mapSize.height = 4096;
    directionalLight2.shadow.camera.near = 0.5;
    directionalLight2.shadow.camera.far = 500;
    directionalLight2.shadow.bias = 0.0000;
    directionalLight2.shadow.normalBias = 0.02;
    directionalLight2.shadow.radius = 5;

    scene.add(directionalLight2);

    // Источник света (сверху-спереди)
    const directionalLight3 = new THREE.DirectionalLight(0xffffff, 1.6);
    directionalLight3.position.set(-0, 20, 30); // X - Y - Z
    scene.add(directionalLight3);

    // Источник света (сверху-сзади)
    const directionalLight4 = new THREE.DirectionalLight(0xffffff, 1.6);
    directionalLight4.position.set(-0, 20, -30); // X - Y - Z
    scene.add(directionalLight4);
}