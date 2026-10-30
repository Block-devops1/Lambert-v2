// Month calendar for the Analytics page. Plain DOM, no libraries.
// Data: one object per day that has anything in it, keyed "YYYY-MM-DD":
//   { build: 190, stop: 20,
//     entries: [{ subject, minutes, type: "build" | "stop", note, time }],
//     misses:  [{ subject, reason, note }] }
// Calendar.mount(el, { goal, today, joined, days | getMonth(monthKey) -> days })
(function () {
  var MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  var WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  var WORDS = {
    goal: "Goal hit",
    some: "Under goal",
    miss: "Missed",
    none: "No build time",
  };

  function mk(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  function shift(key, by) {
    var p = key.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1 + by, 1));
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1);
  }
  function nice(s) {
    s = String(s || "").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // The rule for a day's colour lives here, in one place.
  // Red means a miss the user told Lambert about, never just a quiet day.
  function statusOf(date, info, o) {
    if (date > o.today || date < o.joined) return "off";
    var build = (info && info.build) || 0;
    if (build >= o.goal) return "goal";
    if (build > 0) return "some";
    if (info && info.misses && info.misses.length) return "miss";
    return "none";
  }

  function mount(root, opts) {
    var o = {
      goal: opts.goal || 180,
      today: opts.today,
      joined: opts.joined || opts.today,
      getMonth:
        opts.getMonth ||
        function () {
          return Promise.resolve(opts.days || {});
        },
    };
    var minM = o.joined.slice(0, 7),
      maxM = o.today.slice(0, 7);
    var month = opts.month || maxM;
    if (month < minM) month = minM;
    if (month > maxM) month = maxM;
    var token = 0,
      lastFocus = null,
      days = {};

    root.textContent = "";
    root.classList.add("cal");
    var prev = mk("button", "cal-nav", "‹"),
      next = mk("button", "cal-nav", "›");
    prev.type = next.type = "button";
    prev.setAttribute("aria-label", "Previous month");
    next.setAttribute("aria-label", "Next month");
    var year = mk("div", "cal-year"),
      name = mk("div", "cal-month");
    var title = mk("div", "cal-title");
    title.appendChild(year);
    title.appendChild(name);
    var head = mk("div", "cal-head");
    head.appendChild(prev);
    head.appendChild(title);
    head.appendChild(next);
    var sub = mk("div", "cal-sub");
    var dow = mk("div", "cal-dow");
    ["S", "M", "T", "W", "T", "F", "S"].forEach(function (d, i) {
      var s = mk("span", "", d);
      s.setAttribute("aria-label", WEEKDAYS[i]);
      dow.appendChild(s);
    });
    var grid = mk("div", "cal-grid");
    var legend = mk("div", "cal-legend");
    [
      ["goal", "Goal hit"],
      ["some", "Under goal"],
      ["none", "No build time"],
      ["miss", "Missed"],
    ].forEach(function (l) {
      var i = mk("span");
      i.appendChild(mk("i", "cal-key " + l[0]));
      i.appendChild(document.createTextNode(l[1]));
      legend.appendChild(i);
    });
    [head, sub, dow, grid, legend].forEach(function (e) {
      root.appendChild(e);
    });

    // Details popup: scrolls when there is a lot to show.
    var ovl = mk("div", "cal-ovl"),
      dlg = mk("div", "cal-dlg");
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    var dh = mk("div", "cal-dh"),
      dt = mk("div", "cal-dt"),
      x = mk("button", "cal-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    var body = mk("div", "cal-body");
    body.tabIndex = 0;
    dh.appendChild(dt);
    dh.appendChild(x);
    dlg.appendChild(dh);
    dlg.appendChild(body);
    ovl.appendChild(dlg);
    root.appendChild(ovl);

    function close() {
      ovl.classList.remove("open");
      document.removeEventListener("keydown", onKey);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "Tab") {
        e.preventDefault();
        (document.activeElement === x ? body : x).focus();
      }
    }
    x.onclick = close;
    ovl.onclick = function (e) {
      if (e.target === ovl) close();
    };

    function openDay(date, info, st, trigger) {
      lastFocus = trigger;
      var p = date.split("-"),
        wd = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
      dt.textContent =
        WEEKDAYS[wd] + ", " + +p[2] + " " + MONTHS[+p[1] - 1] + " " + p[0];
      body.textContent = "";
      info = info || {};
      var build = info.build || 0,
        stop = info.stop || 0;
      var line = mk("div", "cal-st " + st);
      line.textContent =
        WORDS[st] +
        (st === "goal" || st === "some"
          ? ": " + build + " of " + o.goal + " min"
          : "");
      body.appendChild(line);
      if (stop)
        body.appendChild(mk("div", "cal-sum", stop + " min on disruptors"));
      if (info.misses && info.misses.length) {
        body.appendChild(mk("div", "cal-h", "Missed"));
        info.misses.forEach(function (m) {
          var r = mk("div", "cal-row");
          r.appendChild(mk("b", "", m.subject));
          r.appendChild(mk("span", "", nice(m.reason)));
          if (m.note) r.appendChild(mk("em", "", m.note));
          body.appendChild(r);
        });
      }
      if (info.entries && info.entries.length) {
        body.appendChild(mk("div", "cal-h", "Logged"));
        info.entries.forEach(function (en) {
          var r = mk("div", "cal-row");
          r.appendChild(mk("b", "", en.subject));
          r.appendChild(
            mk(
              "span",
              en.type === "stop" ? "cal-stop" : "",
              en.minutes + " min" + (en.type === "stop" ? " · disruptor" : ""),
            ),
          );
          if (en.time) r.appendChild(mk("small", "", en.time));
          if (en.note) r.appendChild(mk("em", "", en.note));
          body.appendChild(r);
        });
      }
      if (!info.entries || !info.entries.length)
        if (!info.misses || !info.misses.length)
          body.appendChild(mk("div", "cal-sum", "Nothing logged this day."));
      body.scrollTop = 0;
      ovl.classList.add("open");
      document.addEventListener("keydown", onKey);
      x.focus();
    }

    function drawHeader() {
      var p = month.split("-");
      year.textContent = p[0];
      name.textContent = MONTHS[+p[1] - 1];
      prev.disabled = month <= minM;
      next.disabled = month >= maxM;
    }

    function drawGrid(dir) {
      var p = month.split("-"),
        y = +p[0],
        m = +p[1];
      var first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      var count = new Date(Date.UTC(y, m, 0)).getUTCDate();
      grid.textContent = "";
      var active = 0,
        span = 0,
        i;
      for (i = 0; i < first; i++) grid.appendChild(mk("div", "cal-pad"));
      for (i = 1; i <= count; i++) {
        var date = month + "-" + pad(i),
          info = days[date],
          st = statusOf(date, info, o),
          cell;
        if (st === "off") {
          cell = mk("div", "cal-day off", String(i));
        } else {
          span++;
          if (info && info.build > 0) active++;
          cell = mk("button", "cal-day " + st, String(i));
          cell.type = "button";
          cell.setAttribute(
            "aria-label",
            i +
              " " +
              MONTHS[m - 1] +
              " " +
              y +
              ": " +
              WORDS[st].toLowerCase() +
              (info && info.build
                ? ", " + info.build + " of " + o.goal + " minutes"
                : ""),
          );
          cell.onclick = (function (d, inf, s, c) {
            return function () {
              openDay(d, inf, s, c);
            };
          })(date, info, st, cell);
        }
        if (date === o.today) cell.classList.add("today");
        grid.appendChild(cell);
      }
      sub.textContent = span ? "Active days: " + active + " of " + span : "";
      grid.classList.remove("slide-next", "slide-prev");
      void grid.offsetWidth;
      if (dir) grid.classList.add(dir > 0 ? "slide-next" : "slide-prev");
    }

    function show(key, dir) {
      month = key;
      var t = ++token;
      drawHeader();
      Promise.resolve(o.getMonth(key)).then(
        function (d) {
          if (t === token) {
            days = d || {};
            drawGrid(dir);
          }
        },
        function () {
          if (t === token) {
            grid.textContent = "";
            sub.textContent = "Couldn’t load this month.";
          }
        },
      );
    }
    prev.onclick = function () {
      if (month > minM) show(shift(month, -1), -1);
    };
    next.onclick = function () {
      if (month < maxM) show(shift(month, 1), 1);
    };
    show(month, 0);
    return {
      setMonth: function (k) {
        if (k >= minM && k <= maxM) show(k, k > month ? 1 : -1);
      },
    };
  }

  window.Calendar = { mount: mount, statusOf: statusOf };
})();
