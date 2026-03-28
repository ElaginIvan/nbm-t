
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

    // Верхний свет
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.6);
    directionalLight.position.set(0, 50, 0);
    scene.add(directionalLight);

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
    // const lightHelper = new THREE.DirectionalLightHelper(cameraLight, 1);
    // scene.add(lightHelper);

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