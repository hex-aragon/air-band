// 드럼 키트 화면 고르기: WebGL이 되면 3D(kit3d.ts), 안 되면 예전 2D(scene.ts). 쓰는 법은 같다.
import { KitScene } from './scene';
import { Kit3D, webglAvailable } from './kit3d';

export type KitView = KitScene | Kit3D;

export function createKitView(canvas: HTMLCanvasElement, hueOf: (cls: number) => number, labelOf: (cls: number) => string): KitView {
  if (webglAvailable()) {
    try {
      return new Kit3D(canvas, hueOf, labelOf);
    } catch (err) {
      console.warn('3D 드럼을 못 띄워서 2D로', err);
    }
  }
  return new KitScene(canvas, hueOf, labelOf);
}
