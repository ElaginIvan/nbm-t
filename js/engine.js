/**
 * 3D Engine Module — ядро рендеринга.
 * Минимальный набор: камера, свет, ресайз. Остальное (тени, сетка, рёбра) — в плагинах.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

function setupCamera(container, canvas) {
    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(5, 5, 5);

    const renderer = new THREE.WebGLRenderer({
        canvas, antialias: true, alpha: true,
        stencil: true, depth: true
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Карта теней обновляется по needsUpdate (см. view-display.js, 3d-viewer.js).
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.3;

    return { camera, renderer, controls };
}

function setupLights(scene) {
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight.position.set(0, 50, 0);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 1.3);
    fillLight.position.set(0, -10, 0);
    scene.add(fillLight);
}

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

function initResizeListener(camera, renderer, onResize) {
    const handler = () => handleWindowResize(camera, renderer, onResize);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
}

export { setupCamera, setupLights, handleWindowResize, initResizeListener };
