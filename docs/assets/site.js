/* Local, progressive demos: nothing here connects to peers or uploads files. */
(() => {
  "use strict";
  const root = document.documentElement;
  const languageButton = document.querySelector("#language");
  const menuButton = document.querySelector("#menu-toggle");
  const navigation = document.querySelector("#navigation");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const translated = [...document.querySelectorAll("[data-ru]")];
  translated.forEach((element) => {
    element.dataset.en = element.textContent;
  });
  let language = "en",
    playing = false,
    transferPaused = false,
    guest = false,
    paused = false,
    roomMuted = false;
  const playButton = document.querySelector("#demo-play");
  const inviteButton = document.querySelector("#demo-invite");
  const transferButton = document.querySelector("#demo-transfer");
  const motionButton = document.querySelector("#motion-toggle");
  const text = (en, ru) => (language === "ru" ? ru : en);
  const titles = {
    en: "Havvn — files, friends & a little more.",
    ru: "Havvn — файлы и хорошая компания.",
  };
  const descriptions = {
    en: "A free, open-source P2P hub for Windows and Linux. Download torrents, share files, watch together and talk in private rooms. No Havvn accounts or cloud storage.",
    ru: "Бесплатный P2P-хаб с открытым кодом для Windows и Linux. Скачивай торренты, делись файлами, смотри вместе и общайся в приватных комнатах. Без аккаунтов Havvn и облачного хранения.",
  };
  function updateLabels() {
    document
      .querySelector(".capture-tabs")
      .setAttribute(
        "aria-label",
        text("Application screenshots", "Снимки приложения"),
      );
    document
      .querySelector(".room-modes")
      .setAttribute("aria-label", text("Room features", "Возможности комнаты"));
    document.querySelector("#room-mic-label").textContent = roomMuted
      ? text("Unmute sample microphone", "Включить демо-микрофон")
      : text("Mute sample microphone", "Выключить демо-микрофон");
    document.querySelector("#room-mic-status").textContent = roomMuted
      ? text("Sample voice muted", "Демо-голос выключен")
      : text("Sample voice on", "Демо-голос включён");
    menuButton.setAttribute(
      "aria-label",
      menuButton.getAttribute("aria-expanded") === "true"
        ? text("Close navigation", "Закрыть меню")
        : text("Open navigation", "Открыть меню"),
    );
    playButton.setAttribute(
      "aria-label",
      playing
        ? text("Pause the animation demo", "Остановить демонстрацию анимации")
        : text("Play the animation demo", "Запустить демонстрацию анимации"),
    );
    document.querySelector("#demo-state").textContent = playing
      ? text("Demo playing", "Демо запущено")
      : text("Demo paused", "Демо на паузе");
    document
      .querySelector("nav")
      .setAttribute(
        "aria-label",
        text("Main navigation", "Основная навигация"),
      );
    document
      .querySelector(".scenario-controls")
      .setAttribute(
        "aria-label",
        text("Product scenarios", "Сценарии использования"),
      );
    document
      .querySelectorAll(".brand")
      .forEach((element) =>
        element.setAttribute(
          "aria-label",
          text("Havvn home", "Havvn — на главную"),
        ),
      );
    document
      .querySelector(".back-top")
      .setAttribute("aria-label", text("Back to top", "Наверх"));
    document
      .querySelector("#demo-search")
      .setAttribute(
        "aria-label",
        text("Find a sample file", "Найти файл в примере"),
      );
    document
      .querySelector("#demo-message")
      .setAttribute(
        "aria-label",
        text("Sample message", "Сообщение в демо-комнату"),
      );
    document
      .querySelector("#demo-chat button")
      .setAttribute(
        "aria-label",
        text("Send sample message", "Отправить сообщение в демо-комнату"),
      );
    document
      .querySelector("#demo-messages")
      .setAttribute("aria-label", text("Sample chat", "Демонстрационный чат"));
    document
      .querySelector(".platform-tabs")
      .setAttribute(
        "aria-label",
        text("Download platform", "Платформа для скачивания"),
      );
    document
      .querySelector(".preview-themes")
      .setAttribute(
        "aria-label",
        text("Preview appearance", "Оформление макета"),
      );
    document.querySelectorAll("[data-preview-theme]").forEach((button) => {
      const names = {
        graphite: text("Graphite appearance", "Графитовое оформление"),
        paper: text("Paper appearance", "Бумажное оформление"),
        moss: text("Moss appearance", "Зелёное оформление"),
      };
      button.setAttribute("aria-label", names[button.dataset.previewTheme]);
    });
    document.querySelectorAll("[data-placeholder-en]").forEach((input) => {
      input.placeholder =
        input.dataset[language === "ru" ? "placeholderRu" : "placeholderEn"];
    });
    document.querySelector("#guest-count").textContent = guest
      ? text("3 people", "3 участника")
      : text("2 people", "2 участника");
    inviteButton.querySelector("span").textContent = guest
      ? text("− Remove guest", "− Убрать гостя")
      : text("+ Invite a friend", "+ Пригласить друга");
    transferButton.setAttribute(
      "aria-label",
      transferPaused
        ? text("Resume sample download", "Продолжить демо-загрузку")
        : text("Pause sample download", "Остановить демо-загрузку"),
    );
    document.querySelector("#transfer-status").textContent = transferPaused
      ? text("Sample download paused", "Демо загрузки на паузе")
      : text(
          "Sample download · sequential mode",
          "Демо загрузки · последовательный режим",
        );
    document.querySelectorAll("[data-demo-author]").forEach((author) => {
      author.textContent = text("You", "Ты");
    });
    const motionText = motionButton.querySelector("[data-ru]");
    motionText.textContent = motion.matches
      ? text("Reduced motion", "Анимация снижена")
      : paused
        ? text("Resume motion", "Включить анимацию")
        : text("Motion is on", "Анимация включена");
    motionButton.setAttribute(
      "aria-label",
      motion.matches
        ? text(
            "System reduced motion is enabled",
            "Анимация снижена в настройках системы",
          )
        : paused
          ? text("Resume visual effects", "Включить визуальные эффекты")
          : text("Pause visual effects", "Остановить визуальные эффекты"),
    );
    motionButton.disabled = motion.matches;
    const outroMotion = document.querySelector("#outro-motion");
    outroMotion.disabled = motion.matches;
    outroMotion.setAttribute("aria-pressed", String(paused));
    outroMotion.querySelector("span").textContent = motion.matches
      ? text("Reduced motion", "Анимация снижена")
      : paused
        ? text("Resume effects", "Включить эффекты")
        : text("Pause effects", "Остановить эффекты");
    document
      .querySelector("#signal-outro")
      .setAttribute(
        "aria-label",
        text("Havvn closing sequence", "Финальная сцена Havvn"),
      );
  }
  function setLanguage(next, remember = false) {
    language = next;
    root.lang = next;
    translated.forEach((element) => {
      element.textContent = element.dataset[next];
    });
    languageButton.textContent = next === "ru" ? "EN" : "RU";
    languageButton.setAttribute(
      "aria-label",
      text("Switch to Russian", "Switch to English"),
    );
    document.title = titles[next];
    document.querySelector('meta[name="description"]').content =
      descriptions[next];
    document.querySelector('meta[property="og:title"]').content = titles[next];
    document.querySelector('meta[property="og:description"]').content =
      descriptions[next];
    updateLabels();
    if (remember) {
      try {
        localStorage.setItem("havvn-site-language", next);
      } catch {
        /* Optional preference. */
      }
    }
  }
  let saved;
  try {
    saved = localStorage.getItem("havvn-site-language");
  } catch {
    /* Browser language is enough. */
  }
  setLanguage(
    saved === "ru" || saved === "en"
      ? saved
      : navigator.language.toLowerCase().startsWith("ru")
        ? "ru"
        : "en",
  );
  languageButton.addEventListener("click", () =>
    setLanguage(language === "ru" ? "en" : "ru", true),
  );

  function closeMenu(returnFocus = false) {
    navigation.classList.remove("is-open");
    menuButton.setAttribute("aria-expanded", "false");
    updateLabels();
    if (returnFocus) menuButton.focus();
  }
  menuButton.addEventListener("click", () => {
    const open = menuButton.getAttribute("aria-expanded") !== "true";
    navigation.classList.toggle("is-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    updateLabels();
  });
  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      menuButton.getAttribute("aria-expanded") === "true"
    )
      closeMenu(true);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("header")) closeMenu();
  });
  matchMedia("(min-width: 901px)").addEventListener("change", () =>
    closeMenu(),
  );

  function setPlaying(next) {
    playing = next;
    document.querySelector(".cinema").classList.toggle("is-playing", next);
    playButton.innerHTML = next
      ? '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 5 10 7-10 7V5Z" stroke="currentColor" stroke-width="1.5"/></svg>';
    playButton.setAttribute("aria-pressed", String(next));
    updateLabels();
  }
  const tabs = [...document.querySelectorAll("[data-scenario]")];
  const screenshots = [...document.querySelectorAll("[data-ui-shot]")];
  function selectScreenshot(tab, focus = false) {
    screenshots.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden =
        !selected;
    });
    if (focus) tab.focus();
  }
  screenshots.forEach((tab, index) => {
    tab.addEventListener("click", () => selectScreenshot(tab));
    tab.addEventListener("keydown", (event) =>
      tabKeys(event, screenshots, index, selectScreenshot),
    );
  });
  function selectScenario(tab, focus = false) {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden =
        !selected;
    });
    if (tab.dataset.scenario !== "watch") setPlaying(false);
    if (focus) tab.focus();
  }
  function tabKeys(event, items, index, select) {
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = (index + 1) % items.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index + items.length - 1) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      select(items[next], true);
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectScenario(tab));
    tab.addEventListener("keydown", (event) =>
      tabKeys(event, tabs, index, selectScenario),
    );
  });
  const roomModes = [...document.querySelectorAll("[data-room-mode]")];
  function selectRoomMode(tab, focus = false) {
    roomModes.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden =
        !selected;
    });
    if (focus) tab.focus();
  }
  roomModes.forEach((tab, index) => {
    tab.addEventListener("click", () => selectRoomMode(tab));
    tab.addEventListener("keydown", (event) =>
      tabKeys(event, roomModes, index, selectRoomMode),
    );
  });
  document.querySelector("#room-mic").addEventListener("click", () => {
    roomMuted = !roomMuted;
    document
      .querySelector("#room-mic")
      .setAttribute("aria-pressed", String(roomMuted));
    updateLabels();
  });
  document
    .querySelector(".room-demo-link")
    .addEventListener("click", () =>
      selectScenario(document.querySelector("#tab-rooms")),
    );
  playButton.addEventListener("click", () => setPlaying(!playing));
  transferButton.addEventListener("click", () => {
    transferPaused = !transferPaused;
    transferButton.setAttribute("aria-pressed", String(transferPaused));
    transferButton.textContent = transferPaused ? "▷" : "Ⅱ";
    updateLabels();
  });
  document.querySelector("#demo-search").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLocaleLowerCase();
    let matches = 0;
    document.querySelectorAll("[data-file]").forEach((file) => {
      file.hidden = !file.dataset.file.includes(query);
      if (!file.hidden) matches++;
    });
    document.querySelector("#demo-empty").hidden = matches !== 0;
  });
  inviteButton.addEventListener("click", () => {
    guest = !guest;
    inviteButton.setAttribute("aria-pressed", String(guest));
    document.querySelector("#demo-guest").hidden = !guest;
    updateLabels();
  });
  document.querySelector("#demo-chat").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#demo-message");
    const message = input.value.trim();
    if (!message) return;
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble own";
    bubble.dataset.localMessage = "";
    const author = document.createElement("span");
    author.className = "message-author";
    author.dataset.demoAuthor = "";
    author.textContent = text("You", "Ты");
    const body = document.createElement("p");
    body.textContent = message;
    bubble.append(author, body);
    const log = document.querySelector("#demo-messages");
    log.append(bubble);
    const messages = log.querySelectorAll("[data-local-message]");
    if (messages.length > 10) messages[0].remove();
    input.value = "";
    log.scrollTop = log.scrollHeight;
    input.focus({ preventScroll: true });
  });
  document.querySelectorAll("[data-preview-theme]").forEach((button) =>
    button.addEventListener("click", () => {
      document.querySelector(".app-preview").dataset.theme =
        button.dataset.previewTheme;
      document
        .querySelectorAll("[data-preview-theme]")
        .forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button)),
        );
    }),
  );
  const platforms = [...document.querySelectorAll("[data-platform]")];
  function selectPlatform(tab, focus = false) {
    platforms.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden =
        !selected;
    });
    if (focus) tab.focus();
  }
  platforms.forEach((tab, index) => {
    tab.addEventListener("click", () => selectPlatform(tab));
    tab.addEventListener("keydown", (event) =>
      tabKeys(event, platforms, index, selectPlatform),
    );
  });
  if (
    /linux/i.test(navigator.userAgentData?.platform || navigator.platform) &&
    !/android/i.test(navigator.userAgent)
  )
    selectPlatform(platforms[1]);

  motionButton.addEventListener("click", () => {
    paused = !paused;
    root.classList.toggle("motion-paused", paused);
    motionButton.setAttribute("aria-pressed", String(paused));
    updateLabels();
    window.dispatchEvent(
      new CustomEvent("havvn:motion-change", { detail: { paused } }),
    );
  });
  document
    .querySelector("#outro-motion")
    .addEventListener("click", () => motionButton.click());
  motion.addEventListener("change", () => {
    updateLabels();
    if (motion.matches) setPlaying(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setPlaying(false);
  });
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting && playing) setPlaying(false);
    });
    observer.observe(document.querySelector("#experience"));
    const links = [...navigation.querySelectorAll('a[href^="#"]')];
    const current = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting)
            links.forEach((link) => {
              const active =
                link.getAttribute("href") === "#" + entry.target.id;
              link.classList.toggle("active", active);
              if (active) link.setAttribute("aria-current", "location");
              else link.removeAttribute("aria-current");
            });
        }),
      { rootMargin: "-15% 0px -55% 0px" },
    );
    links.forEach((link) =>
      current.observe(document.querySelector(link.getAttribute("href"))),
    );
  }
})();

const siteScript = document.currentScript;
const heroSceneUrl = siteScript?.dataset.scene;
if (heroSceneUrl) {
  import(new URL(heroSceneUrl, document.baseURI).href)
    .then((scene) => scene.createHeroScene())
    .catch(() => {
      document.querySelector(".hero-art").dataset.scene = "fallback";
    });
}
const outroUrl = siteScript?.dataset.outro;
if (outroUrl) {
  let requested = false;
  const loadOutro = () => {
    if (requested) return;
    requested = true;
    import(new URL(outroUrl, document.baseURI).href)
      .then((module) => module.createSignalOutro())
      .catch(() => {
        document.querySelector("#signal-outro").dataset.scene = "fallback";
      });
  };
  if ("IntersectionObserver" in window) {
    const preloadOutro = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          preloadOutro.disconnect();
          loadOutro();
        }
      },
      { rootMargin: "250px" },
    );
    preloadOutro.observe(document.querySelector("#signal-outro"));
  } else loadOutro();
}
