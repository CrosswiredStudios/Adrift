import { VolumetricCloudsPlugin } from './volumetric-clouds-plugin';
let { Vector3,
    Scene,
    Animation,
    SkyMaterial,
    FreeCamera
} = BABYLON

const SHADERTOY_WEATHER_TEXTURE_URL =
    'https://celeste-twinkle.github.io/Babylon-App-Show/clouds/pebbles.png';
const SHADERTOY_GREY_NOISE_3D_URL =
    'https://celeste-twinkle.github.io/Babylon-App-Show/clouds/greyNoise3D.bin';

class Playground {
    public static CreateScene(engine: BABYLON.Engine, canvas: HTMLCanvasElement): BABYLON.Scene {
        var scene = new BABYLON.Scene(engine);

        // Camera
        var camera = new BABYLON.FreeCamera("camera1", new BABYLON.Vector3(5, 4, -47), scene);
        camera.setTarget(BABYLON.Vector3.Zero());
        camera.attachControl(canvas, true);

        // Light
        var light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

        // Ground
        var ground = BABYLON.Mesh.CreateGroundFromHeightMap("ground", "textures/heightMap.png", 100, 100, 100, 0, 10, scene, false);
        var groundMaterial = new BABYLON.StandardMaterial("ground", scene);
        let groundTexture = new BABYLON.Texture("textures/ground.jpg", scene)
        groundTexture.uScale = 6;
        groundTexture.vScale = 6;
        groundMaterial.diffuseTexture = groundTexture;
        groundMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
        ground.position.y = -2.05;
        ground.material = groundMaterial;
        const sunDirection = new Vector3(0.6, 0.45, -0.8).normalize();
        // Sky material
        var skyboxMaterial = new BABYLON.SkyMaterial("skyMaterial", scene);
        skyboxMaterial.backFaceCulling = false;
        //skyboxMaterial._cachedDefines.FOG = true;
        skyboxMaterial.useSunPosition = true;
        skyboxMaterial.sunPosition = sunDirection.scale(skyboxMaterial.distance);
        skyboxMaterial.luminance = 0.92;
        skyboxMaterial.turbidity = 8;
        skyboxMaterial.rayleigh = 1.55;
        skyboxMaterial.mieCoefficient = 0.006;
        skyboxMaterial.mieDirectionalG = 0.82;
        // Sky mesh (box)
        var skybox = BABYLON.Mesh.CreateBox("skyBox", 1000.0, scene);
        skybox.material = skyboxMaterial;


        const clouds = new VolumetricCloudsPlugin(scene, camera, skyboxMaterial, {
            windDirection: new Vector3(1, 0, 0.22),
            weatherTextureUrl: SHADERTOY_WEATHER_TEXTURE_URL,
            volumeNoiseUrl: SHADERTOY_GREY_NOISE_3D_URL,
        });

        new BABYLON.FxaaPostProcess("fxaa", 1.0, camera);

        return scene;
    }


}
export { Playground };