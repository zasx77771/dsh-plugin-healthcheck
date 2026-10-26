/**
 * dsh-plugin-healthcheck client half — hand-written factory-CJS bundle for
 * DSH 0.2.1+ (no build step, no JSX, no host internals).
 *
 * Registers one slot contribution: `settings.section` → the 「插件检测」 page.
 * It lists the host inventory and can start a run, then polls its status.
 *
 * Constraints learned the hard way:
 *   - the factory must stay synchronous (no top-level await), otherwise the
 *     module stays `loading` and the whole web boot is judged failed;
 *   - `apply` must never throw — a broken registration takes the settings page
 *     down with it;
 *   - no `react/jsx-runtime` require; build elements with React.createElement.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-healthcheck",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var NS = "dsh-plugin-healthcheck";
    var API = "/healthcheck";

    var LAYERS = [
      { id: "l0", label: "静态检查 L0" },
      { id: "l1", label: "配置检查 L1" },
      { id: "malware", label: "恶意扫描" },
      { id: "l2", label: "隔离试跑 L2" },
    ];

    // ── transport ────────────────────────────────────────────────────────────

    function describeFailure(body, status) {
      if (body && body.error && typeof body.error.message === "string") return body.error.message;
      if (body && typeof body.message === "string") return body.message;
      return "HTTP " + status;
    }

    async function request(path, init) {
      var response;
      try {
        response = await fetch(API + path, init);
      } catch (error) {
        return { ok: false, error: "路由不可达：" + String((error && error.message) || error) };
      }
      var body;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: "响应不是 JSON（HTTP " + response.status + "）" };
      }
      if (body && body.ok === true) return { ok: true, value: body.value };
      return { ok: false, error: describeFailure(body, response.status) };
    }

    function getJson(path) {
      return request(path, { headers: { accept: "application/json" } });
    }

    function postJson(path, payload) {
      return request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    // ── styles ───────────────────────────────────────────────────────────────

    var ui = {
      root: { display: "flex", flexDirection: "column", gap: "12px", fontSize: "13px" },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      hint: { opacity: 0.7, fontSize: "12px" },
      button: {
        padding: "5px 10px",
        borderRadius: "6px",
        border: "1px solid rgba(127,127,127,0.35)",
        background: "transparent",
        cursor: "pointer",
        fontSize: "12px",
        color: "inherit",
      },
      card: {
        border: "1px solid rgba(127,127,127,0.25)",
        borderRadius: "8px",
        padding: "10px",
        maxHeight: "360px",
        overflowY: "auto",
      },
      finding: {
        display: "flex",
        gap: "8px",
        padding: "4px 0",
        borderBottom: "1px solid rgba(127,127,127,0.12)",
      },
      badge: { fontSize: "11px", padding: "1px 6px", borderRadius: "999px", whiteSpace: "nowrap" },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", opacity: 0.75 },
      error: { color: "#d9534f", whiteSpace: "pre-wrap" },
    };

    function badgeStyle(severity) {
      var palette =
        severity === "error"
          ? { background: "rgba(217,83,79,0.16)", color: "#d9534f" }
          : { background: "rgba(240,173,78,0.18)", color: "#b8860b" };
      return Object.assign({}, ui.badge, palette);
    }

    // ── page ─────────────────────────────────────────────────────────────────

    function pickT(props) {
      if (typeof props.t === "function") return props.t;
      if (typeof props.fallbackT === "function") return props.fallbackT;
      return function (key) {
        return key;
      };
    }

    function HealthcheckSection(props) {
      var t = pickT(props);
      var inventoryState = React.useState({ status: "loading" });
      var inventory = inventoryState[0];
      var setInventory = inventoryState[1];
      var runState = React.useState(null);
      var run = runState[0];
      var setRun = runState[1];
      var runIdState = React.useState(null);
      var runId = runIdState[0];
      var setRunId = runIdState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      function loadInventory() {
        setInventory({ status: "loading" });
        getJson("/inventory").then(function (result) {
          if (result.ok === true) setInventory({ status: "ready", value: result.value || {} });
          else setInventory({ status: "error", error: result.error });
        });
      }

      React.useEffect(function () {
        loadInventory();
      }, []);

      React.useEffect(
        function () {
          if (runId === null) return undefined;
          var stopped = false;
          var timer = setInterval(function () {
            getJson("/status?runId=" + encodeURIComponent(runId)).then(function (result) {
              if (stopped) return;
              if (result.ok !== true) {
                setRun({ status: "error", error: result.error });
                setRunId(null);
                return;
              }
              var value = result.value || {};
              setRun({ status: value.finished === true ? "finished" : "running", value: value });
              if (value.finished === true) setRunId(null);
            });
          }, 900);
          return function () {
            stopped = true;
            clearInterval(timer);
          };
        },
        [runId]
      );

      function startRun(layers) {
        var profile = inventory.status === "ready" && inventory.value ? inventory.value.profileName : undefined;
        setRun({ status: "starting" });
        postJson("/run", { layers: layers, profile: profile }).then(function (result) {
          if (result.ok !== true) {
            setRun({ status: "error", error: result.error });
            return;
          }
          var value = result.value || {};
          setRun({ status: "running", value: { stage: "starting", findings: [], finished: false } });
          setRunId(value.runId || null);
        });
      }

      // 「忽略」= 记入已复核白名单（~/.dsh/storages/healthcheck/allowlist.json），
      // 下次扫描不再出现，但历史记录仍保留原始明细。
      function ignoreFinding(item) {
        var plugin = item && (item.pluginId || item.plugin);
        if (!plugin) return;
        setBusy(true);
        postJson("/allowlist", { plugin: plugin, code: item.code || "*", note: "panel" }).then(function (result) {
          setBusy(false);
          if (result.ok !== true) return;
          var kept = [];
          for (var i = 0; i < findings.length; i += 1) if (findings[i] !== item) kept.push(findings[i]);
          setRun({
            status: "finished",
            value: {
              stage: "done",
              finished: true,
              findings: kept,
              ignored: ((run && run.value && run.value.ignored) || 0) + 1,
            },
          });
        });
      }

      var findings = run && run.value && Array.isArray(run.value.findings) ? run.value.findings : [];
      var errorCount = 0;
      var warnCount = 0;
      for (var index = 0; index < findings.length; index += 1) {
        if (findings[index] && findings[index].severity === "error") errorCount += 1;
        else warnCount += 1;
      }

      var header = null;
      if (inventory.status === "ready") {
        var counts = inventory.value.counts || {};
        header = h(
          "div",
          { style: ui.hint },
          "配置集 " +
            (inventory.value.profileName || "?") +
            " · 已装插件 " +
            (counts.profile === undefined ? "?" : counts.profile) +
            " · 内置 " +
            (counts.builtin === undefined ? "?" : counts.builtin)
        );
      } else if (inventory.status === "loading") {
        header = h("div", { style: ui.hint }, "正在读取插件清单…");
      } else if (inventory.status === "error") {
        header = h("div", { style: ui.error }, "读取清单失败：" + inventory.error);
      }

      var toolbar = h(
        "div",
        { style: ui.row },
        LAYERS.map(function (layer) {
          return h(
            "button",
            {
              key: layer.id,
              style: ui.button,
              disabled: runId !== null,
              onClick: function () {
                startRun([layer.id]);
              },
            },
            layer.label
          );
        }),
        h(
          "button",
          {
            style: ui.button,
            disabled: runId !== null,
            onClick: function () {
              startRun(["l0", "l1", "malware"]);
            },
          },
          "全部检查"
        ),
        h("button", { style: ui.button, onClick: loadInventory }, "刷新清单")
      );

      var progress = null;
      if (run && run.status === "starting") progress = h("div", { style: ui.hint }, "正在启动检测…");
      else if (run && run.status === "error") progress = h("div", { style: ui.error }, "检测失败：" + run.error);
      else if (run && run.status === "running")
        progress = h("div", { style: ui.hint }, "运行中：" + ((run.value && run.value.stage) || "…"));
      else if (run && run.status === "finished")
        progress = h(
          "div",
          { style: ui.hint },
          "完成：" +
            errorCount +
            " 个 error / " +
            warnCount +
            " 个 warn" +
            (run.value && run.value.ignored
              ? " · 另有 " + run.value.ignored + " 条已复核忽略"
              : "") +
            (run.value && run.value.error ? " · " + run.value.error : "")
        );

      var list = null;
      if (findings.length > 0) {
        list = h(
          "div",
          { style: ui.card },
          findings.map(function (item, key) {
            var severity = item && item.severity === "error" ? "error" : "warn";
            var where = (item && (item.pluginId || item.plugin || item.subject)) || "";
            var meta = [where, item && item.code, item && item.layer].filter(Boolean).join(" · ");
            return h(
              "div",
              { key: key, style: ui.finding },
              h("span", { style: badgeStyle(severity) }, severity),
              h(
                "span",
                { style: { flex: "1 1 auto" } },
                h("span", null, (item && item.message) || "(无描述)"),
                meta === "" ? null : h("div", { style: ui.mono }, meta)
              ),
              where
                ? h(
                    "button",
                    {
                      style: ui.button,
                      disabled: busy,
                      title: "确认这条是误报：记入已复核白名单，下次扫描不再出现",
                      onClick: function () {
                        ignoreFinding(item);
                      },
                    },
                    "忽略"
                  )
                : null
            );
          })
        );
      } else if (run && run.status === "finished") {
        list = h("div", { style: ui.hint }, "没有发现问题。");
      }

      var title = t("nav");
      return h(
        "div",
        { style: ui.root },
        h("div", { style: { fontWeight: 600 } }, title === "nav" ? "插件检测" : title),
        header,
        toolbar,
        progress,
        list,
        h("div", { style: ui.hint }, "检测只读取插件代码与配置；修复动作需要单独确认。")
      );
    }

    // ── plugin hooks ─────────────────────────────────────────────────────────

    var inject = ["slots", "locale"];

    function apply(ctx) {
      try {
        var t =
          ctx && ctx.locale && typeof ctx.locale.bind === "function"
            ? ctx.locale.bind(NS)
            : function (key) {
                return key;
              };
        var slots = ctx && typeof ctx.get === "function" ? ctx.get("slots") : undefined;
        if (slots === undefined || typeof slots.inject !== "function") {
          console.info("[healthcheck] client: no slots service, settings page not registered");
          return;
        }
        slots.inject("settings.section", function () {
          return slots.register(
            {
              name: "settings.section",
              id: NS,
              order: 80,
              label: function () {
                return "插件检测";
              },
              inject: function () {
                return { fallbackT: t };
              },
            },
            HealthcheckSection
          );
        });
        console.info("[healthcheck] client: settings page registered");
      } catch (error) {
        console.error("[healthcheck] client apply failed", error);
      }
    }

    exports.apply = apply;
    exports.name = NS;
    exports.inject = inject;
    return module.exports;
  },
});
