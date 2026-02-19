export function setupPresentationLights(scene, renderer) {
    // Настраиваем рендерер на качественные тени
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Мягкие тени
    renderer.shadowMap.bias = 0.0001;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; // Киношная цветопередача
    renderer.toneMappingExposure = 1.2;

    // Убираем ambient почти полностью
    const ambient = new THREE.AmbientLight(0x404060, 0.05);
    scene.add(ambient);

    // ГЛАВНЫЙ ИСТОЧНИК (как большой софтбокс)
    const keyLight = new THREE.DirectionalLight(0xfff5e6, 1.8);
    keyLight.position.set(5, 12, 10);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;  // Качество теней
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.bias = -0.0005;
    
    // Настраиваем область теней так, чтобы покрыть контейнер
    const d = 15;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 25;
    keyLight.shadow.normalBias = 0.05; // Убираем артефакты теней
    
    scene.add(keyLight);
    
    // Визуализация камеры теней (для отладки)
    // scene.add(new THREE.CameraHelper(keyLight.shadow.camera));

    // ЗАПОЛНЯЮЩИЙ СВЕТ (без теней, мягкий)
    const fillLight = new THREE.DirectionalLight(0xe6f0ff, 0.6);
    fillLight.position.set(-5, 5, 8);
    scene.add(fillLight);

    // КОНТРОВОЙ СВЕТ (сзади)
    const backLight = new THREE.DirectionalLight(0xffffff, 0.5);
    backLight.position.set(0, 5, -12);
    scene.add(backLight);

    // НИЖНЯЯ ПОДСВЕТКА (чтобы дно не было черным)
    const bottomLight = new THREE.PointLight(0x446688, 0.3);
    bottomLight.position.set(0, -3, 2);
    scene.add(bottomLight);
}
