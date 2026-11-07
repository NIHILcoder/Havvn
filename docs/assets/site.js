/* Progressive enhancement: the page remains readable without JavaScript. */
(() => {
  'use strict';
  const root = document.documentElement;
  const languageButton = document.querySelector('#language');
  const menuButton = document.querySelector('#menu-toggle');
  const navigation = document.querySelector('#navigation');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const translated = [...document.querySelectorAll('[data-ru]')];
  translated.forEach(el => { el.dataset.en = el.textContent; });
  let language = 'en';
  let playing = false;
  const labels = {
    en: {open: 'Open navigation', close: 'Close navigation', play: 'Play the animation demo', pause: 'Pause the animation demo', paused: 'Demo paused', playing: 'Demo playing'},
    ru: {open: 'Открыть меню', close: 'Закрыть меню', play: 'Запустить демонстрацию анимации', pause: 'Остановить демонстрацию анимации', paused: 'Демо на паузе', playing: 'Демо запущено'}
  };
  const titles = {
    en: 'Havvn — your people. Your files. Your rules.',
    ru: 'Havvn — твои люди. Твои файлы. Твои правила.'
  };
  const descriptions = {
    en: 'A free, open-source P2P hub for Windows and Linux. Download torrents, share files, watch together and talk in private rooms. No Havvn accounts or cloud storage.',
    ru: 'Бесплатный P2P-хаб с открытым кодом для Windows и Linux. Скачивай торренты, делись файлами, смотри вместе и общайся в приватных комнатах. Без аккаунтов Havvn и облачного хранения.'
  };
  const playButton = document.querySelector('#demo-play');
  const demoState = document.querySelector('#demo-state');
  function updateLabels() {
    menuButton.setAttribute('aria-label', labels[language][menuButton.getAttribute('aria-expanded') === 'true' ? 'close' : 'open']);
    playButton.setAttribute('aria-label', labels[language][playing ? 'pause' : 'play']);
    demoState.textContent = labels[language][playing ? 'playing' : 'paused'];
    document.querySelector('nav').setAttribute('aria-label', language === 'ru' ? 'Основная навигация' : 'Main navigation');
    document.querySelector('.scenario-controls').setAttribute('aria-label', language === 'ru' ? 'Сценарии использования' : 'Product scenarios');
    document.querySelectorAll('.brand').forEach(el => el.setAttribute('aria-label', language === 'ru' ? 'Havvn — на главную' : 'Havvn home'));
    document.querySelector('.next-update > a').setAttribute('aria-label', language === 'ru' ? 'Читать список изменений' : 'Read the changelog');
  }
  function setLanguage(next, remember = false) {
    language = next;
    root.lang = next;
    translated.forEach(el => { el.textContent = el.dataset[next]; });
    languageButton.textContent = next === 'ru' ? 'EN' : 'RU';
    languageButton.setAttribute('aria-label', next === 'ru' ? 'Switch to English' : 'Переключить на русский');
    document.title = titles[next];
    document.querySelector('meta[name="description"]').content = descriptions[next];
    document.querySelector('meta[property="og:title"]').content = titles[next];
    document.querySelector('meta[property="og:description"]').content = descriptions[next];
    updateLabels();
    if (remember) {
      try { localStorage.setItem('havvn-site-language', next); } catch { /* Storage can be disabled. */ }
    }
  }
  let savedLanguage;
  try { savedLanguage = localStorage.getItem('havvn-site-language'); } catch { /* Use browser language. */ }
  setLanguage(savedLanguage === 'ru' || savedLanguage === 'en' ? savedLanguage : navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en');
  languageButton.addEventListener('click', () => setLanguage(language === 'ru' ? 'en' : 'ru', true));

  function closeMenu(returnFocus = false) {
    navigation.classList.remove('is-open');
    menuButton.setAttribute('aria-expanded', 'false');
    updateLabels();
    if (returnFocus) menuButton.focus();
  }
  menuButton.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    navigation.classList.toggle('is-open', open);
    updateLabels();
  });
  navigation.addEventListener('click', e => {
    if (e.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') closeMenu(true);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('header') && menuButton.getAttribute('aria-expanded') === 'true') closeMenu();
  });
  const narrowNavigation = window.matchMedia('(max-width: 900px)');
  narrowNavigation.addEventListener('change', () => closeMenu());

  const tabs = [...document.querySelectorAll('[data-scenario]')];
  function selectTab(tab, focus = false) {
    tabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    });
    if (tab.dataset.scenario !== 'watch') setPlaying(false);
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
      let next;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % tabs.length;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {
        e.preventDefault();
        selectTab(tabs[next], true);
      }
    });
  });
  function setPlaying(next) {
    playing = next;
    document.querySelector('.cinema').classList.toggle('is-playing', next);
    playButton.innerHTML = next ? '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 5 10 7-10 7V5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    playButton.setAttribute('aria-pressed', String(next));
    updateLabels();
  }
  playButton.addEventListener('click', () => setPlaying(!playing));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setPlaying(false);
  });

  const reveals = [...document.querySelectorAll('.reveal')];
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    }, {threshold: 0.08});
    reveals.forEach(el => observer.observe(el));
    root.classList.add('motion-enabled');
  }

  const progress = document.querySelector('.scroll-progress');
  let scrollPending = false;
  function updateScroll() {
    const max = root.scrollHeight - window.innerHeight;
    progress.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0) + ')';
    scrollPending = false;
  }
  window.addEventListener('scroll', () => {
    if (!scrollPending) {
      scrollPending = true;
      window.requestAnimationFrame(updateScroll);
    }
  }, {passive: true});
  window.addEventListener('resize', updateScroll, {passive: true});
  updateScroll();

  if ('IntersectionObserver' in window) {
    const links = [...navigation.querySelectorAll('a[href^="#"]')];
    const sections = links.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);
    const active = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          links.forEach(link => {
            const current = link.getAttribute('href') === '#' + entry.target.id;
            link.classList.toggle('active', current);
            if (current) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
          });
        }
      });
    }, {rootMargin: '-15% 0px -55% 0px'});
    sections.forEach(section => active.observe(section));
  }

  const finePointer = window.matchMedia('(pointer: fine)');
  document.querySelectorAll('.feature').forEach(card => {
    card.addEventListener('pointermove', e => {
      if (motion.matches || root.classList.contains('motion-paused') || !finePointer.matches) return;
      const bounds = card.getBoundingClientRect();
      card.style.setProperty('--pointer-x', (e.clientX - bounds.left) / bounds.width * 100 + '%');
      card.style.setProperty('--pointer-y', (e.clientY - bounds.top) / bounds.height * 100 + '%');
    });
  });
})();

/* Shared motion controls also govern the progressively loaded Three.js scene. */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fine = window.matchMedia('(pointer: fine)');
  const toggle = document.querySelector('#motion-toggle');
  const toggleText = toggle.querySelector('[data-ru]');
  const track = document.querySelector('.kinetic-track');
  const band = document.querySelector('.kinetic-band');
  let paused = false;
  function labels() {
    const ru = root.lang === 'ru';
    toggleText.textContent = reduced.matches ? (ru ? 'Анимация снижена' : 'Reduced motion') : paused ? (ru ? 'Включить анимацию' : 'Resume motion') : (ru ? 'Анимация включена' : 'Motion is on');
    toggle.setAttribute('aria-label', reduced.matches ? (ru ? 'Анимация снижена в настройках системы' : 'System reduced motion is enabled') : paused ? (ru ? 'Включить визуальные эффекты' : 'Resume visual effects') : (ru ? 'Остановить визуальные эффекты' : 'Pause visual effects'));
    toggle.setAttribute('aria-pressed',String(paused));
    toggle.disabled = reduced.matches;
  }
  new MutationObserver(labels).observe(root,{attributes:true,attributeFilter:['lang']});
  labels();
  function notifyMotion() {
    window.dispatchEvent(new CustomEvent('havvn:motion-change', {detail: {paused}}));
  }
  toggle.addEventListener('click', () => {
    paused = !paused;
    root.classList.toggle('motion-paused', paused);
    labels(); notifyMotion(); updateScrollScene();
  });
  reduced.addEventListener('change', () => { labels(); notifyMotion(); updateScrollScene(); });
  let scrollFrame=0;
  function updateScrollScene(){
    const r=band.getBoundingClientRect();
    const progress=Math.max(0,Math.min(1,(innerHeight-r.top)/(innerHeight+r.height)));
    track.style.setProperty('--kinetic-x',reduced.matches||paused?'-4%':(-progress*23)+'%');
    scrollFrame=0;
  }
  window.addEventListener('scroll',()=>{
    if(!scrollFrame)scrollFrame=requestAnimationFrame(updateScrollScene);
  },{passive:true});
  window.addEventListener('resize',updateScrollScene,{passive:true});
  updateScrollScene();
  document.querySelectorAll('.feature,.privacy-grid article,.room-steps article').forEach((el,i)=>{
    el.style.transitionDelay=(i%3)*.065+'s';
  });
  document.querySelectorAll('.hero-actions .button,.platforms .button').forEach(button=>{
    button.addEventListener('pointermove',event=>{
      if(reduced.matches||paused||!fine.matches)return;
      const r=button.getBoundingClientRect();
      button.style.setProperty('--button-x',((event.clientX-r.left)/r.width*100)+'%');
      button.style.setProperty('--button-y',((event.clientY-r.top)/r.height*100)+'%');
      button.style.translate=((event.clientX-r.left)/r.width-.5)*5+'px '+((event.clientY-r.top)/r.height-.5)*4+'px';
    });
    button.addEventListener('pointerleave',()=>{button.style.translate='0 0';button.style.setProperty('--button-x','50%');button.style.setProperty('--button-y','50%');});
  });
})();

// Loading or WebGL failures leave the original brand SVG and all controls usable.
const heroSceneUrl = document.currentScript?.dataset.scene;
if (heroSceneUrl) {
  import(new URL(heroSceneUrl, document.baseURI).href)
    .then(scene => scene.createHeroScene())
    .catch(() => { document.querySelector('.hero-art').dataset.scene = 'fallback'; });
}
