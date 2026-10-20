import { getGltfLoader } from "../loaders/createGltfLoaders.js";
import { CITY_OFFSET_Y } from "../city/loadCity.js";

const BILLBOARDS_PATH = "/models/billboards.glb";

export async function loadBillboards(featureSource) {
  const gltfLoader = getGltfLoader(featureSource);
  const gltf = await gltfLoader.loadAsync(BILLBOARDS_PATH);
  const billboards = gltf.scene;

  billboards.name = "Billboards";
  billboards.position.y = CITY_OFFSET_Y;

  billboards.traverse((child) => {
    child.castShadow = false;
    child.receiveShadow = false;
  });

  return billboards;
}
