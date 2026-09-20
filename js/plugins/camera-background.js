/**
 * Камера как фон (AR-примерка, фото-режим).
 * Полный сенсор 4:3, фиксация кадра через ImageCapture,
 * регулировка FOV, скриншот в высоком разрешении с CSS2D-метками.
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
let _container = null;
let _cleanedUp = false;

// Счётчик поколений сессии: await'ы после resume сверяют поколение с актуальным
// и гасят устаревший поток, чтобы не держать камеру вечно (критичный баг C2).
let _cameraGeneration = 0;

// Обработчик видимости вкладки (регистрируется в init, снимается в _cleanup).
let _visibilityHandler = null;

// FOV
let _originalFov = 50;
let _originalCameraPos = null; // позиция камеры на момент активации плагина
const FOV_MIN = 15;
const FOV_MAX = 90;

// Пауза камеры (фиксация кадра)
let _cameraFrozen = false;
let _frozenCanvas = null; // замороженный кадр в высоком разрешении
let _isCapturing = false;
let _uploadedBgUrl = null;
let _freezeBgUrl = null;  // Blob URL замороженного кадра для CSS-фона

// Магические числа
const FREEZE_JPEG_QUALITY = 0.80;
const TOAST_DURATION = 4000;
const TOAST_FADE = 300;
const FLASH_DURATION = 300;

// ============================================================
// РАБОТА С КАМЕРОЙ
// ============================================================

// Скрытая вкладка не должна держать конвейер камеры: снимаем только pipeline
// (video.pause() + track.enabled=false), дорожки НЕ останавливаем — иначе AR-сессия
// сломается и потребует повторных разрешений.
function _handleVisibilityChange() {
    const video = _videoEl;
    const stream = _stream;
    // Заморозка/фото-фон живого потока не имеют — им пауза не нужна
    if (!video || !stream) return;

    if (document.hidden) {
        try { video.pause(); } catch (_) { /* noop */ }
        stream.getTracks().forEach(t => { t.enabled = false; });
    } else {
        stream.getTracks().forEach(t => { t.enabled = true; });
        // play() может отклониться, если за время скрытия сессию погасили — глушим.
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    }
}

async function _startCamera() {
    const generation = ++_cameraGeneration;
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

        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        // Если за время await плагин деактивировали/перезапустили — гасим поток
        // немедленно, иначе камера останется включённой навсегда (C2).
        if (generation !== _cameraGeneration || _cleanedUp) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }

        _stream = stream;

        if (_videoEl) {
            _videoEl.srcObject = _stream;
            await _videoEl.play();

            // play() тоже асинхронен — перепроверяем актуальность сессии
            if (generation !== _cameraGeneration || _cleanedUp) {
                _stopCamera();
                return;
            }

            _videoEl.classList.add('camera-bg--active');
            _videoEl.classList.remove('camera-bg--frozen');

            // Если вкладка УЖЕ скрыта в момент старта — сразу снимаем конвейер
            // (visibilitychange сработает только при следующем переключении).
            if (document.hidden) _handleVisibilityChange();
        }
    } catch (err) {
        // Ошибки устаревшей сессии не показываем — плагин уже не активен
        if (generation === _cameraGeneration && !_cleanedUp) {
            console.error('[Camera] Ошибка доступа к камере:', err);
            _showCameraError(err);
        }
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

    // Без явной проверки ImageCapture выбрасывает ReferenceError и юзер видит
    // неверное сообщение «нет доступа к камере».
    if (typeof ImageCapture === 'undefined') {
        const err = new Error('ImageCapture API не поддерживается в этом браузере');
        err.name = 'NotSupportedError';
        throw err;
    }

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
        const stream = _stream;
        const result = await _grabCameraFrame();
        if (!result) return;

        _frozenCanvas = result.canvas;

        // Blob URL для CSS-фона. Запоминаем и ревокаем в _disposeFrozenCanvas/_loadImageFile,
        // иначе каждый freeze даёт утечку blob-JPEG.
        const blob = await new Promise(resolve =>
            result.canvas.toBlob(resolve, 'image/jpeg', FREEZE_JPEG_QUALITY)
        );
        if (blob) {
            if (_freezeBgUrl) URL.revokeObjectURL(_freezeBgUrl);
            _freezeBgUrl = URL.createObjectURL(blob);
            if (_videoEl) _videoEl.style.backgroundImage = `url(${_freezeBgUrl})`;
        }
        if (_videoEl) _videoEl.classList.add('camera-bg--frozen');

        // Останавливаем поток (освобождаем камеру).
        if (_stream === stream) {
            stream.getTracks().forEach(t => t.stop());
            _stream = null;
            if (_videoEl) _videoEl.srcObject = null;
        }

        _cameraFrozen = true;
        _updatePauseBtnUI();

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
    // Очищаем Blob URL замороженного кадра из DOM и памяти
    if (_freezeBgUrl) {
        URL.revokeObjectURL(_freezeBgUrl);
        _freezeBgUrl = null;
    }
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
    } else if (err.name === 'UploadError') {
        message = err.message || 'Не удалось загрузить изображение.';
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
    // Возвращаем и позицию камеры: _setFov сдвигает её (dolly-компенсация),
    // без этого после деактивации камера остаётся приближенной/отодвинутой
    if (_originalCameraPos) {
        _api.camera.position.copy(_originalCameraPos);
        if (_api.controls) _api.controls.update();
        _originalCameraPos = null;
    }
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
// ОТРИСОВКА CSS2D-МЕТОК НА CANVAS
// ============================================================

/** Найти DOM-элемент CSS2DRenderer в контейнере. */
function _findCSS2DOverlay() {
    if (!_container) return null;
    const ch = _container.children;
    for (let i = 0; i < ch.length; i++) {
        const el = ch[i];
        if (el.tagName === 'DIV' &&
            el.style.position === 'absolute' &&
            el.style.pointerEvents === 'none' &&
            el !== _videoEl &&
            el.id !== 'viewer' &&
            !el.classList.contains('plugin-dock') &&
            !el.classList.contains('plugin-panels') &&
            !el.classList.contains('cam-capture-flash') &&
            !el.classList.contains('touch-ripple')) {
            return el;
        }
    }
    return null;
}

/** Распарсить translate(Xpx, Ypx) из CSS-трансформа CSS2DRenderer. */
function _parseCSS2DTransform(el) {
    const style = el.style.transform;
    if (!style) return null;
    let last = null;
    for (const m of style.matchAll(/translate\(([^,]+),\s*([^)]+)\)/g)) last = m;
    if (!last) return null;
    const xS = last[1].trim(), yS = last[2].trim();
    if (xS.endsWith('%') || yS.endsWith('%')) return null;
    const x = parseFloat(xS), y = parseFloat(yS);
    return (isNaN(x) || isNaN(y)) ? null : { x, y };
}

/** Отрисовать CSS2D-метки на offscreen-канвасе: фон + рамка + текст (Canvas 2D). */
function _drawCSS2DLabels(ctx, srcW, srcH, dstW, dstH) {
    const overlay = _findCSS2DOverlay();
    if (!overlay) return;
    const sx = dstW / srcW, sy = dstH / srcH;

    const labels = [];
    for (let i = 0; i < overlay.children.length; i++) {
        const c = overlay.children[i];
        if (c.offsetParent === null) continue;
        const pos = _parseCSS2DTransform(c);
        if (pos) labels.push({ el: c, pos });
    }
    if (!labels.length) return;

    for (const { el, pos } of labels) {
        const text = el.textContent;
        if (!text) continue;

        const cx = pos.x * sx, cy = pos.y * sy;
        const cs = getComputedStyle(el);
        const color = cs.color || '#ff9e64';
        const fs = parseFloat(cs.fontSize) || 16;
        const ff = cs.fontFamily || 'monospace';
        const fw = cs.fontWeight || 'bold';
        const pH = (parseFloat(cs.paddingLeft) || 4) + (parseFloat(cs.paddingRight) || 8);
        const pV = (parseFloat(cs.paddingTop) || 4) + (parseFloat(cs.paddingBottom) || 4);
        const br = parseFloat(cs.borderRadius) || 6;
        const bw = parseFloat(cs.borderWidth) || 1;
        const bc = cs.borderColor || color;
        const bg = cs.backgroundColor || 'rgba(10,10,30,0.85)';

        const sfs = fs * sx, spH = pH * sx, spV = pV * sy;
        const sbr = br * sx, sbw = bw * sx;

        ctx.font = `${fw} ${sfs}px ${ff}`;
        const tw = ctx.measureText(text).width;
        const boxW = tw + spH, boxH = sfs + spV;
        const bx = cx - boxW / 2, by = cy - boxH / 2;

        ctx.save();

        // Фон
        ctx.fillStyle = bg;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, sbr);
        else { ctx.rect(bx, by, boxW, boxH); }
        ctx.fill();

        // Рамка
        if (sbw > 0) {
            ctx.strokeStyle = bc;
            ctx.lineWidth = sbw;
            ctx.stroke();
        }

        // Текст
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = sx;
        ctx.shadowOffsetX = sx;
        ctx.shadowOffsetY = sx;
        ctx.fillText(text, cx, cy);

        ctx.restore();
    }
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
        const srcW = origSize.x, srcH = origSize.y;

        // === Рендерим модель ===
        // ВАЖНО: drawing buffer three.js (preserveDrawingBuffer:false) очищается при
        // setSize(), поэтому копируем threeCanvas в обычный 2D-канвас НЕМЕДЛЕННО после
        // render() — до restore-секции в finally. Иначе модель и линии измерений
        // пропадут из фото (останутся только CSS2D-метки, читаемые из DOM).
        let modelBuffer = null;
        try {
            renderer.setPixelRatio(1);
            renderer.setSize(targetW, targetH, false);
            camera.aspect = targetW / targetH;
            camera.updateProjectionMatrix();
            renderer.render(_api.scene, camera);

            // Снимок threeCanvas в обычный 2D-канвас — ДО восстановления размера рендерера.
            modelBuffer = document.createElement('canvas');
            modelBuffer.width = targetW;
            modelBuffer.height = targetH;
            modelBuffer.getContext('2d').drawImage(threeCanvas, 0, 0, targetW, targetH);
        } finally {
            renderer.setPixelRatio(origPixelRatio);
            renderer.setSize(origSize.x, origSize.y, false);
            if (origCanvasStyleW !== undefined) threeCanvas.style.width = origCanvasStyleW;
            if (origCanvasStyleH !== undefined) threeCanvas.style.height = origCanvasStyleH;
            camera.aspect = origAspect;
            camera.updateProjectionMatrix();
        }

        // === Композит ===
        const offscreen = document.createElement('canvas');
        offscreen.width = targetW;
        offscreen.height = targetH;
        const ctx = offscreen.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // 1) Фото фон
        ctx.drawImage(imageSource, 0, 0, targetW, targetH);

        // 2) Модель + линии измерений (из снимка буфера — threeCanvas уже очищен).
        if (modelBuffer) ctx.drawImage(modelBuffer, 0, 0, targetW, targetH);

        // 3) Размерные метки (CSS2D-лейблы)
        _drawCSS2DLabels(ctx, srcW, srcH, targetW, targetH);

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
    if (!_videoEl || _isCapturing) return;

    // Тот же семафор, что у _freezeCamera — иначе гонка freeze×upload:
    // последний писатель затирает _frozenCanvas и фон другого процесса.
    _isCapturing = true;

    try {
        if (_stream) {
            _stream.getTracks().forEach(t => t.stop());
            _stream = null;
            _videoEl.srcObject = null;
        }
        _videoEl.classList.remove('camera-bg--active');

        const url = URL.createObjectURL(file);
        const img = new Image();

        try {
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
            });
        } catch (err) {
            // При ошибке загрузки objectURL больше никому не нужен
            URL.revokeObjectURL(url);
            console.error('[UploadPhoto] Ошибка загрузки изображения:', err);
            _showCameraError({ name: 'UploadError', message: 'Не удалось загрузить изображение' });
            return;
        }

        // Canvas для скриншота (в полном разрешении фото).
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);

        _frozenCanvas = canvas;

        // CSS фон: фото вытесняет blob замороженного кадра — ревокаем его URL
        if (_freezeBgUrl) {
            URL.revokeObjectURL(_freezeBgUrl);
            _freezeBgUrl = null;
        }
        if (_uploadedBgUrl) URL.revokeObjectURL(_uploadedBgUrl);
        _uploadedBgUrl = url;
        _videoEl.style.backgroundImage = `url(${url})`;
        _videoEl.classList.add('camera-bg--frozen');
        _videoEl.classList.add('camera-bg--active');

        _cameraFrozen = true;
        _updatePauseBtnUI();
    } finally {
        _isCapturing = false;
    }
}

// ============================================================
// ОЧИСТКА
// ============================================================

function _cleanup() {
    // Инкремент поколения: висящие await'ы _startCamera увидят, что их сессия устарела,
    // и остановят дорожки камеры.
    _cameraGeneration++;
    if (_cleanedUp) return;
    _cleanedUp = true;

    // Снимаем обработчик видимости вкладки.
    if (_visibilityHandler) {
        document.removeEventListener('visibilitychange', _visibilityHandler);
        _visibilityHandler = null;
    }

    for (const { el, type, handler } of _boundHandlers) {
        el.removeEventListener(type, handler);
    }
    _boundHandlers = [];
    _restoreFov();
    _stopCamera();
    _removeVideoElement();
    _hideCameraError();
    _api = null;
    _container = null;
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
        if (!_container) {
            // Контейнера нет: панель plugin-system всё равно создаст, но кнопки
            // должны быть мёртвыми, а асинхронные пути — заблокированными
            _api = null;
            _cleanedUp = true;
            return () => {};
        }

        _api = pluginApi;
        _cleanedUp = false;

        // Пауза/возобновление конвейера камеры при скрытии/возврате вкладки.
        _visibilityHandler = _handleVisibilityChange;
        document.addEventListener('visibilitychange', _visibilityHandler);

        _videoEl = _createVideoElement(_container);

        // Запоминаем FOV и позицию камеры на момент активации.
        if (_api.camera) {
            _originalFov = _api.camera.fov;
            _originalCameraPos = _api.camera.position.clone();
        }

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
            // Слайдер в шаблоне панели интерполирует _originalFov на момент импорта
            // модуля (всегда 50) — выставляем фактическое значение при монтировании
            const actualFov = _api?.camera ? _api.camera.fov : _originalFov;
            const fovSliderInit = document.getElementById('cam-fov-slider');
            if (fovSliderInit) {
                fovSliderInit.value = Math.round(actualFov);
                _updateFovLabel(actualFov);
            }

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