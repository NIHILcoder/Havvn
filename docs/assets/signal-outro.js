/* A scroll-driven, instanced 3D wordmark. No scroll interception or idle loop. */
import * as THREE from "./vendor/three-0.180.0/three.module.min.js";

export async function createSignalOutro() {
  const section = document.querySelector("#signal-outro");
  const canvas = document.querySelector("#signal-canvas");
  const label = section.querySelector(".signal-progress");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const compact = matchMedia("(max-width: 700px)");
  const mark = new Image();
  mark.src = new URL("./wordmark.svg", import.meta.url).href;
  await mark.decode();
  const sample = document.createElement("canvas");
  sample.width = 440;
  sample.height = 100;
  const brush = sample.getContext("2d", { willReadFrequently: true });
  brush.drawImage(mark, 0, 0, 440, 100);
  const pixels = brush.getImageData(0, 0, 440, 100).data;
  const blocks = [];
  const stride = compact.matches ? 5 : 4;
  for (let y = 1; y < 100; y += stride)
    for (let x = 1; x < 440; x += stride) {
      const i = (y * 440 + x) * 4;
      if (pixels[i + 3] > 100)
        blocks.push({
          x: (x - 220) * 0.026,
          y: (50 - y) * 0.026,
          color: new THREE.Color(
            pixels[i] / 255,
            pixels[i + 1] / 255,
            pixels[i + 2] / 255,
          ).convertSRGBToLinear(),
        });
    }
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: !compact.matches,
    powerPreference: "low-power",
  });
  if (!context || !blocks.length) {
    section.dataset.scene = "fallback";
    return;
  }
  const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-7, 7, 4, -4, 0.1, 80);
  camera.position.set(0, 0, 22);
  const uniforms = { uProgress: { value: 1 }, uGlitch: { value: 0 } };
  const geometry = new THREE.BoxGeometry(
    stride * 0.026 * 0.89,
    stride * 0.026 * 0.89,
    0.22,
  );
  const scatter = new Float32Array(blocks.length * 3);
  for (let i = 0; i < blocks.length; i++) {
    scatter[i * 3] = Math.sin(i * 2.39996) * (0.4 + (i % 13) * 0.08);
    scatter[i * 3 + 1] = Math.cos(i * 1.731) * (0.3 + (i % 7) * 0.1);
    scatter[i * 3 + 2] = Math.sin(i * 3.17) * 2;
  }
  geometry.setAttribute(
    "aScatter",
    new THREE.InstancedBufferAttribute(scatter, 3),
  );
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      attribute vec3 aScatter;
      uniform float uProgress;
      uniform float uGlitch;
      varying vec3 vColor;
      varying vec3 vNormal;
      void main() {
        float assembled = smoothstep(0.04, 0.64, uProgress);
        vec4 p = instanceMatrix * vec4(position, 1.0);
        p.xyz += aScatter * (1.0 - assembled) * vec3(3.1, 1.5, 3.0);
        float band = step(0.57, fract(p.y * 2.2 + uProgress * 1.4));
        p.x += (band - .35) * uGlitch * 1.25;
        p.z += sin(p.y * 14.0 + uProgress * 12.0) * uGlitch * .7;
        vColor = instanceColor;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      varying vec3 vNormal;
      void main() {
        float light = .68 + .45 * max(0.0, dot(normalize(vNormal), normalize(vec3(-.4,.8,1.0))));
        gl_FragColor = vec4(vColor * light, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const word = new THREE.InstancedMesh(geometry, material, blocks.length);
  const matrix = new THREE.Matrix4();
  blocks.forEach((block, i) => {
    matrix.makeTranslation(block.x, block.y, 0);
    word.setMatrixAt(i, matrix);
    word.setColorAt(i, block.color);
  });
  word.instanceMatrix.needsUpdate = true;
  word.instanceColor.needsUpdate = true;
  word.frustumCulled = false;
  scene.add(word);
  let frame = 0,
    last = 0,
    progress = 1,
    energy = 0,
    visible = true,
    lost = false,
    disposed = false,
    renders = 0;
  let lastScroll = scrollY;
  const still = () =>
    reduced.matches ||
    document.documentElement.classList.contains("motion-paused");
  section.classList.add("is-enhanced");
  canvas.dataset.instances = String(blocks.length);
  function position() {
    if (still()) return 1;
    const bounds = section.getBoundingClientRect();
    const header =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--nav-height",
        ),
      ) || 83;
    const travel = Math.max(1, section.offsetHeight - (innerHeight - header));
    return THREE.MathUtils.clamp((header - bounds.top) / travel, 0, 1);
  }
  function paint(now = 0) {
    frame = 0;
    if (disposed || lost || !visible || document.hidden) {
      last = 0;
      return;
    }
    const delta = last ? Math.min(50, now - last) : 16;
    if (compact.matches && last && delta < 32) {
      frame = requestAnimationFrame(paint);
      return;
    }
    last = now;
    progress = position();
    if (still()) energy = 0;
    const gate = Math.exp(-(((progress - 0.7) / 0.15) ** 2));
    const distortion = Math.min(1, energy) * gate;
    uniforms.uProgress.value = progress;
    uniforms.uGlitch.value = distortion * 0.65;
    word.rotation.set(
      0.06 + (1 - progress) * 0.2,
      -0.04 + (1 - progress) * -0.16 + distortion * 0.045,
      (1 - progress) * -0.025,
    );
    word.position.y = compact.matches ? -0.1 : -0.6;
    section.style.setProperty("--signal-progress", progress.toFixed(4));
    section.style.setProperty(
      "--signal-blur",
      (distortion * (compact.matches ? 1.6 : 2.8)).toFixed(2) + "px",
    );
    section.style.setProperty(
      "--signal-shift",
      (distortion * Math.sin(progress * 11) * 3).toFixed(2) + "px",
    );
    section.style.setProperty("--signal-energy", distortion.toFixed(4));
    section.dataset.progress = progress.toFixed(4);
    label.textContent =
      String(Math.round(progress * 100)).padStart(3, "0") + " / 100";
    renderer.render(scene, camera);
    section.dataset.scene = "webgl";
    canvas.dataset.frame = String(++renders);
    energy *= Math.exp(-delta / 115);
    if (energy > 0.004 && !still()) frame = requestAnimationFrame(paint);
    else {
      last = 0;
      section.style.setProperty("--signal-blur", "0px");
      section.style.setProperty("--signal-shift", "0px");
      section.style.setProperty("--signal-energy", "0");
    }
  }
  function request() {
    if (!frame && !disposed && !lost && visible && !document.hidden)
      frame = requestAnimationFrame(paint);
  }
  function scroll() {
    const next = scrollY;
    if (visible && !still())
      energy = Math.max(
        energy,
        Math.min(1.4, Math.abs(next - lastScroll) / 100),
      );
    lastScroll = next;
    request();
  }
  function resize() {
    if (disposed || lost) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    renderer.setPixelRatio(
      Math.min(devicePixelRatio || 1, compact.matches ? 1.15 : 1.5),
    );
    renderer.setSize(bounds.width, bounds.height, false);
    const aspect = bounds.width / bounds.height;
    const halfWidth = compact.matches ? 6.45 : 7.25;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfWidth / aspect;
    camera.bottom = -halfWidth / aspect;
    camera.updateProjectionMatrix();
    request();
  }
  function motion() {
    energy = 0;
    request();
  }
  function visibility() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      energy = 0;
      last = 0;
    } else request();
  }
  function contextLost(event) {
    event.preventDefault();
    lost = true;
    cancelAnimationFrame(frame);
    frame = 0;
    section.dataset.scene = "fallback";
  }
  function contextRestored() {
    lost = false;
    resize();
  }
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries[0].isIntersecting;
      if (visible) {
        lastScroll = scrollY;
        request();
      } else {
        cancelAnimationFrame(frame);
        frame = 0;
        energy = 0;
        last = 0;
      }
    },
    { rootMargin: "100px" },
  );
  observer.observe(section);
  const sizing = new ResizeObserver(resize);
  sizing.observe(canvas);
  window.addEventListener("scroll", scroll, { passive: true });
  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("havvn:motion-change", motion);
  reduced.addEventListener("change", motion);
  document.addEventListener("visibilitychange", visibility);
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);
  window.addEventListener("pageshow", resize);
  window.addEventListener("pagehide", (event) => {
    cancelAnimationFrame(frame);
    frame = 0;
    energy = 0;
    last = 0;
    if (event.persisted) return;
    disposed = true;
    observer.disconnect();
    sizing.disconnect();
    window.removeEventListener("scroll", scroll);
    window.removeEventListener("resize", resize);
    window.removeEventListener("havvn:motion-change", motion);
    reduced.removeEventListener("change", motion);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pageshow", resize);
    canvas.removeEventListener("webglcontextlost", contextLost);
    canvas.removeEventListener("webglcontextrestored", contextRestored);
    geometry.dispose();
    material.dispose();
    word.dispose();
    renderer.dispose();
  });
  resize();
}
