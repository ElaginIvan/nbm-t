let originalGridOpacity = 0.5;

/**
 * Создает адаптивную сетку с автоматическим скрытием
 * @param {THREE.Scene} scene - Сцена для добавления сетки
 */
export function createAdaptiveGrid(scene) {
    // Создаем сетку с настройками для лучшей видимости
    const size = 100; // Размер сетки
    const divisions = 20; // Количество делений

    // Основная сетка (серые линии)
    const mainGrid = new THREE.GridHelper(size, divisions, 0x888888, 0x444444);
    mainGrid.material.opacity = originalGridOpacity;
    mainGrid.material.transparent = true;

    // Создаем цветные оси с увеличенной толщиной
    const axisLength = size / 2;
    const axesGroup = new THREE.Group();
    const lineWidth = 3.0; // Увеличь это значение для более толстых линий
    
    // Ось X (красная)
    const pointsX = [-axisLength, 0, 0, axisLength, 0, 0];
    const geometryX = new LineGeometry();
    geometryX.setPositions(pointsX);
    
    const materialX = new LineMaterial({
        color: 0xff0000,
        linewidth: lineWidth,
        transparent: true,
        opacity: originalGridOpacity,
        resolution: new THREE.Vector2(window.innerWidth, window.innerHeight)
    });
    
    const lineX = new Line2(geometryX, materialX);
    axesGroup.add(lineX);
    
    // Ось Z (синяя)
    const pointsZ = [0, 0, -axisLength, 0, 0, axisLength];
    const geometryZ = new LineGeometry();
    geometryZ.setPositions(pointsZ);
    
    const materialZ = new LineMaterial({
        color: 0x0000ff,
        linewidth: lineWidth,
        transparent: true,
        opacity: originalGridOpacity,
        resolution: new THREE.Vector2(window.innerWidth, window.innerHeight)
    });
    
    const lineZ = new Line2(geometryZ, materialZ);
    axesGroup.add(lineZ);
    
    axesGroup.position.y = 0.01;

    // Создаем контейнер для всей сетки
    const gridHelper = new THREE.Group();
    gridHelper.name = 'adaptiveGrid';
    gridHelper.add(mainGrid);
    gridHelper.add(axesGroup);

    scene.add(gridHelper);
    
    // Добавляем обработчик изменения размера окна для обновления resolution
    window.addEventListener('resize', () => {
        materialX.resolution.set(window.innerWidth, window.innerHeight);
        materialZ.resolution.set(window.innerWidth, window.innerHeight);
    });
    
    return gridHelper;
}

// Остальные функции (updateGridPosition, checkCameraOrientation) без изменений
export function updateGridPosition(model, gridHelper) {
    if (!gridHelper || !model) return;

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const minY = box.min.y;

    gridHelper.position.set(center.x, minY - 0.01, center.z);

    const modelSize = Math.max(size.x, size.z);
    const gridScale = Math.max(modelSize * 1.5, 10);
    gridHelper.scale.set(gridScale / 100, 1, gridScale / 100);
}

export function checkCameraOrientation(gridHelper, camera, isGridVisible, originalGridOpacity) {
    if (!gridHelper || !camera) return;
    
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    const gridNormal = new THREE.Vector3(0, -1, 0);
    const angle = cameraDirection.angleTo(gridNormal);
    const shouldBeVisible = angle < Math.PI / 2;
    const targetOpacity = shouldBeVisible ? originalGridOpacity : 0.0;
    
    gridHelper.traverse((child) => {
        if (child.material) {
            child.material.opacity = targetOpacity;
            // Для Line2 материала нужно обновить resolution при изменении размера окна
            if (child.material.resolution) {
                child.material.resolution.set(window.innerWidth, window.innerHeight);
            }
        }
    });
    
    isGridVisible = shouldBeVisible;
}
