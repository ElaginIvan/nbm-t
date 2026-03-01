import * as THREE from 'three';

let originalGridOpacity = 0.5;

/**
 * Создает адаптивную сетку с автоматическим скрытием
 * @param {THREE.Scene} scene - Сцена для добавления сетки
 */
export function createAdaptiveGrid(scene) {
    const size = 100;
    const divisions = 20;
    const mainGrid = new THREE.GridHelper(size, divisions, 0x888888, 0x444444);
    mainGrid.material.opacity = originalGridOpacity;
    mainGrid.material.transparent = true;
    mainGrid.material.receiveShadow = false; // Сетка не получает тени

    // Создаем цветные оси
    const axisLength = size / 2;
    const axesGroup = new THREE.Group();
    const axisWidth = 0.3; // Ширина полоски (видна сверху)
    
    // Ось X (красная) - плоскость вытянутая по X
    const planeX = new THREE.Mesh(
        new THREE.PlaneGeometry(axisLength * 2, axisWidth),
        new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: originalGridOpacity, side: THREE.DoubleSide })
    );
    planeX.rotation.x = -Math.PI / 2;
    planeX.receiveShadow = false; // Не получает тени
    axesGroup.add(planeX);

    // Ось Z (синяя) - плоскость вытянутая по Z
    const planeZ = new THREE.Mesh(
        new THREE.PlaneGeometry(axisWidth, axisLength * 2),
        new THREE.MeshBasicMaterial({ color: 0x0000ff, transparent: true, opacity: originalGridOpacity, side: THREE.DoubleSide })
    );
    planeZ.rotation.x = -Math.PI / 2;
    planeZ.receiveShadow = false; // Не получает тени
    axesGroup.add(planeZ);
    
    axesGroup.position.y = 0.001;

    const gridHelper = new THREE.Group();
    gridHelper.name = 'adaptiveGrid';
    gridHelper.add(mainGrid);
    gridHelper.add(axesGroup);

    scene.add(gridHelper);
    return gridHelper;
}
// Остальные функции (updateGridPosition, checkCameraOrientation) без изменений
/**
 * Обновляет позицию и видимость сетки в зависимости от положения камеры
 * @param {THREE.Object3D} model - Загруженная модель
 * @param {THREE.Group} gridHelper - Группа сетки
 */
export function updateGridPosition(model, gridHelper) {
    if (!gridHelper || !model) return;

    // 1. Получаем ограничивающую рамку модели
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // 2. Определяем минимальную Y-координату модели
    const minY = box.min.y;

    // 3. Помещаем сетку под модель с небольшим отступом
    gridHelper.position.set(center.x, minY - 0.01, center.z);

    // 4. Масштабируем сетку в соответствии с размером модели
    const modelSize = Math.max(size.x, size.z);
    const gridScale = Math.max(modelSize * 1.5, 10); // Минимальный размер 10
    gridHelper.scale.set(gridScale / 100, 1, gridScale / 100);
}

/**
 * Проверяет ориентацию камеры и скрывает/показывает сетку
 * @param {THREE.Group} gridHelper - Группа сетки
 * @param {THREE.Camera} camera - Камера
 * @param {boolean} isGridVisible - Флаг видимости сетки
 * @param {number} originalGridOpacity - Оригинальная прозрачность сетки
 */
export function checkCameraOrientation(gridHelper, camera, isGridVisible, originalGridOpacity) {
    if (!gridHelper || !camera) return;
    
    // Получаем направление взгляда камеры
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    
    // Нормаль плоскости сетки (смотрит вверх)
    const gridNormal = new THREE.Vector3(0, -1, 0);
    
    // Угол между направлением камеры и нормалью сетки
    const angle = cameraDirection.angleTo(gridNormal);
    
    // Если камера смотрит вниз (угол близок к 0) - показываем сетку
    // Если камера смотрит вверх (угол близок к PI) - скрываем сетку
    const shouldBeVisible = angle < Math.PI / 2; // Показываем если смотрим сверху
    
    // Целевая прозрачность
    const targetOpacity = shouldBeVisible ? originalGridOpacity : 0.0;
    
    // Сразу устанавливаем прозрачность, без плавного перехода
    gridHelper.traverse((child) => {
        if (child.material) {
            child.material.opacity = targetOpacity;
        }
    });
    
    // Обновляем флаг видимости
    isGridVisible = shouldBeVisible;
}
