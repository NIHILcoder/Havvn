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
  const art = document.querySelector('.hero-art');
  let pointerPending = false;
  let pointerX = 0, pointerY = 0;
  art.addEventListener('pointermove', e => {
    if (motion.matches || !finePointer.matches) return;
    const bounds = art.getBoundingClientRect();
    pointerX = (e.clientX - bounds.left) / bounds.width - 0.5;
    pointerY = (e.clientY - bounds.top) / bounds.height - 0.5;
    if (!pointerPending) {
      pointerPending = true;
      window.requestAnimationFrame(() => {
        art.style.setProperty('--tilt-x', (-pointerY * 12) + 'deg');
        art.style.setProperty('--tilt-y', (pointerX * 16) + 'deg');
        pointerPending = false;
      });
    }
  });
  art.addEventListener('pointerleave', () => {
    art.style.setProperty('--tilt-x', '0deg');
    art.style.setProperty('--tilt-y', '0deg');
  });
  document.querySelectorAll('.feature').forEach(card => {
    card.addEventListener('pointermove', e => {
      if (motion.matches || !finePointer.matches) return;
      const bounds = card.getBoundingClientRect();
      card.style.setProperty('--pointer-x', (e.clientX - bounds.left) / bounds.width * 100 + '%');
      card.style.setProperty('--pointer-y', (e.clientY - bounds.top) / bounds.height * 100 + '%');
    });
  });
})();

/* The hero is a real, locally rendered particle scene. No libraries or requests. */
(() => {
  'use strict';
  const root = document.documentElement;
  const hero = document.querySelector('.hero');
  const art = document.querySelector('.hero-art');
  const canvas = document.querySelector('#network-scene');
  const ctx = canvas.getContext('2d', {alpha:true});
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fine = window.matchMedia('(pointer: fine)');
  const toggle = document.querySelector('#motion-toggle');
  const toggleText = toggle.querySelector('[data-ru]');
  const track = document.querySelector('.kinetic-track');
  const band = document.querySelector('.kinetic-band');
  let paused = false, visible = true, frame = 0, last = 0, clock = 0;
  let width = 0, height = 0, dpr = 1;
  let aimX = 0, aimY = 0, x = 0, y = 0;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = Array.from({length:110}, (_,i) => {
    const py = 1 - (i / 109) * 2;
    const r = Math.sqrt(1 - py * py), theta = golden * i;
    return {x:Math.cos(theta)*r,y:py,z:Math.sin(theta)*r};
  });
  const links = [];
  points.forEach((p,i) => points.slice(i+1).forEach((q,k) => {
    const distance = Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z);
    if(distance<0.62) links.push([i,i+k+1,distance]);
  }));
  function labels() {
    const ru = root.lang === 'ru';
    toggleText.textContent = reduced.matches ? (ru ? 'Анимация снижена' : 'Reduced motion') : paused ? (ru ? 'Включить анимацию' : 'Resume motion') : (ru ? 'Анимация включена' : 'Motion is on');
    toggle.setAttribute('aria-label', reduced.matches ? (ru ? 'Анимация снижена в настройках системы' : 'System reduced motion is enabled') : paused ? (ru ? 'Включить визуальные эффекты' : 'Resume visual effects') : (ru ? 'Остановить визуальные эффекты' : 'Pause visual effects'));
    toggle.setAttribute('aria-pressed',String(paused));
    toggle.disabled = reduced.matches;
  }
  new MutationObserver(labels).observe(root,{attributes:true,attributeFilter:['lang']});
  labels();
  function rotate(p,angle,tilt) {
    const px=p.x*Math.cos(angle)+p.z*Math.sin(angle);
    const pz=p.z*Math.cos(angle)-p.x*Math.sin(angle);
    return {x:px,y:p.y*Math.cos(tilt)-pz*Math.sin(tilt),z:p.y*Math.sin(tilt)+pz*Math.cos(tilt)};
  }
  function project(p,r) {
    const perspective=1/(1+p.z*.24);
    return {x:width*.53+p.x*r*perspective,y:height*.5+p.y*r*perspective,z:p.z,s:perspective};
  }
  function paint(time) {
    if (!ctx || !width) return;
    const angle=time*.00013+x*.48, tilt=.2+y*.3;
    const radius=Math.min(width,height)*.36;
    ctx.clearRect(0,0,width,height);
    const cloud=points.map(p=>project(rotate(p,angle,tilt),radius));
    ctx.lineWidth=.7;
    links.forEach(([i,j,distance])=>{
      const p=cloud[i],q=cloud[j],alpha=(1-(p.z+q.z+2)/4)*.17+.025;
      ctx.strokeStyle='rgba(248,141,91,'+alpha+')';
      ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();
    });
    for(let ring=0;ring<3;ring++) {
      ctx.beginPath();
      for(let n=0;n<=130;n++) {
        const theta=n/130*Math.PI*2;
        let p={x:Math.cos(theta)*1.1,y:Math.sin(theta)*1.1,z:0};
        if(ring===1)p={x:p.x,y:p.y*.46,z:p.y*.88};
        if(ring===2)p={x:p.x*.6,y:p.y,z:p.x*.8};
        const projected=project(rotate(p,angle*(ring===1?-1:1)+ring*.6,tilt),radius);
        if(n===0)ctx.moveTo(projected.x,projected.y);else ctx.lineTo(projected.x,projected.y);
      }
      ctx.strokeStyle=ring===1?'rgba(255,194,137,.23)':'rgba(229,114,69,.12)';
      ctx.lineWidth=ring===1?1.2:.7;ctx.stroke();
      const theta=time*.0004+ring*2.1;
      let p={x:Math.cos(theta)*1.1,y:Math.sin(theta)*1.1,z:0};
      if(ring===1)p={x:p.x,y:p.y*.46,z:p.y*.88};
      if(ring===2)p={x:p.x*.6,y:p.y,z:p.x*.8};
      const dot=project(rotate(p,angle*(ring===1?-1:1)+ring*.6,tilt),radius);
      const glow=ctx.createRadialGradient(dot.x,dot.y,0,dot.x,dot.y,14);
      glow.addColorStop(0,'rgba(255,210,160,.9)');glow.addColorStop(.2,'rgba(255,125,60,.45)');glow.addColorStop(1,'rgba(255,125,60,0)');
      ctx.fillStyle=glow;ctx.fillRect(dot.x-14,dot.y-14,28,28);
    }
    cloud.sort((a,b)=>b.z-a.z).forEach((p,i)=>{
      const alpha=.2+(1-p.z)*.28;
      ctx.fillStyle='rgba(255,184,128,'+alpha+')';
      ctx.beginPath();ctx.arc(p.x,p.y,(i%11===0?2.2:1.2)*p.s,0,Math.PI*2);ctx.fill();
    });
    // Small deterministic orbiting dust particles give the sculpture depth.
    for(let i=0;i<130;i++) {
      const a=i*golden+time*.000018, z=Math.sin(i*2.1);
      const r=radius*(.82+(i%7)*.055);
      const p=project(rotate({x:Math.cos(a)*r/radius,y:Math.sin(a)*r/radius,z},angle*.55,tilt),radius);
      ctx.fillStyle='rgba(255,175,123,'+(.07+(i%5)*.025)+')';
      ctx.fillRect(p.x,p.y,i%6===0?1.5:1,i%6===0?1.5:1);
    }
  }
  function canAnimate() {return ctx && !paused && !reduced.matches && visible && !document.hidden;}
  function tick(now) {
    frame=0;
    if(!canAnimate()){last=0;return;}
    if(!last)last=now;
    const elapsed=Math.min(40,now-last);
    last=now;clock+=elapsed;
    x+=(aimX-x)*.045;y+=(aimY-y)*.045;
    art.style.setProperty('--tilt-x',(-y*12)+'deg');
    art.style.setProperty('--tilt-y',(x*16)+'deg');
    paint(clock);
    frame=requestAnimationFrame(tick);
  }
  function start() {
    if(canAnimate()&&!frame){last=0;frame=requestAnimationFrame(tick);}
    else if(!canAnimate()){
      cancelAnimationFrame(frame);frame=0;paint(clock);
    }
  }
  function resize() {
    const r=art.getBoundingClientRect();
    width=r.width;height=r.height;dpr=Math.min(devicePixelRatio||1,1.75);
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
    if(ctx)ctx.setTransform(dpr,0,0,dpr,0,0);
    paint(clock);start();
  }
  new ResizeObserver(resize).observe(art);
  hero.addEventListener('pointermove',event=>{
    if(!fine.matches||!canAnimate())return;
    const bounds=art.getBoundingClientRect();
    aimX=Math.max(-1,Math.min(1,(event.clientX-bounds.left)/bounds.width*2-1));
    aimY=Math.max(-1,Math.min(1,(event.clientY-bounds.top)/bounds.height*2-1));
  },{passive:true});
  hero.addEventListener('pointerleave',()=>{aimX=0;aimY=0;});
  toggle.addEventListener('click',()=>{
    paused=!paused;root.classList.toggle('motion-paused',paused);labels();start();
  });
  reduced.addEventListener('change',()=>{labels();start();updateScrollScene();});
  document.addEventListener('visibilitychange',start);
  if('IntersectionObserver' in window){
    const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;start();},{rootMargin:'100px'});
    observer.observe(hero);
  }
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
  resize();
})();
