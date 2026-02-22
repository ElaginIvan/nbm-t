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

    // Создаем цветные оси
    const axisLength = size / 2;
    const axesGroup = new THREE.Group();
    const axisWidth = 0.3; // Ширина полоски (видна сверху)
    
    // Ось X (красная) - плоскость вытянутая по X
    const planeX = new THREE.Mesh(
        new THREE.PlaneGeometry(axisLength * 2, axisWidth),
        new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: originalGridOpacity, side: THREE.DoubleSide })
    );
    planeX.rotation.x = -Math.PI / 2; // Кладем на пол
    // orientation: плоскость лежит, ее длина по X, ширина по Z
    axesGroup.add(planeX);
    
    // Ось Z (синяя) - плоскость вытянутая по Z
    const planeZ = new THREE.Mesh(
        new THREE.PlaneGeometry(axisWidth, axisLength * 2),
        new THREE.MeshBasicMaterial({ color: 0x0000ff, transparent: true, opacity: originalGridOpacity, side: THREE.DoubleSide })
    );
    planeZ.rotation.x = -Math.PI / 2; // Кладем на пол
    // orientation: плоскость лежит, ее длина по Z, ширина по X
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
}    const blueMat = new THREE.LineBasicMaterial({ color: 0x3366ff });
    for (let i = -halfSize; i <= halfSize; i += 0.3) {
        const points = [
            new THREE.Vector3(-halfSize, 0.01, i),
            new THREE.Vector3(halfSize, 0.01, i)
        ];
        if (Math.abs(i) < 0.1) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geo, blueMat);
        group.add(line);
    }
    
    // ЯРКИЕ ЦЕНТРАЛЬНЫЕ ОСИ
    const axisX = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-halfSize, 0.02, 0), new THREE.Vector3(halfSize, 0.02, 0)]),
        new THREE.LineBasicMaterial({ color: 0xff6666 })
    );
    group.add(axisX);
    
    const axisZ = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.02, -halfSize), new THREE.Vector3(0, 0.02, halfSize)]),
        new THREE.LineBasicMaterial({ color: 0x6666ff })
    );
    group.add(axisZ);
    
    // СВЕТЯЩИЕСЯ ТОЧКИ В УЗЛАХ (сетка 1м)
    const pointMat = new THREE.PointsMaterial({
        color: 0xff4466,
        size: 0.15,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending
    });
    
    const pointPositions = [];
    for (let i = -halfSize; i <= halfSize; i += 1.0) { // Узлы через 1 метр
        for (let j = -halfSize; j <= halfSize; j += 1.0) {
            pointPositions.push(i, 0.02, j);
        }
    }
    
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
    const points = new THREE.Points(pointGeo, pointMat);
    group.add(points);
    
    return group;
}

// Добавьте эту функцию после createRedNeonGrid
function addAtmosphericParticles(scene) {
    const particleGeometry = new THREE.BufferGeometry();
    const particleCount = 3000;
    const posArray = new Float32Array(particleCount * 3);
    const colorArray = new Float32Array(particleCount * 3);
    
    for (let i = 0; i < particleCount; i++) {
        // Частицы в большом объеме вокруг сцены
        posArray[i*3] = (Math.random() - 0.5) * 30;
        posArray[i*3+1] = (Math.random() - 0.5) * 15;
        posArray[i*3+2] = (Math.random() - 0.5) * 30;
        
        // Красноватые цвета (вариации красного)
        const r = 0.7 + Math.random() * 0.5;
        const g = 0.1 + Math.random() * 0.3;
        const b = 0.1 + Math.random() * 0.3;
        
        colorArray[i*3] = r;
        colorArray[i*3+1] = g;
        colorArray[i*3+2] = b;
    }
    
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    
    const particleMaterial = new THREE.PointsMaterial({
        size: 0.2,
        transparent: true,
        opacity: 0.3,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    
    const particles = new THREE.Points(particleGeometry, particleMaterial);
    particles.name = 'atmosphericParticles';
    scene.add(particles);
    
    return particles;
}

// И ИЗМЕНИТЕ createAdaptiveGrid на это:
export function createAdaptiveGrid(scene) {
    const size = 100;
    const divisions = 20;
    const mainGrid = new THREE.GridHelper(size, divisions, 0x888888, 0x444444);
    mainGrid.material.opacity = originalGridOpacity;
    mainGrid.material.transparent = true;

    // Создаем цветные оси
    const axisLength = size / 2;
    const axesGroup = new THREE.Group();
    const axisWidth = 0.3;
    
    const planeX = new THREE.Mesh(
        new THREE.PlaneGeometry(axisLength * 2, axisWidth),
        new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: originalGridOpacity, side: THREE.DoubleSide })
    );
    planeX.rotation.x = -Math.PI / 2;
    axesGroup.add(planeX);
    
    const planeZ = new THREE.Mesh(
        new THREE.PlaneGeometry(axisWidth, axisLength * 2),
        new THREE.MeshBasicMaterial({ color: 0x0000ff, transparent: true, opacity: originalGridOpacity, side: THREE.DoubleSide })
    );
    planeZ.rotation.x = -Math.PI / 2;
    axesGroup.add(planeZ);
    
    axesGroup.position.y = 0.001;

    const gridHelper = new THREE.Group();
    gridHelper.name = 'adaptiveGrid';
    gridHelper.add(mainGrid);
    gridHelper.add(axesGroup);

    // ДОБАВЛЯЕМ КРАСНУЮ НЕОНОВУЮ СЕТКУ
    // Размеры вашей модели: 3м длина, 2м ширина
    const redNeonGrid = createRedNeonGrid(100, 3, 2);
    redNeonGrid.position.y = 0.002; // Чуть выше основной сетки
    gridHelper.add(redNeonGrid);

    // ДОБАВЛЯЕМ АТМОСФЕРНЫЕ ЧАСТИЦЫ
    const particles = addAtmosphericParticles(scene);
    
    // ДОБАВЛЯЕМ ТУМАН
    scene.fog = new THREE.FogExp2(0x331111, 0.015);

    scene.add(gridHelper);
    return gridHelper;
}
/**
 * Создает красную неоновую сетку
 * @param {number} size - Размер сетки
 * @returns {THREE.Group} - Группа с красной сеткой
 */
function createRedNeonGrid(size) {
    const group = new THREE.Group();
    const halfSize = size / 2;
    
    // Основная сетка с красными линиями
    const redGrid = new THREE.GridHelper(size, 40, 0xff3333, 0xaa2222);
    redGrid.material.opacity = 0.3;
    redGrid.material.transparent = true;
    group.add(redGrid);
    
    // Красные линии X (часто)
    const redMat = new THREE.LineBasicMaterial({ color: 0xff3366 });
    for (let i = -halfSize; i <= halfSize; i += 1.5) {
        const points = [
            new THREE.Vector3(i, 0.01, -halfSize),
            new THREE.Vector3(i, 0.01, halfSize)
        ];
        if (Math.abs(i) < 0.5) continue; // Пропускаем центр
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geo, redMat);
        group.add(line);
    }
    
    // Синие линии Z (для контраста)
    const blueMat = new THREE.LineBasicMaterial({ color: 0x3366ff });
    for (let i = -halfSize; i <= halfSize; i += 1.5) {
        const points = [
            new THREE.Vector3(-halfSize, 0.01, i),
            new THREE.Vector3(halfSize, 0.01, i)
        ];
        if (Math.abs(i) < 0.5) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geo, blueMat);
        group.add(line);
    }
    
    // Центральные оси (яркие)
    const axisX = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-halfSize, 0.02, 0), new THREE.Vector3(halfSize, 0.02, 0)]),
        new THREE.LineBasicMaterial({ color: 0xff8888 })
    );
    group.add(axisX);
    
    const axisZ = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.02, -halfSize), new THREE.Vector3(0, 0.02, halfSize)]),
        new THREE.LineBasicMaterial({ color: 0x8888ff })
    );
    group.add(axisZ);
    
    // Светящиеся точки в узлах сетки
    const pointMat = new THREE.PointsMaterial({
        color: 0xff6666,
        size: 0.3,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending
    });
    
    const pointPositions = [];
    for (let i = -halfSize; i <= halfSize; i += 2) {
        for (let j = -halfSize; j <= halfSize; j += 2) {
            pointPositions.push(i, 0.02, j);
        }
    }
    
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
    const points = new THREE.Points(pointGeo, pointMat);
    group.add(points);
    
    // Добавляем несколько случайных сфер для эффекта "неона"
    const sphereMat = new THREE.MeshStandardMaterial({
        color: 0xff3366,
        emissive: 0x440000,
        emissiveIntensity: 2
    });
    
    for (let i = 0; i < 20; i++) {
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), sphereMat);
        sphere.position.set(
            (Math.random() - 0.5) * size * 0.8,
            0.1 + Math.random() * 0.5,
            (Math.random() - 0.5) * size * 0.8
        );
        group.add(sphere);
    }
    
    return group;
}

/**
 * Добавляет атмосферные частицы
 * @param {THREE.Scene} scene - Сцена
 */
function addAtmosphericParticles(scene) {
    const particleGeometry = new THREE.BufferGeometry();
    const particleCount = 2000;
    const posArray = new Float32Array(particleCount * 3);
    const colorArray = new Float32Array(particleCount * 3);
    
    for (let i = 0; i < particleCount; i++) {
        // Разбрасываем частицы в большом объеме
        posArray[i*3] = (Math.random() - 0.5) * 200;
        posArray[i*3+1] = (Math.random() - 0.5) * 100;
        posArray[i*3+2] = (Math.random() - 0.5) * 200;
        
        // Красноватые цвета для частиц (под цвет сетки)
        const r = 0.7 + Math.random() * 0.5;
        const g = 0.2 + Math.random() * 0.3;
        const b = 0.2 + Math.random() * 0.3;
        
        colorArray[i*3] = r;
        colorArray[i*3+1] = g;
        colorArray[i*3+2] = b;
    }
    
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    
    const particleMaterial = new THREE.PointsMaterial({
        size: 0.5,
        transparent: true,
        opacity: 0.3,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    
    particles = new THREE.Points(particleGeometry, particleMaterial);
    particles.name = 'atmosphericParticles';
    scene.add(particles);
}

/**
 * Добавляет туман в сцену
 * @param {THREE.Scene} scene - Сцена
 */
function addFog(scene) {
    // Красноватый экспоненциальный туман
    scene.fog = new THREE.FogExp2(0x442222, 0.008);
}

/**
 * Обновляет позицию и видимость сетки в зависимости от положения камеры
 * @param {THREE.Object3D} model - Загруженная модель
 * @param {THREE.Group} gridHelper - Группа сетки
 */
export function updateGridPosition(model, gridHelper) {
    if (!gridHelper || !model) return;

    // Получаем ограничивающую рамку модели
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // Определяем минимальную Y-координату модели
    const minY = box.min.y;

    // Помещаем сетку под модель с небольшим отступом
    gridHelper.position.set(center.x, minY - 0.01, center.z);

    // Масштабируем сетку в соответствии с размером модели
    const modelSize = Math.max(size.x, size.z);
    const gridScale = Math.max(modelSize * 1.5, 10);
    gridHelper.scale.set(gridScale / 100, 1, gridScale / 100);
}

/**
 * Проверяет ориентацию камеры и скрывает/показывает сетку
 * @param {THREE.Group} gridHelper - Группа сетки
 * @param {THREE.Camera} camera - Камера
 * @param {boolean} isGridVisible - Флаг видимости сетки
 */
export function checkCameraOrientation(gridHelper, camera, isGridVisible) {
    if (!gridHelper || !camera) return;
    
    // Получаем направление взгляда камеры
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    
    // Нормаль плоскости сетки (смотрит вверх)
    const gridNormal = new THREE.Vector3(0, 1, 0);
    
    // Угол между направлением камеры и нормалью сетки
    const angle = cameraDirection.angleTo(gridNormal);
    
    // Если камера смотрит вниз (угол близок к PI) - показываем сетку
    // Если камера смотрит вверх (угол близок к 0) - скрываем сетку
    const shouldBeVisible = angle > Math.PI / 4; // Показываем если смотрим достаточно сверху
    
    // Целевая прозрачность
    const targetOpacity = shouldBeVisible ? originalGridOpacity : 0.0;
    
    // Устанавливаем прозрачность для всех материалов
    gridHelper.traverse((child) => {
        if (child.material) {
            if (Array.isArray(child.material)) {
                child.material.forEach(mat => {
                    mat.opacity = targetOpacity;
                });
            } else {
                child.material.opacity = targetOpacity;
            }
        }
    });
    
    // Также управляем частицами (они видны только когда сетка видна)
    if (particles) {
        particles.material.opacity = shouldBeVisible ? 0.3 : 0.0;
    }
    
    return shouldBeVisible;
}

/**
 * Анимирует элементы окружения (частицы и т.д.)
 * @param {number} deltaTime - Время с последнего кадра
 */
export function animateEnvironment(deltaTime) {
    if (particles) {
        // Медленно вращаем частицы для создания эффекта движения
        particles.rotation.y += 0.0001 * deltaTime * 60;
    }
}

/**
 * Изменяет цвет тумана (можно вызвать при смене режима)
 * @param {number} r - Красный компонент (0-1)
 * @param {number} g - Зеленый компонент (0-1)
 * @param {number} b - Синий компонент (0-1)
 * @param {THREE.Scene} scene - Сцена
 */
export function setFogColor(r, g, b, scene) {
    if (scene.fog) {
        scene.fog.color.setRGB(r, g, b);
    }
}

/**
 * Изменяет плотность тумана
 * @param {number} density - Плотность тумана
 * @param {THREE.Scene} scene - Сцена
 */
export function setFogDensity(density, scene) {
    if (scene.fog) {
        scene.fog.density = density;
    }
                                  }
