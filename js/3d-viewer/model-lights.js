/**
 * Настраивает освещение сцены для максимальной читаемости граней
 * @param {THREE.Scene} scene - Сцена для добавления света
 */
export function setupLights(scene) {
    // ВАЖНО: AmbientLight убираем полностью или делаем очень слабым
    // Он убивает контраст! Комментарим или ставим 0.1
    // const ambientLight = new THREE.AmbientLight(0xffffff, 0.8); // <-- ЭТО БЫЛО ПЛОХО
    const ambientLight = new THREE.AmbientLight(0x404060, 0.15); // Еле заметный холодный фон
    scene.add(ambientLight);

    // 1. ВЕРХНИЙ СВЕТ (Ключевой)
    // Делаем его теплым и ярким, он будет главным
    const topLight = new THREE.DirectionalLight(0xffeedd, 1.2); // Теплый белый
    topLight.position.set(5, 20, 10); // Не строго сверху, а под углом
    scene.add(topLight);

    // 2. НИЖНИЙ СВЕТ (Подсветка снизу)
    // Делаем холодным и слабым, чтобы создать легкое свечение
    const bottomLight = new THREE.DirectionalLight(0xaaccff, 0.25); // Холодный голубой
    bottomLight.position.set(0, -15, 5);
    scene.add(bottomLight);

    // 3. СВЕТ СПЕРЕДИ-СЛЕВА (Заполняющий)
    // Делаем средней яркости, теплый, чтобы смягчить тени
    const frontLight = new THREE.DirectionalLight(0xffccaa, 0.6);
    frontLight.position.set(-20, 10, 25);
    scene.add(frontLight);

    // 4. СВЕТ СЗАДИ-СПРАВА (Контровой/Rim Light)
    // САМЫЙ ВАЖНЫЙ для отделения граней от фона!
    // Холодный и довольно яркий
    const backLight = new THREE.DirectionalLight(0xccddff, 0.9);
    backLight.position.set(25, 5, -25);
    scene.add(backLight);
    
    // 5. ДОПОЛНИТЕЛЬНЫЙ БОКОВОЙ СВЕТ (опционально)
    // Если нужно еще больше подчеркнуть текстуру
    const sideLight = new THREE.DirectionalLight(0xffffff, 0.4);
    sideLight.position.set(-15, 5, 5);
    scene.add(sideLight);
}    bottomLight.position.set(0, -12, 5);
    scene.add(bottomLight);

    // 4. ЗАПОЛНЯЮЩИЙ СВЕТ СПЕРЕДИ
    const fillLight = new THREE.DirectionalLight(0xffddcc, 0.7);
    fillLight.position.set(-15, 8, 20);
    scene.add(fillLight);

    // 5. КОНТРОВОЙ СВЕТ СЗАДИ
    const backLight = new THREE.DirectionalLight(0xcceeff, 0.8);
    backLight.position.set(20, 5, -20);
    scene.add(backLight);

    // 6. ДОПОЛНИТЕЛЬНЫЙ БОКОВОЙ
    const sideLight = new THREE.DirectionalLight(0xffffff, 0.5);
    sideLight.position.set(-10, 10, -5);
    scene.add(sideLight);

    console.log('Презентационное освещение применено');
}
