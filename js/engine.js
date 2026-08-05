/**
 * 3D Engine Module — ядро рендеринга
 *
 * Минимальный набор для отображения 3D-сцены:
 * - setupCamera — камера, рендерер, OrbitControls
 * - setupLights — базовое освещение (без теней)
 * - handleWindowResize / initResizeListener — обработка ресайза
 *
 * ВСЁ остальное (тени, сетка, рёбра) — создаётся и управляется плагинами.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

// ============================================================
// КАМЕРА
// ============================================================

function setupCamera(container, canvas) {
    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(5, 5, 5);

    const renderer = new THREE.WebGLRenderer({
        canvas, antialias: true, alpha: true,
        stencil: true, depth: true, powerPreference: 'high-performance'
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.3;

    return { camera, renderer, controls };
}

// ============================================================
// СВЕТ — базовое освещение без теней
// Тени добавляются плагином view-display (DirectionalLight с castShadow).
// ============================================================

function setupLights(scene) {
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight.position.set(0, 50, 0);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 1.3);
    fillLight.position.set(0, -10, 0);
    scene.add(fillLight);
}

// ============================================================
// RESIZE (обработка изменения размеров контейнера)
// ============================================================

/**
 * Обновляет размеры рендерера и камеры.
 * @param {THREE.Camera} camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {Function} [onResize] — колбэк, вызываемый после ресайза
 */
function handleWindowResize(camera, renderer, onResize) {
    const container = document.getElementById('model-container');
    if (!container || !camera || !renderer) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    if (typeof onResize === 'function') onResize();
}

/**
 * Добавляет слушатель resize на window, возвращает функцию очистки.
 * @param {THREE.Camera} camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {Function} [onResize]
 * @returns {Function} cleanup — функция для снятия слушателя
 */
function initResizeListener(camera, renderer, onResize) {
    const handler = () => handleWindowResize(camera, renderer, onResize);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
}

// ============================================================
// ЭКСПОРТ
// ============================================================

export {
    // Камера
    setupCamera,
    // Свет
    setupLights,
    // Resize
    handleWindowResize,
    initResizeListener
};
