// В функции загрузки модели, ПОСЛЕ того как модель добавлена в сцену
function onModelLoaded(model) {
    scene.add(model);
    
    // Теперь можно безопасно включить тени на модели
    model.traverse((node) => {
        if (node.isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
        }
    });
    
    // И включить тени на рендерере
    if (renderer) {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        
        // И на ключевом свете
        const keyLight = scene.children.find(c => 
            c.isDirectionalLight && c.intensity > 1.0
        );
        if (keyLight) {
            keyLight.castShadow = true;
            keyLight.shadow.mapSize.width = 1024;
            keyLight.shadow.mapSize.height = 1024;
        }
    }
}
