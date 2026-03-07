// import * as THREE from 'three';

// /**
//  * Настраивает освещение сцены
//  * @param {THREE.Scene} scene - Сцена для добавления света
//  */
// export function setupLights(scene) {
//     // Основное освещение
//     const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
//     scene.add(ambientLight);

//     // Основной источник света с тенями (сверху-слева)
//     const directionalLight1 = new THREE.DirectionalLight(0xffffff, 1.6);
//     directionalLight1.position.set(-20, 20, 30); // X - Y - Z
//     scene.add(directionalLight1);

//     // Источник света (сверху-справа)
//     const directionalLight2 = new THREE.DirectionalLight(0xffffff, 1.6);
//     directionalLight2.position.set(20, 20, 30); // X - Y - Z

//     // Настраиваем тени высокого качества
//     directionalLight2.castShadow = true;
//     directionalLight2.shadow.mapSize.width = 4096;
//     directionalLight2.shadow.mapSize.height = 4096;
//     directionalLight2.shadow.camera.near = 0.5;
//     directionalLight2.shadow.camera.far = 500;
//     directionalLight2.shadow.bias = 0.0000;
//     directionalLight2.shadow.normalBias = 0.02;
//     directionalLight2.shadow.radius = 5;

//     scene.add(directionalLight2);

//     // Источник света (сверху-спереди)
//     const directionalLight3 = new THREE.DirectionalLight(0xffffff, 1.6);
//     directionalLight3.position.set(-0, 20, 30); // X - Y - Z
//     scene.add(directionalLight3);

//     // Источник света (сверху-сзади)
//     const directionalLight4 = new THREE.DirectionalLight(0xffffff, 1.6);
//     directionalLight4.position.set(-0, 20, -30); // X - Y - Z
//     scene.add(directionalLight4);
// }










import * as THREE from 'three';

// Сохраняем ссылки на свет, который будем привязывать к камере
let cameraLight = null;

/**
 * Настраивает освещение сцены
 * @param {THREE.Scene} scene - Сцена для добавления света
 * @returns {Object} Объект с ссылками на источники света
 */
export function setupLights(scene) {
    // Основное освещение (ambient - всегда есть)
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.4);
    scene.add(ambientLight);

    // Вспомогательный свет снизу, чтобы не было совсем черных теней
    const fillLight = new THREE.DirectionalLight(0xffffff, 1.3);
    fillLight.position.set(0, -10, 0);
    scene.add(fillLight);

    // Основной свет, который будет привязан к камере
    cameraLight = new THREE.DirectionalLight(0xffffff, 1.2);
    cameraLight.position.set(0, 0, 0); // Позиция относительно камеры
    
    // Настраиваем тени высокого качества
    cameraLight.castShadow = true;
    cameraLight.shadow.mapSize.width = 4096;
    cameraLight.shadow.mapSize.height = 4096;
    cameraLight.shadow.camera.near = 1;
    cameraLight.shadow.camera.far = 500;
    cameraLight.shadow.bias = 0.0000;
    cameraLight.shadow.normalBias = 0.02;
    cameraLight.shadow.radius = 5;
    
    scene.add(cameraLight);

    // Добавляем визуализатор позиции света для отладки (опционально)
    const lightHelper = new THREE.DirectionalLightHelper(cameraLight, 1);
    scene.add(lightHelper);

    console.log('Lights setup complete. Camera light created.');

    return {
        ambientLight,
        cameraLight,
        fillLight
    };
}

/**
 * Обновляет позицию света в соответствии с позицией камеры
 * @param {THREE.Camera} camera - Камера, к которой привязываем свет
 * @param {THREE.Object3D} target - Целевой объект (модель), на который свет должен смотреть
 */
export function updateCameraLightPosition(camera, target) {
    if (!cameraLight || !camera || !target) return;

    // Получаем направление от камеры к цели
    const targetPosition = new THREE.Vector3();
    target.getWorldPosition(targetPosition);

    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);

    // Направление от камеры к цели
    const direction = new THREE.Vector3().subVectors(targetPosition, cameraPosition).normalize();

    // Помещаем свет позади камеры, но немного выше и сбоку для лучшего эффекта
    const lightOffset = new THREE.Vector3(-3, 3, 10); // Смещение относительно камеры
    
    // Применяем вращение камеры к смещению
    const cameraQuaternion = camera.quaternion.clone();
    lightOffset.applyQuaternion(cameraQuaternion);
    
    // Устанавливаем позицию света
    cameraLight.position.copy(cameraPosition.clone().add(lightOffset));
    
    // Направляем свет на цель
    cameraLight.lookAt(targetPosition);
    
    // Обновляем матрицу проекции тени
    cameraLight.shadow.camera.updateProjectionMatrix();
}

/**
 * Получить ссылку на свет камеры
 */
export function getCameraLight() {
    return cameraLight;
}