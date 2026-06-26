/* Dot&Co 界面预览 — 纯静态截图，无需 API / 本地服务 */
(function () {
  const PREVIEW_LIST = [
    { id: 'web-home', label: '用户首页', route: '/home', platform: 'web' },
    { id: 'web-login', label: '登录', route: '/login', platform: 'web' },
    { id: 'web-intro', label: '引导页', route: '/intro', platform: 'web' },
    { id: 'web-category', label: '分类', route: '/category', platform: 'web' },
    { id: 'web-search', label: '搜索', route: '/search', platform: 'web' },
    { id: 'web-blueprint', label: '图纸详情', route: '/blueprint/[id]', platform: 'web' },
    { id: 'web-upload', label: '创作中心', route: '/upload', platform: 'web' },
    { id: 'web-converter', label: '图案转换器', route: '/pattern-converter', platform: 'web' },
    { id: 'web-profile', label: '个人中心', route: '/profile', platform: 'web' },
    { id: 'web-points', label: '豆币中心', route: '/points', platform: 'web' },
    { id: 'web-favorites', label: '收藏', route: '/favorites', platform: 'web' },
    { id: 'web-stores', label: '门店', route: '/stores', platform: 'web' },
    { id: 'web-notifications', label: '通知', route: '/notifications', platform: 'web' },
    { id: 'admin-login', label: '管理员登录', route: '/admin/login', platform: 'admin' },
    { id: 'admin-dashboard', label: '数据概览', route: '/admin/dashboard', platform: 'admin' },
    { id: 'admin-blueprints', label: '图纸审核', route: '/admin/blueprints', platform: 'admin' },
    { id: 'admin-users', label: '用户管理', route: '/admin/users', platform: 'admin' },
    { id: 'admin-banners', label: 'Banner', route: '/admin/banners', platform: 'admin' },
    { id: 'admin-bookings', label: '预约', route: '/admin/bookings', platform: 'admin' },
    { id: 'admin-pattern-jobs', label: '转换任务', route: '/admin/pattern-jobs', platform: 'admin' },
  ];

  const ROUTE_MAP = {
    '/': 'web-home', '/home': 'web-home',
    '/login': 'web-login', '/callback': 'web-login', '/auth/callback': 'web-login',
    '/intro': 'web-intro', '/terms': 'web-intro', '/privacy': 'web-intro',
    '/category': 'web-category', '/search': 'web-search',
    '/blueprint/[id]': 'web-blueprint', '/blueprint/[id]/edit': 'web-blueprint',
    '/user/[id]': 'web-profile', '/tutorial': 'web-category',
    '/upload': 'web-upload', '/upload/notice': 'web-upload', '/upload/manual': 'web-upload',
    '/pattern-converter': 'web-converter',
    '/pattern-converter/jobs': 'web-converter', '/pattern-converter/jobs/[id]': 'web-converter',
    '/free-create': 'web-converter', '/pixel-restore': 'web-converter', '/local-upload': 'web-converter',
    '/profile': 'web-profile', '/profile/frames': 'web-profile',
    '/favorites': 'web-favorites', '/my/blueprints': 'web-profile', '/my/bookings': 'web-stores',
    '/notifications': 'web-notifications',
    '/points': 'web-points', '/points/recharge': 'web-points', '/points/recharge/callback': 'web-points',
    '/points/recharge/alipay': 'web-points', '/points/recharge/alipay/return': 'web-points',
    '/points/orders': 'web-points', '/points/redeem': 'web-points', '/points/lottery': 'web-points',
    '/points/badges': 'web-points', '/points/events': 'web-points',
    '/stores': 'web-stores', '/stores/map': 'web-stores',
    '/admin/login': 'admin-login', '/admin': 'admin-dashboard', '/admin/dashboard': 'admin-dashboard',
    '/admin/banners': 'admin-banners', '/admin/blueprints': 'admin-blueprints',
    '/admin/comments': 'admin-dashboard', '/admin/reports': 'admin-dashboard',
    '/admin/users': 'admin-users', '/admin/points': 'admin-dashboard',
    '/admin/bead-palettes': 'admin-pattern-jobs', '/admin/categories': 'admin-dashboard',
    '/admin/pattern-jobs': 'admin-pattern-jobs', '/admin/pattern-jobs/[id]': 'admin-pattern-jobs',
    '/admin/stores': 'admin-dashboard', '/admin/bookings': 'admin-bookings',
    '/admin/payments': 'admin-dashboard', '/admin/recommendations': 'admin-dashboard',
    '/admin/tutorials': 'admin-dashboard', '/admin/redeem': 'admin-dashboard',
  };

  function resolvePreviewId(route, platform) {
    return ROUTE_MAP[route] || (platform === 'admin' ? 'admin-dashboard' : 'web-home');
  }

  function getMeta(id) {
    return PREVIEW_LIST.find((p) => p.id === id) || { id, label: id, route: '/', platform: 'web' };
  }

  function shotUrl(id) {
    return `screenshots/${id}.png`;
  }

  function placeholder(name, route, platform) {
    return `
      <div class="preview-placeholder">
        <div class="preview-placeholder-icon">${platform === 'admin' ? '🖥️' : '📱'}</div>
        <h4>${name}</h4>
        <code>${route}</code>
        <p>截图缺失：<code>screenshots/${platform === 'admin' ? 'admin' : 'web'}-*.png</code></p>
        <p class="dim">运行 <code>pnpm exec node scripts/capture-showcase-screenshots.mjs</code> 重新生成</p>
      </div>`;
  }

  window.DotCoPreview = {
    PREVIEW_LIST, ROUTE_MAP, resolvePreviewId, getMeta,

    renderGallery(containerId) {
      document.getElementById(containerId).innerHTML = PREVIEW_LIST.map((p) =>
        `<button type="button" class="preview-thumb${p.id === 'web-home' ? ' active' : ''}" data-preview="${p.id}" data-platform="${p.platform}">
          <span class="preview-thumb-tag">${p.platform === 'admin' ? 'Admin' : 'H5'}</span>
          <span class="preview-thumb-label">${p.label}</span>
          <code>${p.route}</code>
        </button>`
      ).join('');
    },

    show(id, opts = {}) {
      const meta = getMeta(id);
      const platform = meta.platform || (id.startsWith('admin') ? 'admin' : 'web');
      const name = opts.name || meta.label;
      const route = opts.route || meta.route;
      const shot = shotUrl(id);

      const stage = document.getElementById('preview-stage');
      const frame = document.getElementById('preview-frame');
      const title = document.getElementById('preview-title');
      const routeEl = document.getElementById('preview-route');
      const modeEl = document.getElementById('preview-mode');
      const hint = document.querySelector('.preview-stage-head p');

      stage.classList.toggle('is-admin', platform === 'admin');
      stage.classList.toggle('is-web', platform === 'web');
      title.textContent = name;
      routeEl.textContent = route;

      frame.innerHTML = `<img class="preview-shot" src="${shot}" alt="${name}" />`;
      const img = frame.querySelector('img');

      const markLoaded = () => {
        if (modeEl) modeEl.textContent = '◆ 真实页面截图';
        if (hint) hint.textContent = 'Playwright 抓取的真实 UI，纯静态展示，无需连接后端';
      };

      img.onerror = () => {
        frame.innerHTML = placeholder(name, route, platform);
        if (modeEl) modeEl.textContent = '○ 截图缺失';
      };
      if (img.complete && img.naturalWidth > 0) {
        markLoaded();
      } else {
        if (modeEl) modeEl.textContent = '◆ 加载截图…';
        img.onload = markLoaded;
      }

      document.querySelectorAll('.preview-thumb').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.preview === id);
      });
      document.querySelectorAll('.page-card[data-preview-id]').forEach((card) => {
        card.classList.toggle('preview-linked', card.dataset.previewId === id);
      });
    },

    init() {
      this.renderGallery('preview-gallery');
      document.querySelectorAll('.preview-thumb').forEach((t) => {
        t.style.display = t.dataset.platform === 'web' ? '' : 'none';
      });
      this.show('web-home');

      document.getElementById('preview-gallery').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-preview]');
        if (!btn) return;
        this.show(btn.dataset.preview);
      });

      document.querySelectorAll('.preview-platform-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.preview-platform-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const pf = btn.dataset.platform;
          document.querySelectorAll('.preview-thumb').forEach((t) => {
            t.style.display = t.dataset.platform === pf ? '' : 'none';
          });
          const first = document.querySelector(`.preview-thumb[data-platform="${pf}"]`);
          if (first) this.show(first.dataset.preview);
        });
      });
    },

    linkPageCard(card, route, name, platform) {
      const id = resolvePreviewId(route, platform);
      card.dataset.previewId = id;
      card.style.cursor = 'pointer';
      card.title = '点击查看界面截图';
      card.addEventListener('click', () => {
        const pfBtn = document.querySelector(`.preview-platform-btn[data-platform="${platform}"]`);
        if (pfBtn && !pfBtn.classList.contains('active')) pfBtn.click();
        document.querySelectorAll('.preview-thumb').forEach((t) => {
          t.style.display = t.dataset.platform === platform ? '' : 'none';
        });
        document.getElementById('preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
        this.show(id, { name, route });
      });
    },
  };
})();
