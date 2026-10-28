// Hamburger menu for Lambert pages. Load AFTER the supabase script and /api/config:
//   <script src="/nav.js"></script>
// It attaches to the page's `header .logo`, so pages without one are untouched.
// The Admin link only appears for admins. The admin page enforces access itself;
// hiding the link is a convenience, not security.
(function () {
  var C = window.LAMBERT || {};

  var LINKS = [
    { href: "/app.html", label: "Dashboard" },
    { href: "/coach.html", label: "Coach" },
    { href: "/settings.html", label: "Settings" },
    { href: "/admin.html", label: "Admin", admin: true },
  ];

  var css =
    ".logo{display:flex;align-items:center;gap:12px}" +
    "[hidden]{display:none!important}" +
    ".lnav-btn{display:inline-flex;flex-direction:column;justify-content:center;gap:4px;width:38px;height:38px;padding:0 9px;border-radius:10px;border:1px solid #1b2640;background:#0f1729;cursor:pointer}" +
    ".lnav-btn span{display:block;height:2px;background:#e8edf7;border-radius:2px}" +
    ".lnav-btn:focus-visible,.lnav-panel a:focus-visible,.lnav-out:focus-visible{outline:2px solid #f59e0b;outline-offset:2px}" +
    ".lnav-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);opacity:0;pointer-events:none;transition:opacity .2s;z-index:90}" +
    ".lnav-overlay.open{opacity:1;pointer-events:auto}" +
    ".lnav-panel{position:fixed;top:0;left:0;bottom:0;width:min(290px,84vw);background:#0f1729;border-right:1px solid #1b2640;transform:translateX(-100%);transition:transform .22s ease;z-index:100;padding:22px 14px;display:flex;flex-direction:column;gap:4px;font-family:Inter,system-ui,sans-serif}" +
    ".lnav-panel.open{transform:none}" +
    ".lnav-title{font-weight:800;letter-spacing:3px;font-size:.8rem;color:#e8edf7;padding:0 10px 18px}" +
    ".lnav-title i{color:#f59e0b;font-style:normal}" +
    ".lnav-panel a,.lnav-out{display:block;width:100%;text-align:left;text-decoration:none;color:#e8edf7;font:600 .92rem Inter,system-ui,sans-serif;padding:12px 10px;border-radius:10px;border:0;background:none;cursor:pointer}" +
    ".lnav-panel a:hover,.lnav-out:hover{background:#16213a}" +
    ".lnav-panel a.on{background:rgba(245,158,11,.12);color:#f59e0b}" +
    ".lnav-out{margin-top:auto;color:#8693ad;border-top:1px solid #1b2640;border-radius:0;padding-top:16px}";

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function init() {
    var logo = document.querySelector("header .logo");
    if (!logo) return;

    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    var btn = el("button", "lnav-btn");
    btn.type = "button";
    btn.setAttribute("aria-label", "Open menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "lnav-panel");
    for (var i = 0; i < 3; i++) btn.appendChild(document.createElement("span"));
    logo.insertBefore(btn, logo.firstChild);

    var overlay = el("div", "lnav-overlay");
    var panel = el("nav", "lnav-panel");
    panel.id = "lnav-panel";
    panel.setAttribute("aria-label", "Main menu");

    var title = el("div", "lnav-title", "LAMBERT");
    title.appendChild(el("i", "", "."));
    panel.appendChild(title);

    var here = location.pathname.replace(/\/$/, "") || "/";
    var adminLinks = [];
    var first = null;
    LINKS.forEach(function (l) {
      var a = el("a", here === l.href ? "on" : "", l.label);
      a.href = l.href;
      if (l.admin) {
        a.hidden = true;
        adminLinks.push(a);
      } else if (!first) {
        first = a;
      }
      panel.appendChild(a);
    });

    var out = el("button", "lnav-out", "Sign out");
    out.type = "button";
    panel.appendChild(out);

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    function setOpen(open) {
      panel.classList.toggle("open", open);
      overlay.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      if (open && first) first.focus();
      if (!open) btn.focus();
    }
    btn.onclick = function () {
      setOpen(!panel.classList.contains("open"));
    };
    overlay.onclick = function () {
      setOpen(false);
    };
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("open"))
        setOpen(false);
    });

    // Read-only client: shares the page's stored session but never refreshes tokens.
    var sb = null;
    if (window.supabase && C.SUPABASE_URL && C.SUPABASE_ANON_KEY) {
      sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false },
      });
    }

    out.onclick = async function () {
      try {
        if (sb) await sb.auth.signOut();
      } catch (e) {}
      location.href = "/login.html";
    };

    if (sb) {
      sb.auth
        .getSession()
        .then(function (r) {
          var s = r.data && r.data.session;
          if (!s) return;
          return sb
            .from("user_access")
            .select("is_admin")
            .eq("user_id", s.user.id)
            .maybeSingle()
            .then(function (a) {
              if (a.data && a.data.is_admin)
                adminLinks.forEach(function (x) {
                  x.hidden = false;
                });
            });
        })
        .catch(function () {});
    }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
