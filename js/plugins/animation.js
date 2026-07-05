/**
 * Плагин: Анимация (3D)
 *
 * Адаптация model-animation.js → плагин plugin-system.js.
 * Логика анимации — из оригинала без изменений.
 * Получение анимаций — через событие modelLoaded (detail.animations).
 */

import { AnimationMixer, LoopRepeat, LoopOnce, Clock } from 'three';
import { store } from '../app.js';
import PluginManager from '../plugin-system.js';

// ============================================================
// СОСТОЯНИЕ МОДУЛЯ (из оригинала)
// ============================================================

let animationMixer = null;
let animationClips = [];
let animationActions = [];
let clock = new Clock();
let isAnimating = false;
let currentAnimationIndex = 0;
let animationSpeed = 1.0;
let isLooping = true;

let model = null;
let _animFrameId = null;
let _boundEventHandlers = [];
let _modelLoadedHandler = null;

// ============================================================
// ФУНКЦИИ АНИМАЦИИ (из оригинала, без export)
// ============================================================

function initAnimations(modelObject, animations) {
    if (!animations || animations.length === 0) {
        console.log('Модель без анимаций');
        store.setState('model.animations', null);
        return false;
    }

    console.log('Найдены анимации:', animations.length);
    console.log('Названия:', animations.map(c => c.name));

    model = modelObject;
    animationClips = animations;
    animationMixer = new AnimationMixer(model);

    animationClips.forEach(clip => {
        const action = animationMixer.clipAction(clip);
        action.setLoop(isLooping ? LoopRepeat : LoopOnce);
        action.clampWhenFinished = true;
        animationActions.push(action);
    });

    store.setState('model.animations', {
        clips: animationClips.map(clip => ({ name: clip.name, duration: clip.duration })),
        count: animationClips.length,
        isPlaying: false,
        currentIndex: 0,
        speed: animationSpeed,
        isLooping: isLooping
    });

    return true;
}

function updateAnimation() {
    const delta = clock.getDelta();
    if (animationMixer && isAnimating) {
        animationMixer.update(delta * animationSpeed);

        if (!isLooping) {
            const currentAction = animationActions[currentAnimationIndex];
            if (currentAction && currentAction.time >= currentAction.getClip().duration) {
                currentAction.paused = true;
                isAnimating = false;
                store.setState('model.animations.isPlaying', false);
                updatePlayButton();
                updateLoopButton();
            }
        }
    }
    return delta;
}

function playAnimation() {
    if (!animationMixer || animationActions.length === 0) return;

    const currentAction = animationActions[currentAnimationIndex];
    if (currentAction) {
        const clipDuration = currentAction.getClip().duration;
        const isFinished = !isLooping && currentAction.time >= clipDuration;

        if (isFinished) {
            currentAction.reset();
            currentAction.paused = false;
            currentAction.play();
        } else if (currentAction.paused) {
            currentAction.paused = false;
        } else if (!currentAction.isRunning()) {
            currentAction.play();
        }
    }

    isAnimating = true;
    store.setState('model.animations.isPlaying', true);
    updatePlayButton();
    updateLoopButton();
}

function pauseAnimation() {
    const currentAction = animationActions[currentAnimationIndex];
    if (currentAction) currentAction.paused = true;

    isAnimating = false;
    store.setState('model.animations.isPlaying', false);
    updatePlayButton();
    updateLoopButton();
}

function stopAnimation() {
    const currentAction = animationActions[currentAnimationIndex];
    if (currentAction) {
        currentAction.stop();
        currentAction.paused = false;
    }

    isAnimating = false;
    store.setState('model.animations.isPlaying', false);
    updatePlayButton();
    updateLoopButton();
}

function toggleLooping() {
    isLooping = !isLooping;
    animationActions.forEach(action => {
        action.setLoop(isLooping ? LoopRepeat : LoopOnce);
        action.clampWhenFinished = true;
    });
    store.setState('model.animations.isLooping', isLooping);
    updateLoopButton();
}

function switchAnimation(index) {
    if (index === currentAnimationIndex || index >= animationClips.length) return;

    const wasPlaying = isAnimating;
    animationActions.forEach(action => action.stop());
    currentAnimationIndex = index;

    if (wasPlaying) playAnimation();

    store.setState('model.animations.currentIndex', index);
    const selector = document.getElementById('animation-selector');
    if (selector) selector.value = index;
}

function setAnimationSpeed(speed) {
    animationSpeed = Math.max(0.1, Math.min(5.0, speed));
    store.setState('model.animations.speed', animationSpeed);

    const speedSlider = document.getElementById('animation-speed');
    const speedValue = document.getElementById('animation-speed-value');
    if (speedSlider) speedSlider.value = animationSpeed;
    if (speedValue) speedValue.textContent = animationSpeed.toFixed(2) + 'x';
}

function toggleAnimation(e) {
    if (e) e.preventDefault();
    if (isAnimating) pauseAnimation();
    else playAnimation();
}

// ============================================================
// ОБНОВЛЕНИЕ UI (из оригинала, адаптировано под панель)
// ============================================================

function updatePlayButton() {
    const btn = document.getElementById('animation-toggle-btn');
    if (!btn) return;

    const use = btn.querySelector('svg use');
    if (isAnimating) {
        btn.classList.add('playing');
        btn.title = 'Пауза (Пробел)';
        if (use) use.setAttribute('xlink:href', 'assets/icons/sprite.svg#pause');
    } else {
        btn.classList.remove('playing');
        const currentAction = animationActions[currentAnimationIndex];
        const isFinished = !isLooping && currentAction && currentAction.time >= currentAction.getClip().duration;
        btn.title = isFinished ? 'Воспроизвести сначала (Пробел)' : 'Воспроизвести (Пробел)';
        if (use) use.setAttribute('xlink:href', 'assets/icons/sprite.svg#play');
    }
}

function updateLoopButton() {
    const loopBtn = document.getElementById('animation-loop-btn');
    if (loopBtn) {
        loopBtn.classList.toggle('active', isLooping);
        loopBtn.title = isLooping ? 'Отключить повтор' : 'Включить повтор';
    }
}

// ============================================================
// СОБСТВЕННЫЙ ЦИКЛ АНИМАЦИИ
// ============================================================

function _animateLoop() {
    _animFrameId = requestAnimationFrame(_animateLoop);
    if (document.hidden) return;
    updateAnimation();
}

// ============================================================
// ОЧИСТКА
// ============================================================

function _destroyAll() {
    if (_animFrameId) { cancelAnimationFrame(_animFrameId); _animFrameId = null; }

    if (animationMixer) {
        animationActions.forEach(action => { try { action.stop(); } catch (_) {} });
        animationMixer.stopAllAction();
        animationMixer = null;
    }

    animationClips = [];
    animationActions = [];
    clock = new Clock();
    isAnimating = false;
    currentAnimationIndex = 0;
    animationSpeed = 1.0;
    isLooping = true;
    model = null;
}

// ============================================================
// РЕГИСТРАЦИЯ ПЛАГИНА
// ============================================================

PluginManager.register({
    id: 'animation',
    name: 'Анимация',
    icon: 'play',
    module: '3d-viewer',

    /**
     * Кнопка плагина показывается в сайдбаре только если в модели есть анимации.
     * PluginManager сам вызывает condition при инициализации и при каждом
     * событии modelLoaded (перезагрузка модели / загрузка другой модели).
     */
    condition: (api) => {
        if (!api || !api.store) return false;
        const anims = api.store.getState('model.rawAnimations');
        return !!(anims && Array.isArray(anims) && anims.length > 0);
    },

    init(api) {
        // Если модель уже загружена — инициализируем анимации сразу
        // (init() вызывается при открытии панели, а модель могла быть загружена раньше)
        const existingAnims = api.store.getState('model.rawAnimations')
            || (api.model && api.model.animations);

        console.log('Animation plugin init: model =', !!api.model, 'animations =', existingAnims);

        if (api.model && existingAnims && existingAnims.length > 0) {
            initAnimations(api.model, existingAnims);
            _animateLoop();
        }

        // Слушаем перезагрузку модели (если загрузят другую)
        _modelLoadedHandler = (e) => {
            _destroyAll();

            const m = e.detail.model;
            const anims = e.detail.animations;

            console.log('Animation plugin: modelLoaded, animations =', anims);

            if (anims && anims.length > 0) {
                initAnimations(m, anims);
                _animateLoop();
            }

            // Если панель открыта — обновить UI
            const toolbar = document.querySelector('.animation-panel');
            if (toolbar) {
                _syncPanelUI(toolbar);
            }
        };
        window.addEventListener('modelLoaded', _modelLoadedHandler);
    },

    destroy() {
        _destroyAll();

        if (_modelLoadedHandler) {
            window.removeEventListener('modelLoaded', _modelLoadedHandler);
            _modelLoadedHandler = null;
        }

        for (const { el, type, handler, opts } of _boundEventHandlers) {
            el.removeEventListener(type, handler, opts);
        }
        _boundEventHandlers = [];
    },

    panel: {
        className: 'animation-panel plugin-pill',

        html: `
            <div class="anim-group plugin-pill-group">
                <button class="anim-btn plugin-pill-btn" id="animation-toggle-btn" title="Воспроизвести (Пробел)">
                    <svg><use xlink:href="assets/icons/sprite.svg#play"></use></svg>
                </button>
                <button class="anim-btn plugin-pill-btn" id="animation-stop-btn" title="Остановить и сбросить (S)">
                    <svg><use xlink:href="assets/icons/sprite.svg#stop"></use></svg>
                </button>
                <button class="anim-btn plugin-pill-btn active" id="animation-loop-btn" title="Отключить повтор (R)">
                    <svg><use xlink:href="assets/icons/sprite.svg#repeat"></use></svg>
                </button>
            </div>
            <div class="anim-divider plugin-pill-divider"></div>
            <div class="anim-group plugin-pill-group">
                <button class="anim-btn plugin-pill-btn" id="anim-prev-btn" title="Предыдущая (←)">
                    <svg><use xlink:href="assets/icons/sprite.svg#chevron-left"></use></svg>
                </button>
                <button class="anim-btn plugin-pill-btn" id="anim-next-btn" title="Следующая (→)">
                    <svg><use xlink:href="assets/icons/sprite.svg#chevron-right"></use></svg>
                </button>
            </div>
            <div id="anim-extra-controls" class="anim-extra" style="display:none">
                <select id="animation-selector" class="anim-selector" title="Выбрать анимацию"></select>
                <div class="anim-speed-group">
                    <input type="range" id="animation-speed" class="anim-speed-slider"
                           min="0.25" max="4" step="0.25" value="1" title="Скорость анимации">
                    <span id="animation-speed-value" class="anim-speed-value">1.00x</span>
                </div>
            </div>
            <div id="anim-no-clips" class="anim-empty-hint" style="display:none">
                Модель не содержит анимаций
            </div>
        `,

        onMount(toolbar) {
            // Привязка событий — те же ID что в оригинале, функции без изменений
            const toggleBtn = document.getElementById('animation-toggle-btn');
            const stopBtn = document.getElementById('animation-stop-btn');
            const loopBtn = document.getElementById('animation-loop-btn');
            const prevBtn = document.getElementById('anim-prev-btn');
            const nextBtn = document.getElementById('anim-next-btn');
            const selector = document.getElementById('animation-selector');
            const speedSlider = document.getElementById('animation-speed');

            if (toggleBtn) {
                const h = (e) => { e.preventDefault(); toggleAnimation(e); };
                toggleBtn.addEventListener('click', h);
                _boundEventHandlers.push({ el: toggleBtn, type: 'click', handler: h });
            }
            if (stopBtn) {
                const h = () => stopAnimation();
                stopBtn.addEventListener('click', h);
                _boundEventHandlers.push({ el: stopBtn, type: 'click', handler: h });
            }
            if (loopBtn) {
                const h = () => toggleLooping();
                loopBtn.addEventListener('click', h);
                _boundEventHandlers.push({ el: loopBtn, type: 'click', handler: h });
            }
            if (prevBtn) {
                const h = () => {
                    if (animationClips.length > 1)
                        switchAnimation((currentAnimationIndex - 1 + animationClips.length) % animationClips.length);
                };
                prevBtn.addEventListener('click', h);
                _boundEventHandlers.push({ el: prevBtn, type: 'click', handler: h });
            }
            if (nextBtn) {
                const h = () => {
                    if (animationClips.length > 1)
                        switchAnimation((currentAnimationIndex + 1) % animationClips.length);
                };
                nextBtn.addEventListener('click', h);
                _boundEventHandlers.push({ el: nextBtn, type: 'click', handler: h });
            }
            if (selector) {
                const h = (e) => { e.stopPropagation(); switchAnimation(parseInt(e.target.value)); };
                selector.addEventListener('change', h);
                _boundEventHandlers.push({ el: selector, type: 'change', handler: h });
            }
            if (speedSlider) {
                const h = () => setAnimationSpeed(parseFloat(speedSlider.value));
                speedSlider.addEventListener('input', h);
                _boundEventHandlers.push({ el: speedSlider, type: 'input', handler: h });
            }

            // Клавиатура (из оригинала)
            const keyHandler = (e) => {
                if (!animationMixer) return;
                const tag = e.target.tagName.toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

                if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.preventDefault();
                    toggleAnimation(e);
                }
                if (e.code === 'KeyR' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.preventDefault();
                    toggleLooping();
                }
                if (e.code === 'KeyS' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.preventDefault();
                    stopAnimation();
                }
                if (animationClips.length > 1) {
                    if (e.code === 'ArrowRight' && !e.ctrlKey) {
                        e.preventDefault();
                        switchAnimation((currentAnimationIndex + 1) % animationClips.length);
                    } else if (e.code === 'ArrowLeft' && !e.ctrlKey) {
                        e.preventDefault();
                        switchAnimation((currentAnimationIndex - 1 + animationClips.length) % animationClips.length);
                    }
                }
            };
            document.addEventListener('keydown', keyHandler);
            _boundEventHandlers.push({ el: document, type: 'keydown', handler: keyHandler });

            // Синхронизируем UI с текущим состоянием
            _syncPanelUI(toolbar);
        },

        onUnmount() {}
    }
});

/** Синхронизировать панель с текущим состоянием анимаций */
function _syncPanelUI(toolbar) {
    const extra = document.getElementById('anim-extra-controls');
    const noClips = document.getElementById('anim-no-clips');

    if (animationClips.length > 0 && animationMixer) {
        if (extra) extra.style.display = '';
        if (noClips) noClips.style.display = 'none';

        // Селектор
        const selector = document.getElementById('animation-selector');
        if (selector) {
            selector.innerHTML = animationClips.map((clip, i) =>
                `<option value="${i}" ${i === currentAnimationIndex ? 'selected' : ''}>${clip.name || 'Анимация ' + (i + 1)}</option>`
            ).join('');
            selector.style.display = animationClips.length > 1 ? '' : 'none';
        }

        // Скорость
        const speedSlider = document.getElementById('animation-speed');
        const speedValue = document.getElementById('animation-speed-value');
        if (speedSlider) speedSlider.value = animationSpeed;
        if (speedValue) speedValue.textContent = animationSpeed.toFixed(2) + 'x';

        updatePlayButton();
        updateLoopButton();
    } else {
        if (extra) extra.style.display = 'none';
        if (noClips) noClips.style.display = '';
    }
}