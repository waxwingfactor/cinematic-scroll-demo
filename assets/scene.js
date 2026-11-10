/* Scroll scene: an image sequence played against scroll position, with stage stops.
 *
 * Markup:  <section class="scene" data-scene="home" data-dwell="0.2,0.4,0.35" data-travel="1.4,2.0">
 *            <div class="scene__sticky"> <canvas class="scene__canvas"></canvas> ...overlays... </div>
 *          </section>
 * Frame data (counts, stops, label tracks) comes from assets/scene-data.js, written by the export script.
 *
 * Positions inside a scene are measured in "stage units": 0 = first stop, 1 = second stop, 1.5 = halfway
 * between the second and third. Overlays use them:  data-range="0.85 1.15"  data-fade="0.12 0.1"
 *
 * Scrolling stays native (no wheel hijacking). Three things are added on top of it:
 *   - the "next" button and the stage rail tween the page to a stop;
 *   - on wheel/keyboard, if scrolling ends between two stops, the scene finishes the move it was on;
 *   - touch scrolling scrubs freely.
 */
(function () {
  'use strict';

  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var smooth = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  var easeInOut = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
  var pad = function (n) { return ('0000' + n).slice(-4); };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function Scene(el, data) {
    this.el = el;
    this.data = data;
    this.sticky = el.querySelector('.scene__sticky');
    this.canvas = el.querySelector('.scene__canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.stops = data.stops;
    this.dwell = (el.dataset.dwell || '').split(',').map(Number);
    this.travel = (el.dataset.travel || '').split(',').map(Number);
    this.settle = el.dataset.settle !== 'off';
    this.imgs = {};          // frame -> HTMLImageElement (loaded)
    this.hq = {};            // frame -> HTMLImageElement (loaded, full quality, stops only)
    this.pending = 0;
    this.queue = [];
    this.frame = 0;
    this.lastDrawn = '';
    this.tween = null;
    this.lastY = window.scrollY;
    this.dir = 1;
    this.input = 'wheel';
    this.idleTimer = 0;
    this.overlays = [].slice.call(el.querySelectorAll('[data-range]')).map(function (o) {
      var r = o.dataset.range.split(/\s+/).map(Number);
      var f = (o.dataset.fade || '0.1 0.1').split(/\s+/).map(Number);
      return { el: o, a: r[0], b: r[1], fi: f[0], fo: f[1], shift: Number(o.dataset.shift || 28) };
    });
    this.counts = [].slice.call(el.querySelectorAll('[data-count]')).map(function (o) {
      var raw = o.textContent.trim();
      var num = parseFloat(raw.replace(/[^0-9.\-]/g, ''));
      var dec = (raw.split('.')[1] || '').replace(/[^0-9]/g, '').length;
      var r = o.dataset.count.split(/\s+/).map(Number);
      return { el: o, target: num, dec: dec, a: r[0], b: r[1], grouped: /,/.test(raw) || num >= 10000 };
    });
    this.pins = [].slice.call(el.querySelectorAll('[data-pin]'));
    this.nextBtn = el.querySelector('.scene__next');
    this.nextLabel = el.querySelector('.scene__next-label');
    this.rail = [].slice.call(el.querySelectorAll('.scene__rail [data-stop]'));
    this.loadEl = el.querySelector('.scene__load');
    this.pickSet();
    this.layout();
    this.bind();
    this.buildQueue();
    this.pump();
    this.update(true);
  }

  Scene.prototype.pickSet = function () {
    var portrait = window.innerWidth / window.innerHeight < 0.9;
    var name = portrait && this.data.sets.m ? 'm' : 'd';
    if (name !== this.setName) {
      this.setName = name;
      this.set = this.data.sets[name];
      this.imgs = {}; this.hq = {}; this.queue = []; this.lastDrawn = '';
      if (this.loaded !== undefined) { this.buildQueue(); this.pump(); }
    }
  };

  Scene.prototype.has = function (i) {
    return i % this.set.step === 0 || (this.set.dense > 0 && i >= this.set.dense) ||
      this.stops.indexOf(i) !== -1 || i === this.data.frames - 1;
  };

  /* ---- scroll layout ------------------------------------------------------------------------ */
  Scene.prototype.layout = function () {
    var vh = this.sticky.offsetHeight || window.innerHeight;
    var segs = [], y = 0, i;
    this.rest = [];
    for (i = 0; i < this.stops.length; i++) {
      var d = (this.dwell[i] || 0.3) * vh;
      segs.push({ y0: y, y1: y + d, f0: this.stops[i], f1: this.stops[i] });
      this.rest.push(i === 0 ? 0 : y + d * 0.5);
      y += d;
      if (i < this.stops.length - 1) {
        var t = (this.travel[i] || 1.5) * vh;
        segs.push({ y0: y, y1: y + t, f0: this.stops[i], f1: this.stops[i + 1], move: i });
        y += t;
      }
    }
    this.segs = segs;
    this.span = y;
    this.vh = vh;
    this.el.style.height = Math.round(y + vh) + 'px';
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(this.sticky.clientWidth * dpr), h = Math.round(vh * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h; this.lastDrawn = '';
    }
  };

  Scene.prototype.top = function () { return this.el.getBoundingClientRect().top + window.scrollY; };

  Scene.prototype.frameAt = function (y) {
    y = clamp(y, 0, this.span);
    for (var i = 0; i < this.segs.length; i++) {
      var s = this.segs[i];
      if (y <= s.y1 || i === this.segs.length - 1) {
        var t = s.y1 > s.y0 ? clamp((y - s.y0) / (s.y1 - s.y0), 0, 1) : 0;
        return { f: s.f0 + (s.f1 - s.f0) * t, seg: s };
      }
    }
  };

  Scene.prototype.stageOf = function (f) {
    for (var i = 0; i < this.stops.length - 1; i++) {
      if (f <= this.stops[i + 1]) return i + (f - this.stops[i]) / (this.stops[i + 1] - this.stops[i]);
    }
    return this.stops.length - 1;
  };

  /* ---- loading: stops first, then coarse to fine --------------------------------------------- */
  Scene.prototype.buildQueue = function () {
    var self = this, seen = {}, q = [], n = this.data.frames;
    var add = function (i) { if (i >= 0 && i < n && self.has(i) && !seen[i]) { seen[i] = 1; q.push(i); } };
    this.stops.forEach(add);
    [16, 8, 4, 2, 1].forEach(function (step) { for (var i = 0; i < n; i += step) add(i); });
    add(n - 1);
    this.queue = q;
    this.total = q.length;
    this.loaded = 0;
    this.coarse = Math.min(q.length, this.stops.length + Math.ceil(n / 8));
    this.loadHq(this.stops[0]);
  };

  Scene.prototype.src = function (i) { return this.data.base + '/' + this.setName + '/' + pad(i) + '.webp'; };

  Scene.prototype.loadHq = function (i) {
    var self = this;
    if (this.hq[i] !== undefined || this.stops.indexOf(i) === -1) return;
    this.hq[i] = null;
    var im = new Image(), set = this.setName;
    im.onload = function () { if (set === self.setName) { self.hq[i] = im; self.lastDrawn = ''; self.draw(); } };
    im.src = this.data.base + '/hq/' + this.setName + '-' + pad(i) + '.webp';
  };

  Scene.prototype.pump = function () {
    var self = this;
    while (this.pending < 6 && this.queue.length) {
      (function (i, set) {
        self.pending++;
        var im = new Image();
        im.decoding = 'async';
        im.onload = im.onerror = function (e) {
          if (e.type === 'error' && !im.retried && set === self.setName) {   // one retry on a dropped request
            im.retried = true;
            setTimeout(function () { im.src = self.src(i) + '?r=1'; }, 400);
            return;
          }
          self.pending--;
          if (set !== self.setName) return;
          if (e.type === 'load') self.imgs[i] = im;
          self.loaded++;
          if (self.loadEl) {
            var p = Math.min(1, self.loaded / self.coarse);
            self.loadEl.style.setProperty('--p', p);
            if (p >= 1) self.loadEl.classList.add('is-done');
          }
          if (Math.abs(i - self.frame) < 9) { self.lastDrawn = ''; self.draw(); }
          self.pump();
        };
        im.src = self.src(i);
      })(this.queue.shift(), this.setName);
    }
  };

  Scene.prototype.bump = function (f) {       // bring frames around the playhead to the front
    if (!this.queue.length) return;
    var near = [], rest = [];
    this.queue.forEach(function (i) { (Math.abs(i - f) <= 10 ? near : rest).push(i); });
    if (near.length) this.queue = near.concat(rest);
  };

  /* ---- drawing ------------------------------------------------------------------------------ */
  Scene.prototype.nearest = function (f, dirn) {
    var n = this.data.frames;
    for (var i = dirn < 0 ? Math.floor(f) : Math.ceil(f); i >= 0 && i < n; i += dirn) if (this.imgs[i]) return i;
    return -1;
  };

  Scene.prototype.cover = function (im) {
    var cw = this.canvas.width, ch = this.canvas.height;
    var s = Math.max(cw / im.naturalWidth, ch / im.naturalHeight);
    var w = im.naturalWidth * s, h = im.naturalHeight * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w: w, h: h };
  };

  Scene.prototype.draw = function () {
    var f = this.frame, ctx = this.ctx;
    var atStop = this.stops.indexOf(Math.round(f));
    if (atStop !== -1 && Math.abs(f - Math.round(f)) < 0.02) {
      var hq = this.hq[Math.round(f)];
      if (hq === undefined) this.loadHq(Math.round(f));
      if (hq) {
        if (this.lastDrawn === 'hq' + Math.round(f)) return;
        var r0 = this.cover(hq);
        ctx.globalAlpha = 1; ctx.drawImage(hq, r0.x, r0.y, r0.w, r0.h);
        this.lastDrawn = 'hq' + Math.round(f); this.rect = r0;
        return;
      }
    }
    var a = this.nearest(f, -1), b = this.nearest(f, 1);
    if (a === -1) a = b;
    if (b === -1) b = a;
    if (a === -1) return;
    var t = b > a ? (f - a) / (b - a) : 0;
    // cross-fade neighbours only where the camera is slow; the fly-in takes show whole frames
    if (reduced || b - a > 3 || a >= this.data.blendUntil) t = t < 0.5 ? 0 : 1;
    var key = a + ':' + b + ':' + t.toFixed(2);
    if (key === this.lastDrawn) return;
    this.lastDrawn = key;
    var r = this.cover(this.imgs[a]);
    this.rect = r;
    ctx.globalAlpha = 1;
    if (t < 1) ctx.drawImage(this.imgs[a], r.x, r.y, r.w, r.h);
    if (t > 0) { ctx.globalAlpha = t; ctx.drawImage(this.imgs[b], r.x, r.y, r.w, r.h); ctx.globalAlpha = 1; }
    if (!this.canvas.classList.contains('is-ready')) this.canvas.classList.add('is-ready');
  };

  /* ---- overlays ----------------------------------------------------------------------------- */
  Scene.prototype.paint = function () {
    var s = this.stageOf(this.frame), self = this;
    this.overlays.forEach(function (o) {
      var op = 1;
      if (o.a > -0.5) op = Math.min(op, smooth((s - o.a) / o.fi));
      if (o.b < 90) op = Math.min(op, smooth((o.b - s) / o.fo));
      var dirn = s < (o.a + o.b) / 2 || o.b >= 90 ? 1 : -1;
      o.el.style.opacity = op.toFixed(3);
      o.el.style.transform = 'translate3d(0,' + ((1 - op) * o.shift * dirn).toFixed(1) + 'px,0)';
      o.el.style.visibility = op <= 0.001 ? 'hidden' : 'visible';
      o.el.classList.toggle('is-on', op > 0.35);
    });
    this.counts.forEach(function (c) {
      var p = easeOut(clamp((s - c.a) / (c.b - c.a), 0, 1));
      var v = c.target * p;
      var txt = c.dec ? v.toFixed(c.dec) : String(Math.round(v));
      if (c.grouped) txt = Number(txt).toLocaleString('en-US', { minimumFractionDigits: c.dec });
      if (c.el.textContent !== txt) c.el.textContent = txt;
    });
    if (this.pins.length && this.data.tracks && this.rect) {
      var fi = clamp(Math.round(this.frame), 0, this.data.trackFrames - 1);
      var crop = this.set.crop || [0, 0, 1, 1];
      var dpr = this.canvas.width / this.sticky.clientWidth;
      var W = this.sticky.clientWidth, H = this.vh;
      var blocks = [], st = this.sticky.getBoundingClientRect();
      this.overlays.forEach(function (o) {
        if (!o.el.classList.contains('stage') || !o.el.classList.contains('is-on')) return;
        [].forEach.call(o.el.children, function (c) {
          var r = c.getBoundingClientRect();
          blocks.push({ left: r.left - st.left, right: r.right - st.left, top: r.top - st.top, bottom: r.bottom - st.top });
        });
      });
      this.pins.forEach(function (p) {
        var tr = self.data.tracks[p.dataset.pin];
        if (!tr) return;
        var pt = tr[fi];
        var x = (self.rect.x + ((pt[0] - crop[0]) / crop[2]) * self.rect.w) / dpr;
        var y = (self.rect.y + ((pt[1] - crop[1]) / crop[3]) * self.rect.h) / dpr;
        var inside = x > 70 && x < W - 70 && y > 90 && y < H - 60;
        if (inside && blocks.length) {
          var body = p.firstElementChild, bw = body.offsetWidth / 2 + 10, bh = body.offsetHeight + 10;
          for (var k = 0; k < blocks.length; k++) {
            var b = blocks[k];
            if (x + bw > b.left && x - bw < b.right && y > b.top - 6 && y - bh < b.bottom) { inside = false; break; }
          }
        }
        p.style.left = x.toFixed(1) + 'px';
        p.style.top = y.toFixed(1) + 'px';
        p.classList.toggle('is-out', !inside || self.frame > self.data.trackFrames - 1);
      });
    }
    var cur = Math.round(s);
    this.rail.forEach(function (b) { b.classList.toggle('is-current', Number(b.dataset.stop) === cur); });
    if (this.nextBtn) {
      var idx = Math.min(Math.floor(s + 0.5), this.stops.length - 1);
      var labels = (this.nextBtn.dataset.labels || '').split('|');
      if (this.nextLabel && labels[idx] && this.nextLabel.textContent !== labels[idx]) this.nextLabel.textContent = labels[idx];
      var seg = this.frameAt(window.scrollY - this.top()).seg;
      this.nextBtn.style.setProperty('--ring', (s - Math.floor(s)).toFixed(3));
      this.nextBtn.classList.toggle('is-moving', seg.move !== undefined);
    }
  };

  Scene.prototype.update = function (force) {
    var y = window.scrollY - this.top();
    if (!force && (y < -this.vh || y > this.span + this.vh)) return;
    var fr = this.frameAt(y);
    this.frame = fr.f;
    this.bump(fr.f);
    this.draw();
    this.paint();
  };

  /* ---- motion: tweens, settle, controls ------------------------------------------------------ */
  Scene.prototype.cancel = function () {
    if (this.tween) { cancelAnimationFrame(this.tween.raf); this.tween = null; }
  };

  Scene.prototype.scrollTo = function (target, ms) {
    var self = this, from = window.scrollY, dist = target - from;
    this.cancel();
    if (Math.abs(dist) < 2) return;
    if (reduced) { window.scrollTo(0, target); return; }
    var dur = ms || clamp(900 + Math.abs(dist) / this.vh * 1500, 900, 4600);
    var t0 = performance.now();
    var tw = { raf: 0 };
    this.tween = tw;
    var step = function (now) {
      if (self.tween !== tw) return;
      var t = clamp((now - t0) / dur, 0, 1);
      window.scrollTo(0, from + dist * easeInOut(t));
      if (t < 1) tw.raf = requestAnimationFrame(step); else self.tween = null;
    };
    tw.raf = requestAnimationFrame(step);
  };

  Scene.prototype.goToStop = function (i) { this.scrollTo(this.top() + this.rest[i]); };

  Scene.prototype.next = function () {
    var y = window.scrollY - this.top();
    for (var i = 0; i < this.rest.length; i++) {
      if (this.rest[i] > y + 4) { this.goToStop(i); return; }
    }
    this.scrollTo(this.top() + this.span + this.vh - this.headerOffset(), 1500);
  };

  Scene.prototype.headerOffset = function () {
    var h = document.querySelector('.site-header');
    return h ? h.offsetHeight - 1 : 0;
  };

  Scene.prototype.onIdle = function () {
    if (!this.settle || reduced || this.tween || this.input === 'touch') return;
    var y = window.scrollY - this.top();
    if (y <= 0 || y >= this.span) return;
    var seg = this.frameAt(y).seg;
    if (seg.move === undefined) return;
    var to = this.dir >= 0 ? seg.move + 1 : seg.move;
    var target = this.top() + this.rest[to];
    var left = Math.abs(target - window.scrollY) / this.vh;
    this.scrollTo(target, clamp(700 + left * 1500, 700, 3800));
  };

  Scene.prototype.bind = function () {
    var self = this, ticking = false;
    window.addEventListener('scroll', function () {
      var y = window.scrollY;
      if (!self.tween && y !== self.lastY) self.dir = y > self.lastY ? 1 : -1;
      self.lastY = y;
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () { ticking = false; self.update(); });
      }
      clearTimeout(self.idleTimer);
      self.idleTimer = setTimeout(function () { self.onIdle(); }, 170);
    }, { passive: true });
    window.addEventListener('wheel', function () { self.input = 'wheel'; self.cancel(); }, { passive: true });
    window.addEventListener('touchstart', function () { self.input = 'touch'; self.cancel(); }, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Home', 'End'].indexOf(e.key) !== -1) {
        self.input = 'wheel'; self.cancel();
      }
    });
    var onResize = function () {
      var y = window.scrollY - self.top(), fr = self.frameAt(y), stage = self.stageOf(fr.f);
      var wasInside = y > 0 && y < self.span;
      self.pickSet(); self.layout();
      if (wasInside && Math.abs(stage - Math.round(stage)) < 0.02) window.scrollTo(0, self.top() + self.rest[Math.round(stage)]);
      self.update(true);
    };
    var rz = 0, lastW = window.innerWidth;
    window.addEventListener('resize', function () {
      // mobile browsers fire resize when the address bar hides; only the width matters there
      if (self.input === 'touch' && window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      clearTimeout(rz); rz = setTimeout(onResize, 120);
    });
    window.addEventListener('orientationchange', function () { setTimeout(onResize, 250); });
    if (this.nextBtn) this.nextBtn.addEventListener('click', function () { self.input = 'wheel'; self.next(); });
    this.rail.forEach(function (b) {
      b.addEventListener('click', function () { self.input = 'wheel'; self.goToStop(Number(b.dataset.stop)); });
    });
  };

  /* ---- page chrome -------------------------------------------------------------------------- */
  function chrome() {
    var header = document.querySelector('.site-header');
    var first = document.querySelector('.scene');
    var onScroll = function () {
      if (!header) return;
      var limit = first ? first.offsetTop + first.offsetHeight - header.offsetHeight - 8 : 40;
      header.classList.toggle('is-solid', window.scrollY > limit);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    var burger = document.querySelector('.site-header__burger');
    if (burger) burger.addEventListener('click', function () {
      var open = header.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
      [].forEach.call(document.querySelectorAll('.reveal'), function (n) { io.observe(n); });
    } else {
      [].forEach.call(document.querySelectorAll('.reveal'), function (n) { n.classList.add('is-in'); });
    }
  }

  function start() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    document.documentElement.classList.add('js');
    window.__scenes = [].map.call(document.querySelectorAll('.scene'), function (el) {
      return new Scene(el, window.SCENE_DATA[el.dataset.scene]);
    });
    chrome();
    requestAnimationFrame(function () { document.documentElement.classList.add('is-loaded'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
