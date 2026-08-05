/**
 * Плагин: Камера как фон (AR-примерка) - ФОТО-РЕЖИМ
 *
 * Использует фотокамеру для предпросмотра в высоком разрешении.
 * - Полный сенсор камеры (4:3, больше поле зрения)
 * - Высокое разрешение предпросмотра
 * - Фиксация кадра через ImageCapture (не скриншот видео)
 * - Финальный композит в высоком качестве
 *
 * Возможности:
 * - Фиксация кадра (заморозка) для наложения модели
 * - Тень от модели
 * - Регулировка FOV
 * - Скриншот с высоким разрешением
 */

import * as THREE from 'three';
import PluginManager from '../plugin-system.js';

// ============================================================
// СОСТОЯНИЕ ПЛАГИНА
// ============================================================

let _api = null;
let _videoEl = null;
let _stream = null;
let _boundHandlers = [];
let _modelLoadedHandler = null;
let _container = null;
let _cleanedUp = false;

// FOV
let _originalFov = 50;
const FOV_MIN = 15;
const FOV_MAX = 90;

// Пауза камеры (фиксация кадра)
let _cameraFrozen = false;
let _frozenCanvas = null; // замороженный кадр в высоком разрешении
let _isCapturing = false;
let _uploadedBgUrl = null;

// Магические числа
const FREEZE_JPEG_QUALITY = 0.80;
const TOAST_DURATION = 4000;
const TOAST_FADE = 300;
const FLASH_DURATION = 300;
const MODEL_LOAD_DELAY = 100;

// ============================================================
// РАБОТА С КАМЕРОЙ
// ============================================================

async function _startCamera() {
    _stopCamera();

    try {
        // Запрашиваем фото-сенсор 4:3 (идеал — что даст камера)
        const constraints = {
            video: {
                facingMode: 'environment',
                width: { ideal: 1920 },
                height: { ideal: 1440 },
                frameRate: { ideal: 15 }
            },
            audio: false
        };

        // aspectRatio поддерживается не везде (Firefox, старые мобильные)
        if (navigator.mediaDevices.getSupportedConstraints().aspectRatio) {
            constraints.video.aspectRatio = { ideal: 4 / 3 };
        }

        _stream = await navigator.mediaDevices.getUserMedia(constraints);

        if (_videoEl) {
            _videoEl.srcObject = _stream;
            await _videoEl.play();
            _videoEl.classList.add('camera-bg--active');
            _videoEl.classList.remove('camera-bg--frozen');
        }
    } catch (err) {
        console.error('[Camera] Ошибка доступа к камере:', err);
        _showCameraError(err);
    }
}

function _stopCamera() {
    if (_stream) {
        _stream.getTracks().forEach(track => track.stop());
        _stream = null;
    }
    if (_videoEl) {
        _videoEl.srcObject = null;
        _videoEl.classList.remove('camera-bg--active');
        _videoEl.style.backgroundImage = '';
        _videoEl.classList.remove('camera-bg--frozen');
    }
    _disposeFrozenCanvas();
    _cameraFrozen = false;
}

// ============================================================
// ФИКСАЦИЯ КАДРА (ЗАМОРОЗКА)
// ============================================================

async function _grabCameraFrame() {
    if (!_stream) return null;

    const track = _stream.getVideoTracks()[0];
    if (!track) return null;

    const imageCapture = new ImageCapture(track);
    const bitmap = await imageCapture.grabFrame();

    try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        return { canvas, width: bitmap.width, height: bitmap.height };
    } finally {
        bitmap.close();
    }
}

async function _freezeCamera() {
    if (_isCapturing || !_stream || !_videoEl || _cameraFrozen) return;

    _isCapturing = true;

    try {
        // Локальная копия — _stream может стать null после await
        const stream = _stream;
        const result = await _grabCameraFrame();
        if (!result) return;

        // Сохраняем canvas для скриншота
        _frozenCanvas = result.canvas;

        // Blob URL для CSS-фона (асинхронно, не блокирует поток)
        const blob = await new Promise(resolve =>
            result.canvas.toBlob(resolve, 'image/jpeg', FREEZE_JPEG_QUALITY)
        );
        if (blob) {
            _videoEl.style.backgroundImage = `url(${URL.createObjectURL(blob)})`;
        }
        _videoEl.classList.add('camera-bg--frozen');

        // Останавливаем поток (освобождаем камеру)
        if (_stream === stream) {
            stream.getTracks().forEach(t => t.stop());
            _stream = null;
            _videoEl.srcObject = null;
        }

        _cameraFrozen = true;
        _updatePauseBtnUI();

        // Сигнализируем другим плагинам (например view-display),
        // что камера заморожена — можно перейти в manual-режим тени.
        // События обрабатываются опционально: если слушателя нет — просто игнорируется.
        window.dispatchEvent(new CustomEvent('cameraFrozen', {
            detail: { width: result.width, height: result.height }
        }));

    } catch (err) {
        console.error('[FreezeCamera] Ошибка фиксации кадра:', err);
        _showCameraError(err);
    }

    _isCapturing = false;
}

function _unfreezeCamera() {
    if (!_videoEl || !_cameraFrozen) return;

    _videoEl.style.backgroundImage = '';
    _videoEl.classList.remove('camera-bg--frozen');

    _disposeFrozenCanvas();
    _cameraFrozen = false;
    _updatePauseBtnUI();

    // Сигнализируем другим плагинам, что AR-режим заморозки снят.
    window.dispatchEvent(new CustomEvent('cameraResumed'));

    // Перезапускаем камеру
    _startCamera();
}

function _toggleCameraPause() {
    if (_cameraFrozen) {
        _unfreezeCamera();
    } else {
        _freezeCamera();
    }
}

function _disposeFrozenCanvas() {
    if (_frozenCanvas) {
        _frozenCanvas.width = 0;
        _frozenCanvas.height = 0;
        _frozenCanvas = null;
    }
    // Очищаем Blob URL из DOM
    if (_videoEl) {
        _videoEl.style.backgroundImage = '';
    }
    // Очищаем URL загруженного изображения
    if (_uploadedBgUrl) {
        URL.revokeObjectURL(_uploadedBgUrl);
        _uploadedBgUrl = null;
    }
}

function _updatePauseBtnUI() {
    const btn = document.getElementById('cam-pause-btn');
    if (!btn) return;

    const isPaused = _cameraFrozen;
    btn.classList.toggle('active', isPaused);
    btn.title = isPaused ? 'Продолжить' : 'Пауза';
    btn.innerHTML = isPaused
        ? '<svg><use xlink:href="assets/icons/sprite.svg#play"></use></svg>'
        : '<svg><use xlink:href="assets/icons/sprite.svg#pause"></use></svg>';
}

// ============================================================
// ПОКАЗ ОШИБОК
// ============================================================

function _showCameraError(err) {
    const existing = document.getElementById('cam-error-toast');
    if (existing) existing.remove();

    let message = 'Не удалось получить доступ к камере';
    if (err.name === 'NotAllowedError') {
        message = 'Доступ к камере запрещён. Разрешите доступ в настройках браузера.';
    } else if (err.name === 'NotFoundError') {
        message = 'Камера не найдена на этом устройстве.';
    } else if (err.name === 'NotReadableError') {
        message = 'Камера занята другим приложением.';
    } else if (err.name === 'NotSupportedError') {
        message = 'ImageCapture не поддерживается в этом браузере.';
    }

    const toast = document.createElement('div');
    toast.id = 'cam-error-toast';
    toast.className = 'cam-error-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), TOAST_FADE);
    }, TOAST_DURATION);
}

function _hideCameraError() {
    const toast = document.getElementById('cam-error-toast');
    if (toast) toast.remove();
}

// ============================================================
// УПРАВЛЕНИЕ FOV
// ============================================================

function _setFov(degrees) {
    if (!_api || !_api.camera) return;
    const fov = Math.max(FOV_MIN, Math.min(FOV_MAX, degrees));
    const oldFov = _api.camera.fov;
    if (Math.abs(fov - oldFov) < 0.01) return;

    // Точка, на которую смотрит камера (центр орбиты)
    const target = _api.controls?.target || new THREE.Vector3(0, 0, 0);
    const offset = _api.camera.position.clone().sub(target);
    const currentDistance = offset.length();

    // Компенсация: при увеличении FOV камера приближается, чтобы модель не смещалась
    const oldTan = Math.tan(THREE.MathUtils.degToRad(oldFov / 2));
    const newTan = Math.tan(THREE.MathUtils.degToRad(fov / 2));
    const newDistance = currentDistance * oldTan / newTan;

    // Сдвигаем камеру вдоль того же направления
    const direction = offset.normalize();
    _api.camera.position.copy(target.clone().add(direction.multiplyScalar(newDistance)));

    _api.camera.fov = fov;
    _api.camera.updateProjectionMatrix();

    // Синхронизируем OrbitControls с новой позицией
    if (_api.controls) _api.controls.update();
}

function _restoreFov() {
    if (!_api || !_api.camera) return;
    _api.camera.fov = _originalFov;
    _api.camera.updateProjectionMatrix();
}

function _updateFovLabel(degrees) {
    const label = document.getElementById('cam-fov-value');
    if (label) label.textContent = Math.round(degrees) + '°';
}

// ============================================================
// СОЗДАНИЕ VIDEO ЭЛЕМЕНТА
// ============================================================

function _createVideoElement(container) {
    const video = document.createElement('video');
    video.id = 'camera-bg-video';
    video.className = 'camera-bg-video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.setAttribute('playsinline', '');

    const canvas = container.querySelector('#viewer') || container.querySelector('canvas');
    if (canvas && canvas.parentNode === container) {
        container.insertBefore(video, canvas);
    } else {
        container.prepend(video);
    }

    return video;
}

// ============================================================
// СКРИНШОТ (JPEG СЖАТИЕ)
// ============================================================

async function _takeScreenshot() {
    if (!_videoEl || !_api || !_api.renderer || _isCapturing) return;

    _isCapturing = true;

    try {
        const renderer = _api.renderer;
        const camera = _api.camera;
        const threeCanvas = renderer.domElement;

        // Получаем источник изображения
        let imageSource = null;
        let sourceWidth = 0;
        let sourceHeight = 0;

        if (_cameraFrozen && _frozenCanvas) {
            imageSource = _frozenCanvas;
            sourceWidth = _frozenCanvas.width;
            sourceHeight = _frozenCanvas.height;
        } else if (_videoEl.readyState >= 2 && _stream) {
            try {
                const result = await _grabCameraFrame();
                if (result) {
                    imageSource = result.canvas;
                    sourceWidth = result.width;
                    sourceHeight = result.height;
                }
            } catch (err) {
                console.warn('[Screenshot] Не удалось захватить кадр:', err);
            }
            if (!imageSource) {
                imageSource = _videoEl;
                sourceWidth = _videoEl.videoWidth;
                sourceHeight = _videoEl.videoHeight;
            }
        } else {
            return;
        }

        // === РАЗМЕР ===
        let targetW = sourceWidth;
        let targetH = sourceHeight;
        const MAX_SIZE = 1920;

        if (targetW > MAX_SIZE || targetH > MAX_SIZE) {
            const ratio = Math.min(MAX_SIZE / targetW, MAX_SIZE / targetH);
            targetW = Math.round(targetW * ratio);
            targetH = Math.round(targetH * ratio);
        }

        // Чётные размеры (требование JPEG)
        targetW = Math.round(targetW / 2) * 2;
        targetH = Math.round(targetH / 2) * 2;

        if (targetW === 0 || targetH === 0) return;

        // === Сохраняем состояние рендерера ===
        const origSize = new THREE.Vector2();
        renderer.getSize(origSize);
        const origPixelRatio = renderer.getPixelRatio();
        const origAspect = camera.aspect;
        const origCanvasStyleW = threeCanvas.style.width;
        const origCanvasStyleH = threeCanvas.style.height;

        // === Рендерим модель ===
        renderer.setPixelRatio(1);
        renderer.setSize(targetW, targetH, false);
        camera.aspect = targetW / targetH;
        camera.updateProjectionMatrix();
        renderer.render(_api.scene, camera);

        // === Композит ===
        const offscreen = document.createElement('canvas');
        offscreen.width = targetW;
        offscreen.height = targetH;
        const ctx = offscreen.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // 1) Фото фон
        ctx.drawImage(imageSource, 0, 0, targetW, targetH);

        // 2) Модель поверх
        ctx.drawImage(threeCanvas, 0, 0, targetW, targetH);

        // === Восстанавливаем рендерер ===
        renderer.setPixelRatio(origPixelRatio);
        renderer.setSize(origSize.x, origSize.y, false);
        if (origCanvasStyleW !== undefined) threeCanvas.style.width = origCanvasStyleW;
        if (origCanvasStyleH !== undefined) threeCanvas.style.height = origCanvasStyleH;
        camera.aspect = origAspect;
        camera.updateProjectionMatrix();

        // === Сохраняем в JPEG ===
        offscreen.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ar-photo-${Date.now()}.jpg`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 'image/jpeg', FREEZE_JPEG_QUALITY);

        _flashCapture();
    } finally {
        _isCapturing = false;
    }
}

function _flashCapture() {
    const flash = document.createElement('div');
    flash.className = 'cam-capture-flash';
    _container.appendChild(flash);
    requestAnimationFrame(() => {
        flash.classList.add('cam-capture-flash--fire');
        setTimeout(() => flash.remove(), FLASH_DURATION);
    });
}

// ============================================================
// ЗАГРУЗКА ФОТО КАК ФОН
// ============================================================

function _uploadPhoto() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    const cleanup = () => { if (input.parentNode) input.remove(); };

    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        cleanup();
        if (file) await _loadImageFile(file);
    });

    input.addEventListener('cancel', cleanup);
    input.click();
}

async function _loadImageFile(file) {
    if (!_videoEl) return;

    // Останавливаем камеру если работает
    if (_stream) {
        _stream.getTracks().forEach(t => t.stop());
        _stream = null;
        _videoEl.srcObject = null;
    }
    _videoEl.classList.remove('camera-bg--active');

    try {
        // Загружаем изображение
        const url = URL.createObjectURL(file);
        const img = new Image();

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });

        // Создаём canvas для скриншота (в полном разрешении фото)
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);

        _frozenCanvas = canvas;

        // CSS фон
        if (_uploadedBgUrl) URL.revokeObjectURL(_uploadedBgUrl);
        _uploadedBgUrl = url;
        _videoEl.style.backgroundImage = `url(${url})`;
        _videoEl.classList.add('camera-bg--frozen');
        _videoEl.classList.add('camera-bg--active');

        _cameraFrozen = true;
        _updatePauseBtnUI();

        // Событие для других плагинов (например view-display — тень в manual-режим)
        window.dispatchEvent(new CustomEvent('cameraFrozen', {
            detail: { width: canvas.width, height: canvas.height }
        }));
    } catch (err) {
        console.error('[UploadPhoto] Ошибка загрузки изображения:', err);
        _showCameraError({ name: 'UploadError', message: 'Не удалось загрузить изображение' });
    }
}

// ============================================================
// ОЧИСТКА
// ============================================================

function _cleanup() {
    if (_cleanedUp) return;
    _cleanedUp = true;

    for (const { el, type, handler } of _boundHandlers) {
        el.removeEventListener(type, handler);
    }
    _boundHandlers = [];
    if (_modelLoadedHandler) {
        window.removeEventListener('modelLoaded', _modelLoadedHandler);
        _modelLoadedHandler = null;
    }
    _restoreFov();
    _stopCamera();
    _removeVideoElement();
    _hideCameraError();
    _api = null;
}

function _removeVideoElement() {
    if (_videoEl && _videoEl.parentNode) {
        _videoEl.parentNode.removeChild(_videoEl);
    }
    _videoEl = null;
}

// ============================================================
// РЕГИСТРАЦИЯ ПЛАГИНА
// ============================================================

PluginManager.register({
    id: 'camera-background',
    name: 'Камера (AR)',
    icon: 'camera',
    module: '3d-viewer',

    condition: () => true,

    init(pluginApi) {
        _container = document.getElementById('model-container');
        if (!_container) return () => { _api = null; };

        _api = pluginApi;
        _cleanedUp = false;

        // Видео элемент
        _videoEl = _createVideoElement(_container);

        // Запоминаем FOV
        if (_api.camera) {
            _originalFov = _api.camera.fov;
        }

        // Запускаем камеру
        _startCamera();

        return () => _cleanup();
    },

    destroy() {
        _cleanup();
    },

    panel: {
        className: 'cam-panel plugin-pill',

        html: `
            <div class="cam-group plugin-pill-group">
                <button class="cam-btn plugin-pill-btn" id="cam-pause-btn" title="Пауза">
                    <svg><use xlink:href="assets/icons/sprite.svg#pause"></use></svg>
                </button>
                <button class="cam-btn plugin-pill-btn" id="cam-upload-btn" title="Загрузить фото">
                    <svg><use xlink:href="assets/icons/sprite.svg#image-add"></use></svg>
                </button>
                <button class="cam-btn plugin-pill-btn" id="cam-screenshot-btn" title="Фото">
                    <svg><use xlink:href="assets/icons/sprite.svg#camera"></use></svg>
                </button>
            </div>
            <div class="cam-pill-divider plugin-pill-divider"></div>
            <div class="cam-fov-group">
                <input type="range" id="cam-fov-slider" class="cam-fov-slider" min="${FOV_MIN}" max="${FOV_MAX}" step="1" value="${_originalFov}">
                <span class="cam-fov-label" id="cam-fov-value">${_originalFov}°</span>
            </div>
        `,

        onMount() {
            // Хелпер привязки кнопок
            const bind = (id, type, handler) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.addEventListener(type, handler);
                _boundHandlers.push({ el, type, handler });
            };

            bind('cam-pause-btn', 'click', _toggleCameraPause);
            bind('cam-upload-btn', 'click', _uploadPhoto);
            bind('cam-screenshot-btn', 'click', _takeScreenshot);

            const fovSlider = document.getElementById('cam-fov-slider');
            if (fovSlider) {
                const h = () => {
                    const val = parseFloat(fovSlider.value);
                    _setFov(val);
                    _updateFovLabel(val);
                };
                fovSlider.addEventListener('input', h);
                _boundHandlers.push({ el: fovSlider, type: 'input', handler: h });
            }

            // Начальное состояние UI
            _updatePauseBtnUI();
        },

        onUnmount() {
            _cleanup();
        }
    }
});