/* Viewport-led presentation. Native scrolling, bounded timers, no idle JS loop. */
(() => {
  "use strict";
  if (!("IntersectionObserver" in window)) return;
  const root = document.documentElement;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let disposed = false;
  const still = () => reduced.matches || root.classList.contains("motion-paused");
  const sections = [...document.querySelectorAll("main > section[data-presentation]")];
  const revealGroups = [
    ["#overview", ".hero-copy > *, .product-capture, .hero-bottom"],
    ["#experience", ".section-heading > *, .scenario-controls, .app-preview, .demo-note"],
    ["#network", ".network-copy > *, .hero-art"],
    ["#rooms", ".room-copy > *, .room-preview, .room-facts > *"],
    ["#features", ".capabilities-heading > *, .capability-item"],
    ["#privacy", ".wrap > .eyebrow, .privacy-intro > *, .privacy-grid article, .network-note"],
    ["#updates", ".source-symbol, :scope > div"],
    ["#download", ".download-heading > *, .download-picker"],
    ["#faq", ":scope > div:first-child, .faq-list details"],
  ];
  const arrivals = [];
  revealGroups.forEach(([section, selector]) => {
    document.querySelector(section).querySelectorAll(selector).forEach((element, index) => {
      element.dataset.reveal = "";
      element.style.setProperty("--arrival-delay", Math.min(index % 4, 2) * 85 + "ms");
      arrivals.push(element);
    });
  });
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      target.classList.add("has-arrived");
      revealObserver.unobserve(target);
    });
  }, { rootMargin: "0px 0px 30px 0px", threshold: 0.04 });
  arrivals.forEach((element) => revealObserver.observe(element));

  // Each drawing has its own visibility so long mobile sections do no hidden work.
  const drawings = [...document.querySelectorAll(".capability-item, .privacy-grid article, .install-motion, .source-graph, .faq-list details")];
  drawings.forEach((element) => element.dataset.presentation = "");
  const visible = new Map();
  const visibility = new IntersectionObserver((entries) => {
    entries.forEach((entry) => visible.set(entry.target, entry.isIntersecting));
    syncVisuals();
  }, { threshold: 0.01 });
  [...sections, ...drawings].forEach((element) => visibility.observe(element));
  function syncVisuals() {
    const running = !still() && !document.hidden && !disposed;
    visible.forEach((onScreen, element) => {
      element.classList.toggle("is-presenting", running && onScreen);
    });
  }

  const definitions = {
    screens: { target: ".product-capture", count: 3, duration: 6800 },
    demo: { target: ".app-preview", count: 3, duration: 7400 },
    network: { target: ".hero-art", count: 4, duration: 3400 },
    rooms: { target: ".room-preview", count: 3, duration: 6800 },
  };
  const sequences = sections.filter((element) => element.dataset.sequence).map((element) => {
    const definition = definitions[element.dataset.sequence];
    element.style.setProperty("--sequence-duration", definition.duration + "ms");
    return { element, ...definition, index: 0, timer: 0, remaining: definition.duration,
      started: 0, visible: false, manual: false, initialized: false };
  });
  const byTarget = new Map(sequences.map((sequence) => [sequence.element.querySelector(sequence.target), sequence]));
  function cue(sequence) {
    sequence.initialized = true;
    sequence.element.dataset.sequenceStep = String(sequence.index);
    sequence.element.dispatchEvent(new CustomEvent("havvn:presentation-cue", {
      bubbles: true, detail: { sequence: sequence.element.dataset.sequence, step: sequence.index },
    }));
  }
  function stop(sequence) {
    if (!sequence.timer) return;
    clearTimeout(sequence.timer);
    sequence.timer = 0;
    sequence.remaining = Math.max(1, sequence.remaining - (performance.now() - sequence.started));
  }
  function syncSequence(sequence) {
    const running = sequence.visible && !sequence.manual && !still() && !document.hidden && !disposed;
    const wasRunning = sequence.element.dataset.presentationState === "playing";
    sequence.element.dataset.presentationState = sequence.manual ? "manual" : running ? "playing" : "paused";
    if (!running) { stop(sequence); return; }
    if (!sequence.initialized || !wasRunning) cue(sequence);
    if (sequence.timer) return;
    sequence.started = performance.now();
    sequence.timer = setTimeout(() => {
      sequence.timer = 0;
      sequence.index = (sequence.index + 1) % sequence.count;
      sequence.remaining = sequence.duration;
      cue(sequence);
      syncSequence(sequence);
    }, sequence.remaining);
  }
  const sequenceObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const sequence = byTarget.get(entry.target);
      sequence.visible = entry.isIntersecting && entry.intersectionRatio >= 0.15;
      syncSequence(sequence);
    });
  }, { threshold: 0.15 });
  byTarget.forEach((_, element) => sequenceObserver.observe(element));

  // A visitor can take over any demo. Never replace a focused panel or typed input.
  function manual(event) {
    if (!event.target.closest("button, input, form, a, [tabindex], canvas")) return;
    const sequence = sequences.find(({ element }) => element.contains(event.target));
    if (!sequence || event.target.closest("#motion-toggle")) return;
    sequence.manual = true;
    syncSequence(sequence);
  }
  const manualEvents = ["pointerdown", "keydown", "focusin", "click", "input", "submit"];
  manualEvents.forEach((type) => document.addEventListener(type, manual, true));
  function sync() {
    syncVisuals();
    sequences.forEach(syncSequence);
    if (still()) arrivals.forEach((element) => element.classList.add("has-arrived"));
  }
  window.addEventListener("havvn:motion-change", sync);
  reduced.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pageshow", sync);
  window.addEventListener("pagehide", (event) => {
    sequences.forEach(stop);
    if (event.persisted) return;
    disposed = true;
    visibility.disconnect();
    revealObserver.disconnect();
    sequenceObserver.disconnect();
    manualEvents.forEach((type) => document.removeEventListener(type, manual, true));
    window.removeEventListener("havvn:motion-change", sync);
    reduced.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("pageshow", sync);
  });
  root.classList.add("presentation-enabled");
  sync();
})();
