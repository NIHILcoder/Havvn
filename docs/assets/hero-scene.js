/* Three.js enhancement. The original SVG stays visible until the first render. */
import * as THREE from "./vendor/three-0.180.0/three.module.min.js";

export function createHeroScene() {
  const hero = document.querySelector(".hero");
  const art = document.querySelector(".hero-art");
  const canvas = document.querySelector("#network-scene");
  const controls = document.querySelector(".scene-tools");
  const pulseButton = document.querySelector("#scene-pulse");
  const resetButton = document.querySelector("#scene-reset");
  const status = document.querySelector("#scene-status");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const fine = matchMedia("(pointer: fine)");
  const compact = matchMedia("(max-width: 600px)");
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: !compact.matches,
    powerPreference: "low-power",
  });
  if (!context) {
    art.dataset.scene = "fallback";
    return;
  }

  const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
  camera.position.set(0, 0, 12.6);
  const stage = new THREE.Group();
  stage.position.set(0.05, 0.42, 0);
  scene.add(stage);

  // A small local studio environment gives the copper real moving reflections.
  const studio = document.createElement("canvas");
  studio.width = 512;
  studio.height = 256;
  const brush = studio.getContext("2d");
  const gradient = brush.createLinearGradient(0, 0, 0, 256);
  [
    [0, "#292532"],
    [0.25, "#a0a8bc"],
    [0.38, "#fff3df"],
    [0.46, "#58423b"],
    [0.65, "#9e6041"],
    [0.85, "#ffb875"],
    [1, "#29201c"],
  ].forEach(([offset, color]) => gradient.addColorStop(offset, color));
  brush.fillStyle = gradient;
  brush.fillRect(0, 0, 512, 256);
  brush.fillStyle = "#fff4e5";
  brush.fillRect(80, 30, 35, 135);
  brush.fillStyle = "#e49a6b";
  brush.fillRect(360, 50, 70, 100);
  let environment;
  function lightStudio() {
    const studioTexture = new THREE.CanvasTexture(studio);
    studioTexture.mapping = THREE.EquirectangularReflectionMapping;
    studioTexture.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    environment?.dispose();
    environment = pmrem.fromEquirectangular(studioTexture);
    scene.environment = environment.texture;
    studioTexture.dispose();
    pmrem.dispose();
  }
  lightStudio();
  scene.add(new THREE.HemisphereLight(0xffeee1, 0x3a1826, 0.8));
  const key = new THREE.DirectionalLight(0xffdbb5, 2.5);
  key.position.set(-3, 5, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff662c, 3);
  rim.position.set(4, -1, 2);
  scene.add(rim);
  const cool = new THREE.DirectionalLight(0xbacaff, 2.5);
  cool.position.set(0, 3, -3);
  scene.add(cool);

  // The same outline as the brand SVG, extruded with a rounded copper edge.
  const outline = [
    [6.2, 6.3],
    [217, 147.9],
    [223.9, 161.8],
    [256, 127.7],
    [288.1, 161.8],
    [295, 147.9],
    [505.8, 6.3],
    [366.7, 222.8],
    [369.2, 232.2],
    [330.5, 289.6],
    [256, 204.6],
    [181.5, 289.6],
    [142.8, 232.2],
    [145.3, 222.8],
  ];
  const shape = new THREE.Shape();
  outline.forEach(([x, y], index) =>
    shape[index ? "lineTo" : "moveTo"]((x - 256) / 105, (148 - y) / 105),
  );
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.25,
    bevelEnabled: true,
    bevelThickness: 0.045,
    bevelSize: 0.035,
    bevelSegments: 3,
    steps: 1,
    curveSegments: 1,
  });
  geometry.center();
  // Fold the broad wing surfaces into reflective facets, preserving the outline.
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    positions.setZ(
      i,
      positions.getZ(i) +
        Math.cos(positions.getX(i) * 1.8) * 0.24 +
        positions.getY(i) * 0.12,
    );
  }
  geometry.computeVertexNormals();
  const copper = new THREE.MeshPhysicalMaterial({
    color: 0xc27948,
    metalness: 0.98,
    roughness: 0.24,
    clearcoat: 0.55,
    clearcoatRoughness: 0.2,
    envMapIntensity: 1.1,
  });
  const edge = new THREE.MeshStandardMaterial({
    color: 0x9e401c,
    metalness: 0.88,
    roughness: 0.28,
  });
  const mark = new THREE.Mesh(geometry, [copper, edge]);
  mark.rotation.set(-0.16, -0.3, -0.15);
  mark.position.z = 1;
  stage.add(mark);

  const network = new THREE.Group();
  network.rotation.z = -0.25;
  stage.add(network);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const peers = Array.from({ length: 86 }, (_, i) => {
    const y = 1 - (i / 85) * 2;
    const radius = Math.sqrt(1 - y * y);
    return new THREE.Vector3(
      Math.cos(i * golden) * radius,
      y,
      Math.sin(i * golden) * radius,
    ).multiplyScalar(3.05);
  });
  const connections = [];
  peers.forEach((a, i) =>
    peers.slice(i + 1).forEach((b) => {
      if (a.distanceTo(b) < 1.13)
        connections.push(...a.toArray(), ...b.toArray());
    }),
  );
  const linesGeometry = new THREE.BufferGeometry();
  linesGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(connections, 3),
  );
  network.add(
    new THREE.LineSegments(
      linesGeometry,
      new THREE.LineBasicMaterial({
        color: 0xe88a5a,
        transparent: true,
        opacity: 0.085,
        depthWrite: false,
      }),
    ),
  );
  const peersGeometry = new THREE.BufferGeometry().setFromPoints(peers);
  const peerCloud = new THREE.Points(
    peersGeometry,
    new THREE.PointsMaterial({
      color: 0xffc494,
      size: 0.055,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    }),
  );
  network.add(peerCloud);

  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = glowCanvas.height = 64;
  const glowBrush = glowCanvas.getContext("2d");
  const glow = glowBrush.createRadialGradient(32, 32, 0, 32, 32, 32);
  [
    [0, "#fff7e8"],
    [0.1, "#ffd9ad"],
    [0.25, "#ff9d5699"],
    [0.6, "#ff692b22"],
    [1, "#ff692b00"],
  ].forEach(([offset, color]) => glow.addColorStop(offset, color));
  glowBrush.fillStyle = glow;
  glowBrush.fillRect(0, 0, 64, 64);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  // Brighter beacons make the network's selectable nodes easy to discover.
  for (let i = 5; i < peers.length; i += 13) {
    const beacon = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.6,
      }),
    );
    beacon.position.copy(peers[i]);
    beacon.scale.setScalar(0.23);
    network.add(beacon);
  }
  const pulse = new THREE.Group();
  pulse.visible = false;
  network.add(pulse);
  const routeGeometry = new THREE.BufferGeometry();
  const routePositions = new Float32Array(6 * 32 * 6);
  routeGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(routePositions, 3).setUsage(
      THREE.DynamicDrawUsage,
    ),
  );
  const routeMaterial = new THREE.LineBasicMaterial({
    color: 0xffcf99,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });
  pulse.add(new THREE.LineSegments(routeGeometry, routeMaterial));
  const sourceGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sourceGlow.scale.setScalar(0.65);
  pulse.add(sourceGlow);
  const packets = Array.from({ length: 6 }, () => {
    const packet = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    packet.scale.setScalar(0.38);
    pulse.add(packet);
    return packet;
  });
  let routes = [],
    activePeer = -1,
    pulseStart = 0,
    pulseCount = 0;
  let visible = true,
    paused = document.documentElement.classList.contains("motion-paused");
  let lost = false,
    disposed = false,
    running = false,
    last = 0,
    clock = 0,
    frameCount = 0;
  let aimX = 0,
    aimY = 0,
    pointerX = 0,
    pointerY = 0;
  let drag = null,
    targetYaw = 0,
    targetPitch = 0,
    yaw = 0,
    pitch = 0;
  const canAnimate = () =>
    !disposed &&
    !lost &&
    visible &&
    !paused &&
    !reduced.matches &&
    !document.hidden;
  const canInteract = () => !disposed && !lost && visible && !document.hidden;
  function labels() {
    const ru = document.documentElement.lang === "ru";
    canvas.setAttribute(
      "aria-label",
      ru
        ? "Интерактивный 3D-логотип Havvn. Стрелки — вращать, Enter или пробел — импульс, Home — сбросить."
        : "Interactive 3D Havvn logo. Arrow keys rotate, Enter or Space sends a pulse, Home resets.",
    );
    resetButton.setAttribute(
      "aria-label",
      ru ? "Сбросить поворот и импульс" : "Reset rotation and pulse",
    );
    status.textContent =
      activePeer < 0
        ? ru
          ? "Демо P2P · 86 узлов"
          : "P2P demo · 86 peers"
        : (ru ? "Демо P2P · узел " : "P2P demo · peer ") +
          String(activePeer + 1).padStart(2, "0") +
          (ru ? " → 6 соседей" : " → 6 neighbors");
  }
  const languageObserver = new MutationObserver(labels);
  languageObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["lang"],
  });
  labels();
  function paint() {
    if (disposed || lost) return;
    const t = clock * 0.001;
    stage.rotation.set(pitch, yaw, 0);
    mark.rotation.set(
      -0.16 + pointerY * 0.22 + Math.sin(t * 0.28) * 0.025,
      -0.3 + pointerX * 0.4 + Math.sin(t * 0.2) * 0.045,
      -0.15 + Math.sin(t * 0.35) * 0.025,
    );
    mark.position.y = Math.sin(t * 0.4) * 0.055;
    network.rotation.y = t * 0.025 + pointerX * 0.1;
    network.rotation.x = 0.15 + pointerY * 0.08;
    if (activePeer >= 0) {
      const progress = Math.min(1, Math.max(0, (clock - pulseStart) / 2100));
      const travel = 1 - (1 - progress) ** 2;
      routeMaterial.opacity = 0.15 + (1 - progress) * 0.65;
      sourceGlow.material.opacity = 0.5 + (1 - progress) * 0.5;
      packets.forEach((packet, i) => {
        packet.visible = progress < 1;
        packet.position
          .copy(routes[i].start)
          .lerp(routes[i].end, travel)
          .normalize()
          .multiplyScalar(3.08);
      });
    }
    renderer.render(scene, camera);
    canvas.dataset.frame = String(++frameCount);
    if (art.dataset.scene !== "webgl") {
      art.dataset.scene = "webgl";
      canvas.tabIndex = 0;
      canvas.removeAttribute("aria-hidden");
      controls.hidden = false;
    }
  }
  function tick(now) {
    if (!canAnimate()) {
      sync();
      return;
    }
    const delta = last ? Math.min(50, now - last) : 16;
    // Limit small-screen animation to 30 fps; never accumulate hidden-tab time.
    if (compact.matches && last && delta < 32) return;
    last = now;
    clock += delta;
    const ease = 1 - Math.exp(-delta / 180);
    pointerX += (aimX - pointerX) * ease;
    pointerY += (aimY - pointerY) * ease;
    yaw += (targetYaw - yaw) * ease;
    pitch += (targetPitch - pitch) * ease;
    paint();
  }
  function sync() {
    if (disposed) return;
    const next = canAnimate();
    if (next !== running) {
      running = next;
      last = 0;
      renderer.setAnimationLoop(next ? tick : null);
    }
    if (!next && !lost && visible && !document.hidden) paint();
  }
  function resize() {
    if (disposed || lost) return;
    const { width, height } = art.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setPixelRatio(
      Math.min(devicePixelRatio || 1, compact.matches ? 1.25 : 1.75),
    );
    renderer.setSize(width, height, false);
    stage.scale.setScalar(compact.matches ? 0.78 : 1);
    camera.aspect = width / height;
    // Keep the complete sculpture in frame in portrait and wide viewports.
    camera.position.z = Math.max(12.6, 10.5 / camera.aspect);
    camera.updateProjectionMatrix();
    paint();
  }
  function pointer(event) {
    if (!fine.matches || !canAnimate() || drag) return;
    const bounds = art.getBoundingClientRect();
    aimX = THREE.MathUtils.clamp(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -1,
      1,
    );
    aimY = THREE.MathUtils.clamp(
      ((event.clientY - bounds.top) / bounds.height) * 2 - 1,
      -1,
      1,
    );
  }
  const raycaster = new THREE.Raycaster();
  const screenPointer = new THREE.Vector2();
  raycaster.params.Points.threshold = 0.2;
  function hitPeer(event) {
    const bounds = canvas.getBoundingClientRect();
    screenPointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(screenPointer, camera);
    const peer = raycaster.intersectObject(peerCloud, false)[0];
    const sculpture = raycaster.intersectObject(mark, false)[0];
    return peer && (!sculpture || peer.distance < sculpture.distance)
      ? peer.index
      : -1;
  }
  function sendPulse(index) {
    if (!canInteract()) return;
    activePeer = index;
    const source = peers[index];
    routes = peers
      .map((end, id) => ({
        start: source,
        end,
        id,
        distance: source.distanceToSquared(end),
      }))
      .filter((route) => route.id !== index)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6);
    let offset = 0;
    const a = new THREE.Vector3(),
      b = new THREE.Vector3();
    routes.forEach((route) => {
      for (let step = 0; step < 32; step++) {
        a.copy(source)
          .lerp(route.end, step / 32)
          .normalize()
          .multiplyScalar(3.08);
        b.copy(source)
          .lerp(route.end, (step + 1) / 32)
          .normalize()
          .multiplyScalar(3.08);
        a.toArray(routePositions, offset);
        b.toArray(routePositions, offset + 3);
        offset += 6;
      }
    });
    routeGeometry.attributes.position.needsUpdate = true;
    routeGeometry.computeBoundingSphere();
    sourceGlow.position.copy(source);
    pulse.visible = true;
    // Manual interactions stay useful when motion is paused, with a static route.
    pulseStart = clock - (canAnimate() ? 0 : 1050);
    labels();
    paint();
  }
  function nextPulse() {
    if (!canInteract()) return;
    scene.updateMatrixWorld(true);
    const front = peers
      .map((point, id) => ({ id, world: network.localToWorld(point.clone()) }))
      .filter(
        ({ world }) => world.z > 0 && Math.hypot(world.x, world.y) > 1.75,
      );
    sendPulse(front.length ? front[pulseCount++ % front.length].id : 5);
  }
  function applyRotation() {
    if (!canAnimate()) {
      yaw = targetYaw;
      pitch = targetPitch;
      paint();
    }
  }
  function startDrag(event) {
    if (!canInteract() || !event.isPrimary || event.button !== 0) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      yaw: targetYaw,
      pitch: targetPitch,
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
    if (event.pointerType === "mouse") canvas.focus({ preventScroll: true });
  }
  function moveDrag(event) {
    if (!canInteract()) return;
    if (drag && drag.id === event.pointerId) {
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 7) drag.moved = true;
      if (drag.moved) {
        canvas.classList.add("is-dragging");
        canvas.classList.remove("is-over-peer");
        targetYaw = THREE.MathUtils.clamp(drag.yaw + dx * 0.007, -1.15, 1.15);
        targetPitch = THREE.MathUtils.clamp(
          drag.pitch + dy * 0.005,
          -0.65,
          0.65,
        );
        applyRotation();
      }
    } else if (fine.matches)
      canvas.classList.toggle("is-over-peer", hitPeer(event) >= 0);
  }
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const tapped = !drag.moved && event.type === "pointerup";
    drag = null;
    canvas.classList.remove("is-dragging");
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
    if (tapped) {
      const index = hitPeer(event);
      if (index >= 0) sendPulse(index);
    }
  }
  function cancelDrag() {
    const id = drag?.id;
    drag = null;
    canvas.classList.remove("is-dragging", "is-over-peer");
    if (id !== undefined && canvas.hasPointerCapture(id))
      canvas.releasePointerCapture(id);
  }
  function resetScene() {
    if (!canInteract()) return;
    cancelDrag();
    targetYaw = 0;
    targetPitch = 0;
    aimX = 0;
    aimY = 0;
    pointerX = 0;
    pointerY = 0;
    activePeer = -1;
    pulseCount = 0;
    pulse.visible = false;
    labels();
    applyRotation();
  }
  function keyboard(event) {
    if (!canInteract()) return;
    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      targetYaw = THREE.MathUtils.clamp(
        targetYaw +
          (event.key === "ArrowLeft"
            ? -0.16
            : event.key === "ArrowRight"
              ? 0.16
              : 0),
        -1.15,
        1.15,
      );
      targetPitch = THREE.MathUtils.clamp(
        targetPitch +
          (event.key === "ArrowUp"
            ? -0.12
            : event.key === "ArrowDown"
              ? 0.12
              : 0),
        -0.65,
        0.65,
      );
      applyRotation();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat) nextPulse();
    } else if (event.key === "Home" || event.key === "Escape") {
      event.preventDefault();
      resetScene();
    }
  }
  const resetPointer = () => {
    aimX = 0;
    aimY = 0;
  };
  const motionChange = (event) => {
    paused = event.detail.paused;
    sync();
  };
  const contextLost = (event) => {
    event.preventDefault();
    cancelDrag();
    lost = true;
    art.dataset.scene = "fallback";
    if (
      document.activeElement === canvas ||
      controls.contains(document.activeElement)
    )
      document.querySelector("#motion-toggle").focus({ preventScroll: true });
    controls.hidden = true;
    canvas.tabIndex = -1;
    canvas.setAttribute("aria-hidden", "true");
    sync();
  };
  const contextRestored = () => {
    lost = false;
    lightStudio();
    resize();
    sync();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(art);
  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            visible = entries[0].isIntersecting;
            sync();
          },
          { rootMargin: "80px" },
        )
      : null;
  observer?.observe(art);
  hero.addEventListener("pointermove", pointer, { passive: true });
  hero.addEventListener("pointerleave", resetPointer);
  canvas.addEventListener("pointerdown", startDrag);
  canvas.addEventListener("pointermove", moveDrag);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("lostpointercapture", cancelDrag);
  canvas.addEventListener("keydown", keyboard);
  pulseButton.addEventListener("click", nextPulse);
  resetButton.addEventListener("click", resetScene);
  window.addEventListener("havvn:motion-change", motionChange);
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", sync);
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);
  window.addEventListener("pageshow", sync);
  window.addEventListener("pagehide", (event) => {
    renderer.setAnimationLoop(null);
    running = false;
    last = 0;
    if (event.persisted) return;
    disposed = true;
    resizeObserver.disconnect();
    observer?.disconnect();
    languageObserver.disconnect();
    cancelDrag();
    hero.removeEventListener("pointermove", pointer);
    hero.removeEventListener("pointerleave", resetPointer);
    canvas.removeEventListener("pointerdown", startDrag);
    canvas.removeEventListener("pointermove", moveDrag);
    canvas.removeEventListener("pointerup", endDrag);
    canvas.removeEventListener("pointercancel", endDrag);
    canvas.removeEventListener("lostpointercapture", cancelDrag);
    canvas.removeEventListener("keydown", keyboard);
    pulseButton.removeEventListener("click", nextPulse);
    resetButton.removeEventListener("click", resetScene);
    window.removeEventListener("havvn:motion-change", motionChange);
    document.removeEventListener("visibilitychange", sync);
    reduced.removeEventListener("change", sync);
    window.removeEventListener("pageshow", sync);
    canvas.removeEventListener("webglcontextlost", contextLost);
    canvas.removeEventListener("webglcontextrestored", contextRestored);
    const geometries = new Set(),
      materials = new Set();
    scene.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material)
        (Array.isArray(object.material)
          ? object.material
          : [object.material]
        ).forEach((material) => materials.add(material));
    });
    geometries.forEach((item) => item.dispose());
    materials.forEach((item) => item.dispose());
    glowTexture.dispose();
    environment.dispose();
    renderer.dispose();
  });
  resize();
  sync();
}
