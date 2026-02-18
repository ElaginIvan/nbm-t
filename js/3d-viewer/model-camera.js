/**
 * Настраивает камеру, рендерер и элементы управления
 * @param {HTMLElement} container - Контейнер для 3D-просмотра
 * @param {HTMLCanvasElement} canvas - Canvas элемент
 * @returns {Object} Объект с камерой, рендерером и контролами
 */
export function setupCamera(container, canvas) {
    // Создаем камеру
    const camera = new THREE.PerspectiveCamera(26, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(5, 5, 5);

    // Создаем рендерер с поддержкой clipping planes
    const renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: true,
        stencil: true, // Добавляем поддержку stencil buffer
        depth: true,
        powerPreference: "high-performance"
    });
    
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0); // Прозрачный фон
    
    // ВАЖНО: Включаем поддержку clipping planes
    renderer.localClippingEnabled = true;
    
    console.log('Renderer created with localClippingEnabled:', renderer.localClippingEnabled);

    // Добавляем управление
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    return { camera, renderer, controls };
}