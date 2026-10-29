// Motion for the dashboard. One rule: motion marks data arriving or changing.
// The full intro plays once per day per browser; on later opens the numbers just
// appear. After that only values that changed animate. Everything respects
// prefers-reduced-motion. No libraries.
(function () {
  var reduce =
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var first = true;
  var changed = false;

  // The intro is a once-a-day treat, not a toll on every open.
  var KEY = "lambert-intro-day";
  function todayKey() {
    return new Date().toLocaleDateString("en-CA");
  }
  var playedToday = false;
  try {
    playedToday = window.localStorage.getItem(KEY) === todayKey();
  } catch (e) {}
  var skipIntro = reduce || playedToday;

  function ease(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // Replay a one-shot CSS animation class on an element.
  // The class clears when the animation ends, with a timer as a backup.
  function restart(el, cls) {
    if (el._end) el.removeEventListener("animationend", el._end);
    clearTimeout(el._t);
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    function clear() {
      el.classList.remove(cls);
      el.removeEventListener("animationend", el._end);
    }
    el._end = function (e) {
      if (e.target === el) clear();
    };
    el.addEventListener("animationend", el._end);
    el._t = setTimeout(clear, 1200);
  }

  // Count an element's number from what it showed before up to `to`.
  // fmt(n) returns the HTML to show, so units stay in the page's own code.
  function num(el, to, fmt) {
    fmt = fmt || String;
    var from = typeof el._v === "number" ? el._v : 0;
    el._v = to;
    if (el._raf) cancelAnimationFrame(el._raf);
    el._raf = null;
    if (reduce || from === to || (first && skipIntro)) {
      el.innerHTML = fmt(to);
      return;
    }
    if (!first) {
      changed = true;
      restart(el, "tick");
    }
    var dur = first ? 800 : 450;
    var t0 = null;
    el.innerHTML = fmt(from);
    function step(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      el.innerHTML = fmt(p < 1 ? Math.round(from + (to - from) * ease(p)) : to);
      el._raf = p < 1 ? requestAnimationFrame(step) : null;
    }
    el._raf = requestAnimationFrame(step);
  }

  // Fill an SVG ring from empty. Pulse once when the goal is newly reached.
  function ring(el, frac, circ) {
    frac = Math.min(1, Math.max(0, frac));
    var was = el._f;
    el._f = frac;
    var target = circ * (1 - frac);
    if (first) {
      // Start empty for the intro, or jump straight to the value without animating.
      el.style.transition = "none";
      el.style.strokeDashoffset = skipIntro ? target : circ;
      void el.getBoundingClientRect();
      el.style.transition = "";
    }
    el.style.strokeDashoffset = target;
    if (!first && !reduce && was < 1 && frac >= 1)
      restart(el.ownerSVGElement || el, "pulse");
  }

  // Give matching elements an index (--c / --r) so CSS can stagger them.
  function index(sel, prop, global) {
    var seen = new Map();
    var n = 0;
    [].forEach.call(document.querySelectorAll(sel), function (el) {
      var i = global ? n++ : seen.get(el.parentNode) || 0;
      if (!global) seen.set(el.parentNode, i + 1);
      el.style.setProperty(prop, i);
    });
  }

  // Call once at the end of every render.
  function done() {
    if (first && !skipIntro) {
      try {
        window.localStorage.setItem(KEY, todayKey());
      } catch (e) {}
      index(".card", "--c", true);
      index(".row, .rk, .bar, .col, .dots i", "--r", false);
      document.body.classList.add("intro");
      setTimeout(function () {
        document.body.classList.remove("intro");
      }, 1800);
    } else if (changed && !reduce) {
      var last = document.querySelector("#chart .col:last-child .stk");
      if (last) restart(last, "tick");
    }
    changed = false;
    first = false;
  }

  // Crossfade an element's text (used for headings that change with a tab).
  function swap(el, text) {
    clearTimeout(el._sw);
    if (reduce || el.textContent === text) {
      el.textContent = text;
      return;
    }
    el.classList.add("m-out");
    el._sw = setTimeout(function () {
      el.textContent = text;
      el.classList.remove("m-out");
    }, 120);
  }

  // Fade the page out, then go to url. Without motion it just goes.
  function leave(url) {
    if (reduce) {
      location.href = url;
      return;
    }
    document.body.classList.add("m-leaving");
    setTimeout(function () {
      location.href = url;
    }, 180);
  }
  // Coming back with the Back button must not show a half-faded page.
  window.addEventListener("pageshow", function () {
    document.body.classList.remove("m-leaving");
  });

  // Ease elements in as they scroll into view (staggered within each group).
  // Elements are only hidden once this has started watching them, so if it
  // cannot run, the content simply stays visible. fn(el) runs when one appears.
  function reveal(sel, fn) {
    if (reduce || !window.IntersectionObserver) return;
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          io.unobserve(e.target);
          e.target.classList.add("m-seen");
          if (fn) fn(e.target);
        });
      },
      { threshold: 0.15 },
    );
    var seen = new Map();
    [].forEach.call(document.querySelectorAll(sel), function (el) {
      var n = seen.get(el.parentNode) || 0;
      seen.set(el.parentNode, n + 1);
      el.style.setProperty("--r", n);
      el.classList.add("m-armed");
      io.observe(el);
    });
  }

  // Shrink an element away (height, padding, fade), then call done().
  function collapse(el, done) {
    if (reduce) {
      done();
      return;
    }
    el.style.overflow = "hidden";
    el.style.height = el.offsetHeight + "px";
    el.style.transition =
      "height .25s ease, padding .25s ease, opacity .2s ease";
    void el.offsetHeight;
    el.style.height = "0";
    el.style.paddingTop = el.style.paddingBottom = "0";
    el.style.opacity = "0";
    setTimeout(done, 270);
  }

  window.Motion = {
    num: num,
    ring: ring,
    done: done,
    swap: swap,
    leave: leave,
    reveal: reveal,
    collapse: collapse,
  };
})();
