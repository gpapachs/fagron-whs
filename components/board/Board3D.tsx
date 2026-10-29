"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  AISLE_GAP,
  AISLE_PITCH,
  CORRIDOR_SPEC,
  CORRIDORS,
  LEVEL_PITCH,
  PALLET_DEPTH,
  PALLET_HEIGHT,
  SLOT_GAP,
  SLOT_SIZE,
  codeFor,
  columnLayoutFor,
  rackHeightFor,
} from "@/lib/corridors";
import type { Position, PositionStatus } from "@/lib/types";

export type Board3DHandle = { focusAisle: (cid: number) => void };

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function statusColor(status: PositionStatus | undefined) {
  if (status === "occupied") return cssVar("--occupied");
  if (status === "reserved") return cssVar("--reserved");
  return cssVar("--free");
}

type PalletEntry = { mesh: THREE.Mesh; cid: number; idx: number; code: string };

const Board3D = forwardRef<
  Board3DHandle,
  {
    positionsByCode: Record<string, Position>;
    filter: PositionStatus | "all";
    query: string;
    currentCode: string | null;
    onSelect: (cid: number, idx: number, code: string) => void;
  }
>(function Board3D({ positionsByCode, filter, query, currentCode, onSelect }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    pallets: PalletEntry[];
    aisleZ: (c: number) => number;
    animId: number | null;
    focusFrom: { target: THREE.Vector3; pos: THREE.Vector3 } | null;
    focusTo: { target: THREE.Vector3; pos: THREE.Vector3 } | null;
    focusStart: number;
  } | null>(null);

  // Keep the latest callback props reachable from the click handler without
  // re-attaching listeners on every render.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useImperativeHandle(ref, () => ({
    focusAisle(c: number) {
      const s = stateRef.current;
      if (!s) return;
      const z = s.aisleZ(c);
      const rh = rackHeightFor(c);
      const w = columnLayoutFor(c).totalWidth;
      s.focusFrom = { target: s.controls.target.clone(), pos: s.camera.position.clone() };
      s.focusTo = {
        target: new THREE.Vector3(w / 2, rh * 0.4, z),
        pos: new THREE.Vector3(w * 1.15, rh * 1.9, z + AISLE_PITCH * 3.2),
      };
      s.focusStart = performance.now();
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 560;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(cssVar("--bg"));

    let totalW = 0;
    for (let c = 1; c <= CORRIDORS; c++) totalW = Math.max(totalW, columnLayoutFor(c).totalWidth);
    const totalD = CORRIDORS * AISLE_PITCH;
    const centerX = totalW / 2;
    const centerZ = totalD / 2 - AISLE_GAP / 2;
    let maxRackHeight = 0;
    for (let c = 1; c <= CORRIDORS; c++) maxRackHeight = Math.max(maxRackHeight, rackHeightFor(c));

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 500);
    camera.position.set(centerX - totalW * 0.55, maxRackHeight * 3.4, centerZ + totalD * 0.62);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(centerX, maxRackHeight * 0.4, centerZ);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 4;
    controls.maxDistance = 120;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x50483a, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.65);
    sun.position.set(centerX + 20, 40, centerZ + 10);
    scene.add(sun);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(totalW + 16, totalD + 16),
      new THREE.MeshStandardMaterial({ color: cssVar("--surface-2"), roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(centerX, -0.02, centerZ);
    scene.add(floor);
    const grid = new THREE.GridHelper(
      Math.max(totalW, totalD) + 16,
      40,
      new THREE.Color(cssVar("--border")),
      new THREE.Color(cssVar("--border"))
    );
    grid.position.set(centerX, 0, centerZ);
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // shared structural elements (rack posts + shelf beams) via instancing --
    // unit-sized geometries scaled per-instance so every corridor/column
    // reuses the same two geometries.
    const postGeo = new THREE.BoxGeometry(0.07, 1, 0.07);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8d8577, roughness: 0.6, metalness: 0.25 });
    const shelfGeo = new THREE.BoxGeometry(1, 0.05, PALLET_DEPTH * 0.98);
    const shelfMat = new THREE.MeshStandardMaterial({ color: 0x6f6a5c, roughness: 0.7, metalness: 0.15 });

    let postCount = 0;
    let shelfCount = 0;
    for (let c = 1; c <= CORRIDORS; c++) {
      const spec = CORRIDOR_SPEC[c];
      postCount += spec.length * 4;
      spec.forEach((rowCounts) => (shelfCount += rowCounts.length));
    }

    const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
    const shelves = new THREE.InstancedMesh(shelfGeo, shelfMat, shelfCount);
    const pm = new THREE.Matrix4();
    const pNoRot = new THREE.Quaternion();
    const pScale = new THREE.Vector3(1, 1, 1);
    let pi = 0;
    let si = 0;

    for (let c = 1; c <= CORRIDORS; c++) {
      const z0 = (c - 1) * AISLE_PITCH;
      const rh = rackHeightFor(c);
      const colLay = columnLayoutFor(c);
      colLay.forEach((colInfo) => {
        const xL = colInfo.xStart;
        const xR = colInfo.xStart + colInfo.width;
        [xL, xR].forEach((px) => {
          [z0, z0 + PALLET_DEPTH].forEach((pz) => {
            pScale.set(1, rh, 1);
            pm.compose(new THREE.Vector3(px, rh / 2, pz), pNoRot, pScale);
            posts.setMatrixAt(pi++, pm);
          });
        });
        colInfo.rowCounts.forEach((_count, ri) => {
          const beamY = ri * LEVEL_PITCH;
          pScale.set(colInfo.width, 1, 1);
          pm.compose(
            new THREE.Vector3(colInfo.xStart + colInfo.width / 2, beamY, z0 + PALLET_DEPTH / 2),
            pNoRot,
            pScale
          );
          shelves.setMatrixAt(si++, pm);
        });
      });
    }
    posts.instanceMatrix.needsUpdate = true;
    shelves.instanceMatrix.needsUpdate = true;
    scene.add(posts, shelves);

    const palletGeo = new THREE.BoxGeometry(1, 1, 1);
    const pallets: PalletEntry[] = [];
    for (let c = 1; c <= CORRIDORS; c++) {
      const spec = CORRIDOR_SPEC[c];
      const colLay = columnLayoutFor(c);
      const z0 = (c - 1) * AISLE_PITCH;
      const pz = z0 + PALLET_DEPTH / 2;
      let idx = 0;
      spec.forEach((rowCounts, ci) => {
        const colInfo = colLay[ci];
        rowCounts.forEach((count, ri) => {
          const rowWidth = count * SLOT_SIZE + (count - 1) * SLOT_GAP;
          const startX = colInfo.xStart + (colInfo.width - rowWidth) / 2;
          for (let p = 0; p < count; p++) {
            const px = startX + p * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2;
            const py = ri * LEVEL_PITCH + PALLET_HEIGHT / 2 + 0.06;
            const mat = new THREE.MeshStandardMaterial({
              color: 0x2f8f5b,
              roughness: 0.6,
              metalness: 0.05,
              transparent: true,
              opacity: 1,
            });
            const mesh = new THREE.Mesh(palletGeo, mat);
            mesh.scale.set(SLOT_SIZE * 0.9, PALLET_HEIGHT, PALLET_DEPTH * 0.9);
            mesh.position.set(px, py, pz);
            scene.add(mesh);
            pallets.push({ mesh, cid: c, idx, code: codeFor(c, idx) });
            idx++;
          }
        });
      });
    }

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    function handleClick(ev: MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(pallets.map((p) => p.mesh));
      if (hits.length) {
        const hit = pallets.find((p) => p.mesh === hits[0].object);
        if (hit) onSelectRef.current(hit.cid, hit.idx, hit.code);
      }
    }
    renderer.domElement.addEventListener("click", handleClick);

    function handleResize() {
      const cw = container!.clientWidth;
      const ch = container!.clientHeight;
      if (!cw || !ch) return;
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderer.setSize(cw, ch);
    }
    window.addEventListener("resize", handleResize);

    const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
    function handleThemeChange() {
      scene.background = new THREE.Color(cssVar("--bg"));
      (floor.material as THREE.MeshStandardMaterial).color = new THREE.Color(cssVar("--surface-2"));
    }
    darkMedia.addEventListener("change", handleThemeChange);

    stateRef.current = {
      scene,
      camera,
      renderer,
      controls,
      pallets,
      aisleZ: (c: number) => (c - 1) * AISLE_PITCH + PALLET_DEPTH / 2,
      animId: null,
      focusFrom: null,
      focusTo: null,
      focusStart: 0,
    };

    let running = true;
    function animate() {
      if (!running) return;
      const s = stateRef.current;
      if (!s) return;
      s.animId = requestAnimationFrame(animate);
      if (s.focusTo && s.focusFrom) {
        const t = Math.min(1, (performance.now() - s.focusStart) / 650);
        const ease = 1 - Math.pow(1 - t, 3);
        s.controls.target.lerpVectors(s.focusFrom.target, s.focusTo.target, ease);
        s.camera.position.lerpVectors(s.focusFrom.pos, s.focusTo.pos, ease);
        if (t >= 1) s.focusTo = null;
      }
      s.controls.update();
      s.renderer.render(s.scene, s.camera);
    }
    animate();

    return () => {
      running = false;
      const s = stateRef.current;
      if (s?.animId) cancelAnimationFrame(s.animId);
      renderer.domElement.removeEventListener("click", handleClick);
      window.removeEventListener("resize", handleResize);
      darkMedia.removeEventListener("change", handleThemeChange);
      controls.dispose();
      renderer.dispose();
      postGeo.dispose();
      postMat.dispose();
      shelfGeo.dispose();
      shelfMat.dispose();
      palletGeo.dispose();
      pallets.forEach((p) => (p.mesh.material as THREE.Material).dispose());
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      stateRef.current = null;
    };
    // Scene is built once on mount; corridor geometry is static so it never
    // needs to be rebuilt -- colors/opacity update separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recolor pallets whenever the underlying data, filters, search or
  // selection change -- cheap, since it only touches material properties.
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    s.pallets.forEach((entry) => {
      const code = entry.code;
      const slot = positionsByCode[code];
      const dim =
        (filter !== "all" && (slot?.status ?? "free") !== filter) ||
        (query !== "" && !(slot?.product ?? "").toLowerCase().includes(query));
      const isCurrent = currentCode !== null && currentCode === code;
      const mat = entry.mesh.material as THREE.MeshStandardMaterial;
      mat.color.set(statusColor(slot?.status));
      mat.opacity = dim ? 0.22 : 1;
      mat.emissive = new THREE.Color(isCurrent ? cssVar("--accent") : 0x000000);
      mat.emissiveIntensity = isCurrent ? 0.55 : 0;
    });
  }, [positionsByCode, filter, query, currentCode]);

  return <div id="board3d" ref={containerRef} />;
});

export default Board3D;
