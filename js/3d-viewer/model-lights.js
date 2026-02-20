export function setupLights(scene) {
    // 1. Фоновое освещение с СВЕТЛЫМ низом
    // Теплое небо + светло-серая "земля" вместо черной
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xe0e0e0, 0.5);
    scene.add(hemiLight);

    // 2. Ключевой свет - основной, яркий
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
    mainLight.position.set(5, 10, 7);
    mainLight.castShadow = false; // Отключаем тени для производительности, если не нужны
    scene.add(mainLight);

    // 3. Заполняющий свет - УСИЛЕННЫЙ, чтобы подсветить низ
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    fillLight.position.set(-5, 0, -5); // Чуть ниже, чтобы лучше светить в "подбрюшье"
    scene.add(fillLight);

    // 4. Контровой свет - для отделения от фона
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.7);
    rimLight.position.set(0, 5, -10);
    scene.add(rimLight);

    // 5. Легкий Ambient как "страховка" от полного черного
    // Очень слабый, только чтобы не было pure black в тенях
    const ambientBoost = new THREE.AmbientLight(0xffffff, 0.15);
    scene.add(ambientBoost);
    
    return { mainLight, fillLight, rimLight, hemiLight, ambientBoost };
}
