// 3D 드럼 키트 (three.js): 드러머 어깨 너머에서 본 진짜 같은 드럼 세트. 스틱이 센서 방향을 따라 움직이고, 치면 북이 울린다.
//
// [한눈에 보기]
//   WebGL 캔버스(3D 장면) 위에 2D 캔버스를 하나 겹친다. 2D에는 드럼 이름표 · 타격 글자 · 안내 글 · 리듬 게임 링을 그린다.
//   그래서 kit/scene.ts(예전 2D 화면)와 쓰는 법이 같다: setAim · hit · geomAll · toAngles · isOnKick · overlay · hint
//
// [설명] 스틱 방향 → 화면
//   센서 각도(좌우 h, 위아래 e)는 "정면 맞추기" 기준이고, 드럼 경계는 드럼 간격 설정(ZONE_DEG, 25~55°)에 따라 바뀐다.
//   화면 속 드럼 배치는 그대로 두고, 각도를 늘이거나 줄여서 "경계 각도 = 화면 속 두 드럼 사이 경계"가 되게 맞춘다.
//   → 간격을 넓게 해도 화면의 드럼은 같은 자리에 있고, 스틱만 더 크게 돌려야 옆 드럼에 닿는다.
//
// [설명] 3D 용어
//   장면(scene) · 카메라(camera) · 렌더러(renderer): 무대 · 눈 · 그림 그리는 기계.
//   재질(material): 표면 성질. MeshPhysicalMaterial은 금속 · 거칠기 · 코팅(clearcoat)을 실제 빛 계산으로 표현한다.
//   환경맵(environment): 주변 풍경을 비추는 반사. 심벌 · 크롬이 반짝이는 이유.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ZONE_DEG } from '../motion';
import { CLS, zoneOfAim, type Aim, type DrumGeom } from './scene';

import { DRUM_INFO } from '../drums';
export { DRUM_INFO };

const DEG = Math.PI / 180;

interface Piece {
  id: string;
  cls: number;
  group: THREE.Group; // 흔들림 · 튀기 애니메이션을 줄 묶음
  head: THREE.Vector3; // 치는 면 가운데 (월드 좌표)
  radius: number; // 치는 면 반지름 (m)
  vertical?: boolean; // 킥: 치는 면이 세로
  flash: THREE.MeshStandardMaterial[]; // 칠 때 빛낼 재질
  hitAt: number;
  strength: number;
  labelAt: THREE.Vector3; // 이름표 자리 (드럼 아래)
}

interface Spark {
  p: THREE.Vector3;
  v: THREE.Vector3;
  born: number;
  hue: number;
}

interface Popup {
  text: string;
  at: THREE.Vector3;
  born: number;
  hue: number;
}

export class Kit3D {
  showZones = false;
  showNames = true;
  /** 드럼 밑 이름표 (이름 · 무엇 · 방향) */
  showLabels = true;
  overlay: ((ctx: CanvasRenderingContext2D, now: number) => void) | null = null;
  hint = '';

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.05, 30);
  private overlayCanvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private pieces: Piece[] = [];
  private stick = new THREE.Group();
  private pivot = new THREE.Vector3(0.16, 0.98, -0.1); // 오른손 (스틱 쥔 곳)
  private aim: Aim | null = null;
  private aimZone = -1;
  /** 화면에 보이는 스틱 방향 (부드럽게 따라감): 피벗에서 본 각도 · 길이 */
  private cur = { yaw: 0, pitch: -30 * DEG, len: 0.62 };
  private snap: { piece: Piece; until: number } | null = null;
  private stickHitAt = -Infinity;
  private stickHitStrength = 0;
  private sparks: Spark[] = [];
  private sparkPoints: THREE.Points;
  private popups: Popup[] = [];
  private shakeUntil = 0;
  private shakeAmp = 0;
  private camBase = new THREE.Vector3();
  private camLook = new THREE.Vector3(0, 0.82, -0.66);
  /** 피벗에서 본 드럼별 각도 (화면 배치의 기준) */
  private ang = new Map<number, { yaw: number; pitch: number; dist: number }>();
  private raycaster = new THREE.Raycaster();

  constructor(
    private canvas: HTMLCanvasElement,
    private hueOf: (cls: number) => number,
    private labelOf: (cls: number) => string,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 2D 덧그림 캔버스: 같은 부모 안에 겹친다 (클릭은 아래 3D 캔버스로 통과)
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'kit-overlay';
    Object.assign(this.overlayCanvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    canvas.after(this.overlayCanvas);
    this.ctx = this.overlayCanvas.getContext('2d')!;
    // 3D 캔버스를 숨기면(리듬 게임 "줄" 화면) 덧그림도 같이 숨긴다
    new MutationObserver(() => (this.overlayCanvas.hidden = canvas.hidden)).observe(canvas, { attributes: true, attributeFilter: ['hidden'] });

    this.buildStage();
    this.buildKit();
    this.buildStick();
    this.sparkPoints = this.buildSparks();

    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.renderer.setAnimationLoop(this.frame);
    (window as unknown as { __kit3d: Kit3D }).__kit3d = this; // DEBUG
  }

  // -------------------------------------------------------------------------
  // 공개 API (kit/scene.ts와 같음)
  // -------------------------------------------------------------------------
  setAim(aim: Aim | null, zone = -1): void {
    this.aim = aim;
    this.aimZone = aim ? zone : -1;
  }

  hit(cls: number, velocity: number): void {
    const now = performance.now();
    const strength = Math.max(0.1, Math.min(1, velocity / 127));
    const piece = this.nearestPiece(cls);
    if (!piece) return;
    piece.hitAt = now;
    piece.strength = strength;
    if (cls === CLS.kick) {
      this.shakeUntil = now + 160;
      this.shakeAmp = 0.004 + 0.01 * strength;
    } else {
      if (this.aimZone !== cls) this.snap = { piece, until: now + 180 };
      this.stickHitAt = now;
      this.stickHitStrength = strength;
    }
    const hue = this.hueOf(cls);
    const n = Math.round(10 + 22 * strength);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.4 + Math.random() * 1.1) * (0.5 + strength);
      const up = piece.vertical ? 0.4 : 1.2 + Math.random() * 1.2;
      this.sparks.push({
        p: piece.head.clone(),
        v: piece.vertical ? new THREE.Vector3(Math.cos(a) * sp, Math.sin(a) * sp, 0.8 * sp) : new THREE.Vector3(Math.cos(a) * sp, up * (0.5 + strength), Math.sin(a) * sp),
        born: now,
        hue,
      });
    }
    if (this.showNames) this.popups.push({ text: this.labelOf(cls), at: piece.head.clone(), born: now, hue });
  }

  /** 드럼별 화면 위 치는 면 (px). 리듬 게임 링 · 판정 글자 자리 */
  geomAll(cls: number): DrumGeom[] {
    return this.pieces.filter((p) => p.cls === cls).map((p) => this.project(p));
  }

  /** 화면 점(px) → 그쪽을 겨눌 때의 센서 각도 (마우스 · 터치 조준) */
  toAngles(px: number, py: number): Aim {
    const ndc = new THREE.Vector2((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // 드럼 높이쯤의 가상 곡면(피벗 중심 구)과 만나는 점을 피벗에서 본 각도로
    const ray = this.raycaster.ray;
    const oc = ray.origin.clone().sub(this.pivot);
    const R = 0.55;
    const b = oc.dot(ray.direction);
    const c = oc.lengthSq() - R * R;
    const t = -b + Math.sqrt(Math.max(0, b * b - c));
    const pt = ray.at(t, new THREE.Vector3());
    const d = pt.sub(this.pivot);
    const yaw = Math.atan2(-d.x, -d.z);
    const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    return this.anglesFromVisual(yaw, pitch);
  }

  isOnKick(px: number, py: number): boolean {
    return this.pickPiece(px, py)?.cls === CLS.kick;
  }

  // -------------------------------------------------------------------------
  // 무대 · 드럼 만들기
  // -------------------------------------------------------------------------
  private buildStage(): void {
    const s = this.scene;
    s.background = new THREE.Color(0x07080b);
    s.fog = new THREE.Fog(0x07080b, 3.2, 7.5);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.55;

    s.add(new THREE.HemisphereLight(0x8899cc, 0x221318, 0.35));
    const key = new THREE.SpotLight(0xfff1dd, 38, 8, 36 * DEG, 0.55, 1.6);
    key.position.set(0.4, 3.4, 0.9);
    key.target.position.set(0, 0.5, -0.7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    s.add(key, key.target);
    // 무대 조명 느낌: 뒤에서 보라 · 파랑 테두리 빛
    const rimL = new THREE.SpotLight(0x7c5cff, 26, 7, 40 * DEG, 0.7, 1.4);
    rimL.position.set(-2.2, 2.6, -2.6);
    rimL.target.position.set(0, 0.6, -0.6);
    const rimR = new THREE.SpotLight(0x22c3ff, 22, 7, 40 * DEG, 0.7, 1.4);
    rimR.position.set(2.3, 2.4, -2.4);
    rimR.target.position.set(0, 0.6, -0.6);
    s.add(rimL, rimL.target, rimR, rimR.target);
    // 심벌이 반짝이도록 위쪽 앞에서 비추는 빛
    const top = new THREE.DirectionalLight(0xfff4e0, 1.6);
    top.position.set(0, 3, 1.5);
    s.add(top);

    // 바닥 + 드럼 카펫
    const floor = new THREE.Mesh(new THREE.CircleGeometry(8, 64), new THREE.MeshStandardMaterial({ color: 0x0c0d11, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(1.25, 64),
      new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 1, color: 0xffffff }),
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.002, -0.65);
    rug.receiveShadow = true;
    s.add(rug);
  }

  private buildKit(): void {
    const chrome = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, metalness: 1, roughness: 0.16 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.8, roughness: 0.4 });
    const shellRed = new THREE.MeshPhysicalMaterial({ color: 0x8e0f22, metalness: 0.25, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
    const shellSilver = new THREE.MeshPhysicalMaterial({ color: 0xcfd4dc, metalness: 0.9, roughness: 0.22, clearcoat: 0.6 });
    const headTex = headTexture(false);

    // 킥: 누운 큰북, 치는 면이 드러머 쪽
    {
      const g = new THREE.Group();
      const r = 0.28;
      g.position.set(0, r + 0.02, -1.0);
      const shell = mesh(new THREE.CylinderGeometry(r, r, 0.42, 48, 1, true), shellRed);
      shell.rotation.x = Math.PI / 2;
      g.add(shell);
      const headMat = new THREE.MeshStandardMaterial({ map: headTexture(true), roughness: 0.75, emissive: 0x000000 });
      const head = mesh(new THREE.CircleGeometry(r * 0.985, 48), headMat);
      head.position.z = 0.21;
      g.add(head);
      const back = mesh(new THREE.CircleGeometry(r * 0.985, 48), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.8 }));
      back.position.z = -0.21;
      back.rotation.y = Math.PI;
      g.add(back);
      for (const z of [0.21, -0.21]) {
        const hoop = mesh(new THREE.TorusGeometry(r, 0.016, 12, 64), shellRed);
        hoop.position.z = z;
        g.add(hoop);
      }
      addLugs(g, r, 10, chrome, 'z');
      // 다리 (스퍼)
      for (const sx of [-1, 1]) {
        const spur = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.36, 8), chrome);
        spur.position.set(sx * 0.27, -0.15, 0.06);
        spur.rotation.z = sx * 0.55;
        g.add(spur);
      }
      // 페달
      const pedal = mesh(new THREE.BoxGeometry(0.09, 0.015, 0.26), darkMetal);
      pedal.position.set(0, -r + 0.01, 0.38);
      pedal.rotation.x = -0.18;
      g.add(pedal);
      const beater = mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 }));
      beater.position.set(0, -0.02, 0.26);
      g.add(beater);
      this.scene.add(g);
      this.pieces.push(this.piece('kick', CLS.kick, g, new THREE.Vector3(0, 0, 0.215), r, [headMat], new THREE.Vector3(-0.55, -0.12, 0.3), true));
    }

    // 스네어: 은색 작은북, 앞쪽 약간 기울임
    this.pieces.push(this.drum('snare', CLS.snare, new THREE.Vector3(0, 0.66, -0.5), 0.18, 0.14, shellSilver, chrome, headTex, -0.12));
    // 탐(플로어 탐): 오른쪽, 다리 3개
    this.pieces.push(this.drum('tom', CLS.tom, new THREE.Vector3(0.6, 0.6, -0.48), 0.22, 0.4, shellRed, chrome, headTex, -0.06, true));
    // 하이햇: 왼쪽, 심벌 2장 + 스탠드
    this.pieces.push(this.cymbal('hihat', CLS.hihat, new THREE.Vector3(-0.58, 0.9, -0.42), 0.18, 0.05, chrome, true, -0.22));
    // 크래시 2개: 왼쪽 위 · 오른쪽 위
    this.pieces.push(this.cymbal('crash-l', CLS.crash, new THREE.Vector3(-0.38, 1.38, -0.95), 0.25, 0.22, chrome));
    this.pieces.push(this.cymbal('crash-r', CLS.crash, new THREE.Vector3(0.44, 1.32, -0.92), 0.23, -0.2, chrome));

    // 의자 (드러머 자리, 화면 아래쪽에 살짝)
    const seat = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 32), new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.7 }));
    seat.position.set(0, 0.52, 0.42);
    this.scene.add(seat);

    // 피벗에서 본 각도 계산 (스틱 조준 · 경계용)
    for (const cls of [CLS.snare, CLS.hihat, CLS.tom, CLS.crash, CLS.kick]) {
      const ps = this.pieces.filter((p) => p.cls === cls);
      const c = ps.reduce((v, p) => v.add(p.head), new THREE.Vector3()).multiplyScalar(1 / ps.length);
      const d = c.clone().sub(this.pivot);
      this.ang.set(cls, { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)), dist: d.length() });
    }
  }

  private piece(id: string, cls: number, group: THREE.Group, headLocal: THREE.Vector3, radius: number, flash: THREE.MeshStandardMaterial[], labelLocal: THREE.Vector3, vertical = false): Piece {
    group.updateMatrixWorld(true);
    return {
      id,
      cls,
      group,
      head: headLocal.clone().applyMatrix4(group.matrixWorld),
      radius,
      vertical,
      flash,
      hitAt: -Infinity,
      strength: 0,
      labelAt: labelLocal.clone().applyMatrix4(group.matrixWorld),
    };
  }

  /** 북 하나: 통 · 치는 가죽 · 테 · 러그 · 스탠드(또는 다리) */
  private drum(id: string, cls: number, pos: THREE.Vector3, r: number, depth: number, shellMat: THREE.Material, chrome: THREE.Material, headTex: THREE.Texture, tilt: number, legs = false): Piece {
    const g = new THREE.Group();
    g.position.copy(pos);
    const body = new THREE.Group();
    body.rotation.x = tilt; // 드러머 쪽으로 살짝 기울임
    g.add(body);
    const shell = mesh(new THREE.CylinderGeometry(r, r, depth, 48, 1, true), shellMat);
    shell.position.y = -depth / 2;
    body.add(shell);
    const headMat = new THREE.MeshStandardMaterial({ map: headTex, roughness: 0.7, emissive: 0x000000 });
    const head = mesh(new THREE.CircleGeometry(r * 0.985, 48), headMat);
    head.rotation.x = -Math.PI / 2;
    head.position.y = 0.002;
    body.add(head);
    const bottom = mesh(new THREE.CircleGeometry(r, 48), new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.9 }));
    bottom.rotation.x = Math.PI / 2;
    bottom.position.y = -depth;
    body.add(bottom);
    for (const y of [0.004, -depth]) {
      const hoop = mesh(new THREE.TorusGeometry(r + 0.004, 0.009, 10, 64), chrome);
      hoop.rotation.x = Math.PI / 2;
      hoop.position.y = y;
      body.add(hoop);
    }
    addLugs(body, r, 8, chrome, 'y', -depth / 2);
    if (legs) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        const leg = mesh(new THREE.CylinderGeometry(0.009, 0.009, pos.y + 0.02, 8), chrome as THREE.MeshStandardMaterial);
        leg.position.set(Math.cos(a) * (r + 0.03), -pos.y / 2 - 0.02, Math.sin(a) * (r + 0.03));
        g.add(leg);
      }
    } else {
      addStand(g, pos.y - depth, chrome as THREE.MeshStandardMaterial);
    }
    this.scene.add(g);
    return this.piece(id, cls, g, new THREE.Vector3(0, 0.004, 0).applyEuler(body.rotation), r, [headMat], new THREE.Vector3(0, -depth - 0.06, r * 0.6));
  }

  /** 심벌: 가운데 볼록한 종 + 얇게 퍼지는 판 (LatheGeometry = 옆모습 선을 빙 돌려 만든 모양) */
  private cymbal(id: string, cls: number, pos: THREE.Vector3, r: number, tiltZ: number, chrome: THREE.MeshStandardMaterial, hihat = false, labelDy = -0.09): Piece {
    const g = new THREE.Group();
    g.position.copy(pos);
    const wob = new THREE.Group(); // 칠 때 흔들리는 부분
    wob.rotation.set(0.18, 0, tiltZ * 0.5);
    g.add(wob);
    const brass = new THREE.MeshStandardMaterial({
      color: 0xe6b860,
      metalness: 0.85,
      roughness: 0.26,
      envMapIntensity: 2.4,
      roughnessMap: grooveTexture(),
      side: THREE.DoubleSide,
      emissive: 0x000000,
    });
    const prof: THREE.Vector2[] = [];
    const bell = r * 0.22;
    for (let i = 0; i <= 24; i++) {
      const x = (i / 24) * r;
      const y = x < bell ? 0.022 * Math.cos((x / bell) * (Math.PI / 2)) + 0.006 : 0.006 * (1 - (x - bell) / (r - bell)) - 0.004 * ((x - bell) / (r - bell)) ** 2;
      prof.push(new THREE.Vector2(Math.max(0.004, x), y));
    }
    const top = mesh(new THREE.LatheGeometry(prof, 72), brass);
    wob.add(top);
    if (hihat) {
      const lower = mesh(new THREE.LatheGeometry(prof, 72), brass);
      lower.rotation.x = Math.PI;
      lower.position.y = -0.018;
      wob.add(lower);
    }
    const nut = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 12), chrome);
    nut.position.y = 0.03;
    wob.add(nut);
    addStand(g, pos.y, chrome);
    this.scene.add(g);
    return {
      ...this.piece(id, cls, g, new THREE.Vector3(0, 0.02, 0), r, [brass], new THREE.Vector3(0, labelDy, 0)),
      group: wob,
    };
  }

  private buildStick(): void {
    const wood = new THREE.MeshPhysicalMaterial({ color: 0xd9b27c, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.3, map: woodTexture() });
    const L = 0.42;
    const shaft = mesh(new THREE.CylinderGeometry(0.0075, 0.011, L, 16), wood);
    shaft.position.y = L / 2; // 스틱 그룹의 y축 = 스틱 방향 (끝이 +y)
    const tip = mesh(new THREE.SphereGeometry(0.012, 16, 12), wood);
    tip.scale.set(1, 1.5, 1);
    tip.position.y = L + 0.004;
    const grip = mesh(new THREE.CylinderGeometry(0.0095, 0.0095, 0.12, 16), new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.9 }));
    grip.position.y = 0.04;
    this.stick.add(shaft, tip, grip);
    this.stick.position.copy(this.pivot);
    this.scene.add(this.stick);
  }

  private buildSparks(): THREE.Points {
    const geo = new THREE.BufferGeometry();
    const max = 400;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setDrawRange(0, 0);
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.022, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, map: dotTexture() }),
    );
    this.scene.add(pts);
    return pts;
  }

  // -------------------------------------------------------------------------
  // 각도 변환: 센서 각도 ↔ 화면(피벗에서 본) 각도
  // -------------------------------------------------------------------------
  /** 화면 속 경계: 이웃 드럼 사이 가운데 */
  private bounds() {
    const s = this.ang.get(CLS.snare)!;
    const hh = this.ang.get(CLS.hihat)!;
    const tm = this.ang.get(CLS.tom)!;
    const cr = this.ang.get(CLS.crash)!;
    return { s, left: (s.yaw + hh.yaw) / 2, right: (s.yaw + tm.yaw) / 2, up: (s.pitch + cr.pitch) / 2 };
  }

  private visualFromAngles(a: Aim): { yaw: number; pitch: number } {
    const b = this.bounds();
    const kl = (b.left - b.s.yaw) / ZONE_DEG.left;
    const kr = (b.s.yaw - b.right) / ZONE_DEG.right;
    const ku = (b.up - b.s.pitch) / ZONE_DEG.up;
    const yaw = b.s.yaw + (a.h >= 0 ? a.h * kl : a.h * kr);
    const pitch = b.s.pitch + a.e * ku;
    return { yaw, pitch };
  }

  private anglesFromVisual(yaw: number, pitch: number): Aim {
    const b = this.bounds();
    const kl = (b.left - b.s.yaw) / ZONE_DEG.left;
    const kr = (b.s.yaw - b.right) / ZONE_DEG.right;
    const ku = (b.up - b.s.pitch) / ZONE_DEG.up;
    const dy = yaw - b.s.yaw;
    return { h: dy >= 0 ? dy / kl : dy / kr, e: (pitch - b.s.pitch) / ku };
  }

  /** 그 방향으로 스틱을 뻗었을 때 드럼에 닿는 길이 (가까운 드럼들의 거리를 각도로 섞음) */
  private reachAt(yaw: number, pitch: number): number {
    let wsum = 0;
    let dsum = 0;
    for (const [cls, a] of this.ang) {
      if (cls === CLS.kick) continue;
      const d2 = (yaw - a.yaw) ** 2 + (pitch - a.pitch) ** 2;
      const w = 1 / (d2 + 0.004);
      wsum += w;
      dsum += w * a.dist;
    }
    return dsum / wsum;
  }

  private nearestPiece(cls: number): Piece | undefined {
    const ps = this.pieces.filter((p) => p.cls === cls);
    if (ps.length <= 1) return ps[0];
    const v = this.visualFromAngles(this.aim ?? { h: 0, e: 0 });
    let best = ps[0];
    let bd = Infinity;
    for (const p of ps) {
      const d = p.head.clone().sub(this.pivot);
      const dd = Math.abs(Math.atan2(-d.x, -d.z) - v.yaw);
      if (dd < bd) {
        bd = dd;
        best = p;
      }
    }
    return best;
  }

  private pickPiece(px: number, py: number): Piece | undefined {
    const ndc = new THREE.Vector2((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pieces.map((p) => p.group), true);
    for (const h of hits) {
      const p = this.pieces.find((pc) => isDescendant(h.object, pc.group));
      if (p) return p;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // 매 프레임
  // -------------------------------------------------------------------------
  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.w = r.width;
    this.h = r.height;
    this.renderer.setSize(this.w, this.h, false);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlayCanvas.width = Math.round(this.w * dpr);
    this.overlayCanvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const aspect = this.w / this.h;
    this.camera.aspect = aspect;
    // 세로 화면(폰)이면 뒤로 물러나 드럼 세트가 다 들어오게
    const back = aspect < 1 ? 1.15 / aspect : 1;
    this.camera.fov = aspect < 1 ? 60 : 48;
    this.camBase.set(0, 1.66 + 0.15 * (back - 1), 1.22 + 0.6 * (back - 1));
    this.camera.updateProjectionMatrix();
  }

  private frame = (): void => {
    const now = performance.now();
    if (this.w < 2) this.resize();

    // 카메라 (킥 칠 때 살짝 흔들림)
    const shake = now < this.shakeUntil ? this.shakeAmp * ((this.shakeUntil - now) / 160) : 0;
    this.camera.position.set(this.camBase.x + (Math.random() - 0.5) * shake, this.camBase.y + (Math.random() - 0.5) * shake, this.camBase.z);
    this.camera.lookAt(this.camLook);

    this.animatePieces(now);
    this.updateStick(now);
    this.updateSparks(now);
    this.renderer.render(this.scene, this.camera);
    this.drawOverlay(now);
  };

  private animatePieces(now: number): void {
    for (const p of this.pieces) {
      const t = (now - p.hitAt) / 1000;
      const live = t >= 0 && t < 1.6;
      const isCym = p.cls === CLS.hihat || p.cls === CLS.crash;
      const flash = live ? Math.max(0, 1 - t / (isCym ? 0.35 : 0.22)) * (0.4 + 0.6 * p.strength) : 0;
      const c = new THREE.Color().setHSL(this.hueOf(p.cls) / 360, 0.9, 0.55).multiplyScalar(flash * (isCym ? 0.9 : 0.6));
      for (const m of p.flash) m.emissive.copy(c);
      if (isCym) {
        // 심벌: 친 쪽으로 기울었다가 흔들리며 멈춤
        const a = live ? 0.22 * p.strength * Math.exp(-t * (p.cls === CLS.hihat ? 9 : 3)) * Math.cos(t * 22) : 0;
        p.group.rotation.x = 0.18 + a;
        // [주의] 안 친 심벌은 t = 무한대 → sin(무한대) = NaN 이라 0 × NaN = NaN이 된다. live일 때만 계산
        p.group.rotation.z = (p.id === 'crash-r' ? -0.1 : p.id === 'crash-l' ? 0.11 : 0) + (live ? a * 0.4 * Math.sin(t * 17) : 0);
      } else {
        // 북: 눌렸다가 튀어 오름
        const d = live ? -0.012 * p.strength * Math.exp(-t * 14) * Math.cos(t * 40) : 0;
        p.group.position.y = p.group.userData.baseY ?? (p.group.userData.baseY = p.group.position.y);
        p.group.position.y = p.group.userData.baseY + d;
      }
    }
  }

  private updateStick(now: number): void {
    let target: { yaw: number; pitch: number; len: number };
    if (this.snap && now < this.snap.until) {
      const d = this.snap.piece.head.clone().sub(this.pivot);
      target = { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)), len: d.length() };
    } else {
      this.snap = null;
      const v = this.aim ? this.visualFromAngles(this.aim) : this.restPose(now);
      target = { ...v, len: this.reachAt(v.yaw, v.pitch) };
    }
    const f = 0.45;
    this.cur.yaw += (target.yaw - this.cur.yaw) * f;
    this.cur.pitch += (target.pitch - this.cur.pitch) * f;
    this.cur.len += (target.len - this.cur.len) * f;
    // 친 순간: 스틱 끝이 살짝 튕겨 오름
    const ht = (now - this.stickHitAt) / 1000;
    const kick = ht >= 0 && ht < 0.3 ? 0.12 * this.stickHitStrength * Math.sin((ht / 0.3) * Math.PI) : 0;
    const dir = new THREE.Vector3(-Math.sin(this.cur.yaw) * Math.cos(this.cur.pitch + kick), Math.sin(this.cur.pitch + kick), -Math.cos(this.cur.yaw) * Math.cos(this.cur.pitch + kick));
    this.stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    // 끝이 드럼에 닿도록 스틱 길이를 조금 늘이고(최대 1.5배), 그래도 모자라면 손을 앞으로
    const L = 0.43;
    const k = Math.max(0.85, Math.min(1.5, this.cur.len / L));
    this.stick.scale.set(1, k, 1);
    this.stick.position.copy(this.pivot).addScaledVector(dir, Math.max(0, this.cur.len - L * k));
  }

  /** 아무것도 안 할 때: 스네어 위에서 천천히 까딱 */
  private restPose(now: number): { yaw: number; pitch: number } {
    const s = this.ang.get(CLS.snare)!;
    return { yaw: s.yaw + 0.03 * Math.sin(now / 1300), pitch: s.pitch + 0.12 + 0.05 * Math.sin(now / 700) };
  }

  private updateSparks(now: number): void {
    const pos = this.sparkPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.sparkPoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    this.sparks = this.sparks.filter((s) => now - s.born < 700).slice(-400);
    const dt = 1 / 60;
    const c = new THREE.Color();
    this.sparks.forEach((s, i) => {
      s.v.y -= 3.5 * dt;
      s.p.addScaledVector(s.v, dt);
      const life = 1 - (now - s.born) / 700;
      c.setHSL(s.hue / 360, 0.9, 0.6).multiplyScalar(life * 1.4);
      pos.setXYZ(i, s.p.x, s.p.y, s.p.z);
      col.setXYZ(i, c.r, c.g, c.b);
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.sparkPoints.geometry.setDrawRange(0, this.sparks.length);
  }

  // -------------------------------------------------------------------------
  // 2D 덧그림: 이름표 · 글자 · 구역선 · 안내
  // -------------------------------------------------------------------------
  private toScreen(v: THREE.Vector3): { x: number; y: number } {
    const p = v.clone().project(this.camera);
    return { x: ((p.x + 1) / 2) * this.w, y: ((1 - p.y) / 2) * this.h };
  }

  private project(p: Piece): DrumGeom {
    const c = this.toScreen(p.head);
    const ax = this.toScreen(p.head.clone().add(new THREE.Vector3(p.radius, 0, 0)));
    const ax2 = this.toScreen(p.head.clone().add(new THREE.Vector3(-p.radius, 0, 0)));
    const off = p.vertical ? new THREE.Vector3(0, p.radius, 0) : new THREE.Vector3(0, 0, p.radius);
    const ay = this.toScreen(p.head.clone().add(off));
    const ay2 = this.toScreen(p.head.clone().sub(off));
    return { x: c.x, y: c.y, rx: Math.abs(ax.x - ax2.x) / 2, ry: Math.max(4, Math.abs(ay.y - ay2.y) / 2) };
  }

  private drawOverlay(now: number): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    if (this.showZones) this.drawZones(c);
    if (this.showLabels) this.drawLabels(c);

    // 타격 이름 글자
    c.textAlign = 'center';
    this.popups = this.popups.filter((p) => now - p.born < 650);
    for (const p of this.popups) {
      const age = (now - p.born) / 650;
      const s = this.toScreen(p.at);
      c.globalAlpha = 1 - age;
      c.font = '800 22px system-ui, "Noto Sans KR", sans-serif';
      c.fillStyle = `hsl(${p.hue}, 90%, 70%)`;
      c.shadowColor = 'rgba(0,0,0,0.8)';
      c.shadowBlur = 8;
      c.fillText(p.text, s.x, s.y - 40 - age * 36);
      c.shadowBlur = 0;
      c.globalAlpha = 1;
    }
    this.overlay?.(c, now);
    if (this.hint) {
      c.font = '13px system-ui, "Noto Sans KR", sans-serif';
      c.fillStyle = 'rgba(232,234,239,0.75)';
      c.textAlign = 'center';
      c.fillText(this.hint, this.w / 2, this.h - 14);
    }
  }

  private drawLabels(c: CanvasRenderingContext2D): void {
    const seen = new Set<number>();
    for (const p of this.pieces) {
      // 크래시는 둘이지만 이름표는 한 번 (두 심벌 사이 위쪽)
      if (seen.has(p.cls)) continue;
      seen.add(p.cls);
      const info = DRUM_INFO[p.cls];
      let at = p.labelAt;
      if (p.cls === CLS.crash) {
        const both = this.pieces.filter((q) => q.cls === CLS.crash);
        at = both.reduce((v, q) => v.add(q.labelAt), new THREE.Vector3()).multiplyScalar(1 / both.length);
      }
      const s = this.toScreen(at);
      const aimed = this.aimZone === p.cls;
      const hue = this.hueOf(p.cls);
      const big = Math.max(12, Math.min(17, this.w / 60));
      c.font = `800 ${big}px system-ui, "Noto Sans KR", sans-serif`;
      const w1 = c.measureText(info.name).width;
      c.font = `${big - 4}px system-ui, "Noto Sans KR", sans-serif`;
      const sub = `${info.what} · ${info.where}`;
      const w2 = c.measureText(sub).width;
      const bw = Math.max(w1, w2) + 18;
      const bh = big * 2 + 10;
      const x = s.x - bw / 2;
      const y = s.y - bh / 2;
      c.fillStyle = aimed ? `hsla(${hue}, 80%, 45%, 0.85)` : 'rgba(10,12,18,0.62)';
      c.strokeStyle = `hsla(${hue}, 85%, 60%, ${aimed ? 1 : 0.55})`;
      c.lineWidth = aimed ? 2 : 1;
      c.beginPath();
      c.roundRect(x, y, bw, bh, 9);
      c.fill();
      c.stroke();
      c.textAlign = 'center';
      c.fillStyle = '#fff';
      c.font = `800 ${big}px system-ui, "Noto Sans KR", sans-serif`;
      c.fillText(info.name, s.x, y + big + 2);
      c.fillStyle = aimed ? 'rgba(255,255,255,0.92)' : 'rgba(220,225,235,0.75)';
      c.font = `${big - 4}px system-ui, "Noto Sans KR", sans-serif`;
      c.fillText(sub, s.x, y + big * 2 + 3);
    }
  }

  /** 구역 경계: 피벗에서 경계 각도로 뻗은 선을 바닥 · 공중에 점선으로 */
  private drawZones(c: CanvasRenderingContext2D): void {
    const b = this.bounds();
    const ray = (yaw: number, pitch: number, len: number) =>
      this.toScreen(this.pivot.clone().add(new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(len)));
    c.save();
    c.setLineDash([6, 6]);
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = 1.5;
    for (const yaw of [b.left, b.right]) {
      c.beginPath();
      for (let p = -60; p <= b.up / DEG; p += 4) {
        const s = ray(yaw, p * DEG, 0.6);
        if (p === -60) c.moveTo(s.x, s.y);
        else c.lineTo(s.x, s.y);
      }
      c.stroke();
    }
    c.beginPath();
    for (let y = b.right - 0.5; y <= b.left + 0.5; y += 0.05) {
      const s = ray(y, b.up, 0.6);
      if (y === b.right - 0.5) c.moveTo(s.x, s.y);
      else c.lineTo(s.x, s.y);
    }
    c.stroke();
    c.restore();
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.font = '12px system-ui, sans-serif';
    const l = ray(b.left, -0.5, 0.6);
    const r = ray(b.right, -0.5, 0.6);
    c.fillText(`왼 ${ZONE_DEG.left}°`, l.x, l.y);
    c.fillText(`오 ${ZONE_DEG.right}°`, r.x, r.y);
  }
}

// ---------------------------------------------------------------------------
// 도우미: 메시 · 스탠드 · 러그 · 질감(캔버스로 직접 그림)
// ---------------------------------------------------------------------------
function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function isDescendant(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x === root) return true;
  return false;
}

/** 통 둘레의 러그(줄 조이는 금속 장식) */
function addLugs(g: THREE.Object3D, r: number, n: number, mat: THREE.Material, axis: 'y' | 'z', at = 0): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const lug = mesh(new THREE.BoxGeometry(0.014, axis === 'y' ? 0.05 : 0.014, axis === 'y' ? 0.014 : 0.06), mat);
    if (axis === 'y') lug.position.set(Math.cos(a) * (r + 0.006), at, Math.sin(a) * (r + 0.006));
    else lug.position.set(Math.cos(a) * (r + 0.006), Math.sin(a) * (r + 0.006), 0);
    g.add(lug);
  }
}

/** 스탠드: 기둥 + 다리 3개 (그룹 원점이 위 끝) */
function addStand(g: THREE.Group, height: number, chrome: THREE.MeshStandardMaterial): void {
  const pole = mesh(new THREE.CylinderGeometry(0.009, 0.012, height, 10), chrome);
  pole.position.y = -height / 2;
  g.add(pole);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const leg = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.3, 8), chrome);
    leg.position.set(Math.cos(a) * 0.11, -height + 0.07, Math.sin(a) * 0.11);
    leg.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
    g.add(leg);
  }
}

function canvasTex(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 북 가죽: 흰 코팅 + 얼룩 + 가운데 점(스네어 · 탐), 킥은 로고 */
function headTexture(kick: boolean): THREE.Texture {
  return canvasTex(512, (c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, s * 0.05, s / 2, s / 2, s / 2);
    g.addColorStop(0, '#f4f1ea');
    g.addColorStop(0.85, '#e7e2d6');
    g.addColorStop(1, '#bdb6a6');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 1800; i++) {
      c.fillStyle = `rgba(120,110,90,${Math.random() * 0.05})`;
      c.beginPath();
      c.arc(Math.random() * s, Math.random() * s, Math.random() * 3, 0, Math.PI * 2);
      c.fill();
    }
    if (kick) {
      c.fillStyle = '#8e0f22';
      c.beginPath();
      c.arc(s / 2, s / 2, s * 0.3, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#fff';
      c.font = `900 ${s * 0.1}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('AIR BAND', s / 2, s / 2);
    } else {
      c.fillStyle = 'rgba(40,40,40,0.18)';
      c.beginPath();
      c.arc(s / 2, s / 2, s * 0.09, 0, Math.PI * 2);
      c.fill();
    }
  });
}

/** 심벌 결: 동심원 홈 (거칠기 · 요철 맵) */
function grooveTexture(): THREE.Texture {
  const t = canvasTex(
    512,
    (c, s) => {
      c.fillStyle = '#777';
      c.fillRect(0, 0, s, s);
      for (let r = 4; r < s / 2; r += 2.2) {
        c.strokeStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${0.15 + Math.random() * 0.2})`;
        c.lineWidth = 1;
        c.beginPath();
        c.arc(s / 2, s / 2, r, 0, Math.PI * 2);
        c.stroke();
      }
    },
    false,
  );
  return t;
}

function woodTexture(): THREE.Texture {
  return canvasTex(256, (c, s) => {
    c.fillStyle = '#d9b27c';
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 60; i++) {
      c.strokeStyle = `rgba(120,80,40,${Math.random() * 0.25})`;
      c.beginPath();
      const x = Math.random() * s;
      c.moveTo(x, 0);
      c.bezierCurveTo(x + 6, s / 3, x - 6, (2 * s) / 3, x + 3, s);
      c.stroke();
    }
  });
}

function rugTexture(): THREE.Texture {
  return canvasTex(512, (c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, 10, s / 2, s / 2, s / 2);
    g.addColorStop(0, '#3a2026');
    g.addColorStop(0.9, '#25141a');
    g.addColorStop(1, '#120a0d');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      c.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`;
      c.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
    }
    c.strokeStyle = 'rgba(200,160,90,0.25)';
    c.lineWidth = 6;
    c.beginPath();
    c.arc(s / 2, s / 2, s / 2 - 18, 0, Math.PI * 2);
    c.stroke();
  });
}

function dotTexture(): THREE.Texture {
  return canvasTex(64, (c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  });
}

/** WebGL을 쓸 수 있으면 3D, 아니면 null (호출한 쪽이 2D 화면으로) */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export { zoneOfAim };
