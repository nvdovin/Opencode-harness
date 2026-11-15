#!/usr/bin/env python3
"""Сбор UI/UX-метрик и скриншотов для ui-design-reviewer.

Скрипт ничего не решает за агента: он собирает факты.
- статический скан CSS/HTML/JS;
- скриншоты страниц на нескольких viewport;
- DOM-метрики: overflow, overlap, симметрия, сетка, плотность,
  типографика, контролы, focus, console errors, битые изображения;
- JSON-отчёт и index.html со ссылками на скриншоты.

Запуск:
  python3 ~/.config/opencode/scripts/design_audit.py \
    --config staff/design-audit.json \
    --sprint 3 \
    --out staff/design-review/sprint-3
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DEFAULT_VIEWPORTS = [
    {"name": "mobile", "width": 375, "height": 812},
    {"name": "tablet", "width": 768, "height": 1024},
    {"name": "desktop", "width": 1440, "height": 900},
]

DEFAULT_THRESHOLDS = {
    "min_touch": 44,
    "min_text_measure": 45,
    "max_text_measure": 75,
    "max_distinct_colors": 12,
    "max_font_families": 2,
    "max_font_weights": 3,
    "max_shadows": 3,
    "max_gradients": 1,
    "container_tolerance": 2,
    "overlap_tolerance": 2,
    "spacing_scale": [4, 8, 12, 16, 24, 32, 48, 64, 96],
}

DEFAULT_TOKENS = [
    "--color-bg",
    "--color-surface",
    "--color-text",
    "--color-muted",
    "--color-border",
    "--color-accent",
    "--color-accent-contrast",
    "--color-danger",
    "--color-success",
    "--color-focus",
]

METRICS_JS = r"""
(cfg) => {
  const thresholds = cfg.thresholds || {};
  const tokenNames = cfg.tokenNames || [];
  const tol = Number(thresholds.overlap_tolerance || 2);
  const containerTol = Number(thresholds.container_tolerance || 2);
  const spacingScale = new Set((thresholds.spacing_scale || [4,8,12,16,24,32,48,64,96]).map(Number));

  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(r.right), bottom: Math.round(r.bottom)
    };
  };
  const cls = (el) => {
    const raw = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
    return raw.trim().replace(/\s+/g, " ").slice(0, 120);
  };
  const text = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 100);
  const q = (sel) => [...document.querySelectorAll(sel)];
  const root = document.documentElement;

  const interactive = q("a[href], button, input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])")
    .filter(visible).slice(0, 220);
  const overlaps = [];
  for (let i = 0; i < interactive.length; i++) {
    for (let j = i + 1; j < interactive.length; j++) {
      const a = interactive[i], b = interactive[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const y = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      if (x > tol && y > tol && x * y > 8) {
        overlaps.push({
          a: {tag: a.tagName, cls: cls(a), text: text(a), ...rect(a)},
          b: {tag: b.tagName, cls: cls(b), text: text(b), ...rect(b)},
          area: Math.round(x * y)
        });
        if (overlaps.length >= 30) break;
      }
    }
    if (overlaps.length >= 30) break;
  }

  const controls = q("button, a, input, select, textarea, [role='button']").filter(visible).slice(0, 250);
  const controlInfo = controls.map((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName, type: el.getAttribute("type") || "", cls: cls(el), text: text(el),
      w: Math.round(r.width), h: Math.round(r.height),
      appearance: s.appearance || s.webkitAppearance || "",
      opacity: s.opacity, borderRadius: s.borderRadius,
      background: s.backgroundColor, color: s.color, border: s.border,
      fontFamily: s.fontFamily, fontSize: s.fontSize, padding: s.padding,
      boxShadow: s.boxShadow
    };
  });
  const noClassControls = controlInfo.filter((c) => !c.cls && c.tag !== "A");
  const nativeSelects = controlInfo.filter((c) => c.tag === "SELECT" && (c.appearance === "auto" || c.appearance === "menulist"));
  const fileInputs = controlInfo.filter((c) => c.tag === "INPUT" && c.type === "file");
  const smallTargets = controlInfo.filter((c) => {
    if (c.tag === "A" && !/(^|\s)(btn|button|cta)(\s|$)/i.test(c.cls)) return false;
    if (!["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(c.tag)) return false;
    return c.w < Number(thresholds.min_touch || 44) || c.h < Number(thresholds.min_touch || 44);
  });

  const containers = q("main, .container, .content, .page, article").filter(visible).slice(0, 20).map((el) => {
    const r = rect(el);
    return {tag: el.tagName, cls: cls(el), ...r, left: r.x, right: Math.round(window.innerWidth - r.right), diff: Math.round(Math.abs(r.x - (window.innerWidth - r.right)))};
  });

  const cards = q(".card, article").filter(visible)
    .filter((el) => !el.parentElement || !el.parentElement.closest(".card, article"))
    .slice(0, 160).map((el) => ({tag: el.tagName, cls: cls(el), ...rect(el), text: text(el)}));
  const sortedCards = [...cards].sort((a, b) => a.y - b.y);
  const rows = [];
  for (const card of sortedCards) {
    let row = rows.find((r) => Math.abs(r[0].y - card.y) <= 4);
    if (!row) { row = []; rows.push(row); }
    row.push(card);
  }
  const gridRows = rows.filter((r) => r.length > 1).map((r) => {
    const widths = r.map((c) => c.w);
    const heights = r.map((c) => c.h);
    const gaps = [];
    for (let i = 1; i < r.length; i++) gaps.push(r[i].x - (r[i-1].x + r[i-1].w));
    return {
      count: r.length,
      widths,
      heights,
      gaps,
      widthVariance: Math.max(...widths) - Math.min(...widths),
      heightVariance: Math.max(...heights) - Math.min(...heights),
      gapVariance: gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0
    };
  });

  const spacingOutliers = [];
  const spacingEls = q("section, .card, [class*='card'], article, header, footer, main, .container").filter(visible).slice(0, 200);
  for (const el of spacingEls) {
    const s = getComputedStyle(el);
    for (const prop of ["paddingTop","paddingRight","paddingBottom","paddingLeft","marginTop","marginRight","marginBottom","marginLeft","rowGap","columnGap"]) {
      const v = parseFloat(s[prop]);
      if (!Number.isNaN(v) && v > 0 && !spacingScale.has(Math.round(v))) {
        spacingOutliers.push({tag: el.tagName, cls: cls(el), prop, value: Math.round(v)});
        if (spacingOutliers.length >= 60) break;
      }
    }
    if (spacingOutliers.length >= 60) break;
  }

  const typographyEls = q("h1, h2, h3, h4, p, li, button, a").filter(visible).slice(0, 300);
  const fontSizes = [...new Set(typographyEls.map((el) => getComputedStyle(el).fontSize))].sort();
  const fontFamilies = [...new Set(typographyEls.map((el) => getComputedStyle(el).fontFamily))].sort();
  const fontWeights = [...new Set(typographyEls.map((el) => getComputedStyle(el).fontWeight))].sort();
  const textBlocks = q("p, li").filter(visible).slice(0, 160).map((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const fs = parseFloat(s.fontSize) || 16;
    return {tag: el.tagName, cls: cls(el), fontSize: s.fontSize, lineHeight: s.lineHeight, approxCh: Math.round(r.width / (fs * 0.5)), width: Math.round(r.width)};
  });
  const longText = textBlocks.filter((t) => t.approxCh > Number(thresholds.max_text_measure || 75));
  const narrowText = textBlocks.filter((t) => t.approxCh > 0 && t.approxCh < Number(thresholds.min_text_measure || 45));

  const colors = new Set();
  const backgrounds = new Set();
  const borders = new Set();
  const shadows = new Set();
  let gradients = 0;
  const colorEls = q("body, header, footer, main, section, article, .card, button, a, input, select, textarea").filter(visible).slice(0, 400);
  for (const el of colorEls) {
    const s = getComputedStyle(el);
    for (const prop of ["color", "backgroundColor", "borderTopColor", "borderBottomColor"]) {
      const v = s[prop];
      if (v && v !== "rgba(0, 0, 0, 0)" && v !== "transparent") {
        colors.add(v);
        if (prop === "backgroundColor") backgrounds.add(v);
        if (prop.startsWith("border")) borders.add(v);
      }
    }
    if (s.backgroundImage && s.backgroundImage.includes("gradient")) gradients++;
    if (s.boxShadow && s.boxShadow !== "none") shadows.add(s.boxShadow);
  }

  const tokenValues = {};
  const rootStyle = getComputedStyle(root);
  for (const name of tokenNames) tokenValues[name] = rootStyle.getPropertyValue(name).trim();

  const brokenImages = q("img").filter(visible).filter((img) => !img.complete || img.naturalWidth === 0).map((img) => ({src: img.currentSrc || img.src, alt: img.alt || ""}));
  const deadLinks = q("a[href='#']").filter(visible).filter((a) => !a.dataset || Object.keys(a.dataset).length === 0).slice(0, 20).map((a) => ({text: text(a)}));

  return {
    url: location.href,
    viewport: {width: window.innerWidth, height: window.innerHeight},
    scroll: {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      bodyScrollWidth: document.body ? document.body.scrollWidth : null,
      overflowX: root.scrollWidth > root.clientWidth + 1
    },
    containers,
    cards: cards.slice(0, 80),
    gridRows,
    overlaps,
    controls: controlInfo.slice(0, 120),
    noClassControls: noClassControls.slice(0, 40),
    nativeSelects: nativeSelects.slice(0, 20),
    fileInputs: fileInputs.slice(0, 20),
    smallTargets: smallTargets.slice(0, 40),
    spacingOutliers,
    typography: {
      fontSizes, fontFamilies, fontWeights,
      bodyFontSize: getComputedStyle(document.body).fontSize,
      bodyLineHeight: getComputedStyle(document.body).lineHeight
    },
    textBlocks: textBlocks.slice(0, 80),
    longText: longText.slice(0, 30),
    narrowText: narrowText.slice(0, 30),
    colors: {
      distinct: colors.size,
      backgrounds: [...backgrounds],
      borders: [...borders],
      shadows: [...shadows],
      gradients,
      samples: [...colors].slice(0, 40)
    },
    tokens: tokenValues,
    brokenImages: brokenImages.slice(0, 30),
    deadLinks,
    images: q("img").filter(visible).length,
    buttons: q("button").filter(visible).length,
    links: q("a[href]").filter(visible).length
  };
}
"""

FOCUS_JS = r"""
() => {
  const el = document.activeElement;
  if (!el) return null;
  const s = getComputedStyle(el);
  const raw = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
  return {
    tag: el.tagName,
    cls: raw.trim().slice(0, 100),
    text: (el.innerText || el.value || "").trim().slice(0, 60),
    outlineStyle: s.outlineStyle,
    outlineWidth: s.outlineWidth,
    boxShadow: s.boxShadow,
    visible: s.display !== "none" && s.visibility !== "hidden"
  };
}
"""


def load_config(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"ERROR: нет {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ERROR: {path}: невалидный JSON: {exc}")
    if not isinstance(data, dict):
        raise SystemExit(f"ERROR: {path}: ожидается объект")
    return data


def safe_name(value: str) -> str:
    value = urlparse(value).path if "://" in value else value
    value = value.strip("/").replace("/", "-").replace("?", "-").replace("=", "-")
    value = re.sub(r"[^0-9A-Za-zА-Яа-я_.-]+", "-", value).strip("-")
    return value[:80] or "root"


def static_scan(root: Path, config: dict[str, Any]) -> dict[str, Any]:
    scan = config.get("static_scan") or {}
    result: dict[str, Any] = {
        "css_files": 0,
        "html_files": 0,
        "js_files": 0,
        "raw_hex_outside_root": [],
        "inline_color_styles": [],
        "unclassed_controls": [],
        "important_count": 0,
        "font_family_declarations": 0,
        "token_declarations": [],
        "appearance_none": 0,
        "z_index_values": [],
        "js_alert_count": 0,
    }

    css_patterns = scan.get("css") or ["static/css/**/*.css"]
    html_patterns = scan.get("html") or ["templates/**/*.html"]
    js_patterns = scan.get("js") or ["static/js/**/*.js"]

    for pattern in css_patterns:
        for path in sorted(root.glob(pattern)):
            if not path.is_file():
                continue
            result["css_files"] += 1
            text = path.read_text(encoding="utf-8", errors="replace")
            without_root = re.sub(r":root\s*\{[^}]*\}", "", text, flags=re.S)
            for match in re.finditer(r"#[0-9a-fA-F]{3,8}\b", without_root):
                line = without_root[: match.start()].count("\n") + 1
                result["raw_hex_outside_root"].append(
                    {"file": str(path.relative_to(root)), "line": line, "value": match.group(0)}
                )
            result["important_count"] += text.count("!important")
            result["font_family_declarations"] += len(re.findall(r"font-family\s*:", text, flags=re.I))
            result["appearance_none"] += len(re.findall(r"appearance\s*:\s*none", text, flags=re.I))
            result["token_declarations"].extend(re.findall(r"(--[a-zA-Z0-9-]+)\s*:", text))
            result["z_index_values"].extend(re.findall(r"z-index\s*:\s*([^;}\n]+)", text, flags=re.I))
        if len(result["raw_hex_outside_root"]) > 200:
            result["raw_hex_outside_root"] = result["raw_hex_outside_root"][:200]
            break

    for pattern in html_patterns:
        for path in sorted(root.glob(pattern)):
            if not path.is_file():
                continue
            result["html_files"] += 1
            text = path.read_text(encoding="utf-8", errors="replace")
            for match in re.finditer(r"style\s*=\s*[\"'][^\"']*(?:color|background|border)[^\"']*[\"']", text, flags=re.I | re.S):
                line = text[: match.start()].count("\n") + 1
                result["inline_color_styles"].append(
                    {"file": str(path.relative_to(root)), "line": line, "snippet": match.group(0)[:120]}
                )
            for tag in ("button", "select", "textarea"):
                for match in re.finditer(rf"<{tag}\b(?:(?!>).)*>", text, flags=re.I | re.S):
                    snippet = match.group(0)
                    if "class=" not in snippet and "hidden" not in snippet:
                        line = text[: match.start()].count("\n") + 1
                        result["unclassed_controls"].append(
                            {"file": str(path.relative_to(root)), "line": line, "tag": tag, "snippet": snippet[:120]}
                        )
            for match in re.finditer(r"<input\b(?:(?!>).)*>", text, flags=re.I | re.S):
                snippet = match.group(0)
                if "class=" in snippet or re.search(r"type\s*=\s*['\"]hidden['\"]", snippet, flags=re.I):
                    continue
                line = text[: match.start()].count("\n") + 1
                result["unclassed_controls"].append(
                    {"file": str(path.relative_to(root)), "line": line, "tag": "input", "snippet": snippet[:120]}
                )

    for pattern in js_patterns:
        for path in sorted(root.glob(pattern)):
            if not path.is_file():
                continue
            result["js_files"] += 1
            text = path.read_text(encoding="utf-8", errors="replace")
            result["js_alert_count"] += len(re.findall(r"\balert\s*\(", text))

    result["token_declarations"] = sorted(set(result["token_declarations"]))
    result["z_index_values"] = sorted(set(result["z_index_values"]))[:40]
    result["raw_hex_outside_root"] = result["raw_hex_outside_root"][:100]
    result["inline_color_styles"] = result["inline_color_styles"][:100]
    result["unclassed_controls"] = result["unclassed_controls"][:100]
    return result


def login(page: Any, base_url: str, auth: dict[str, Any], timeout: int = 20000) -> tuple[bool, str]:
    if not auth:
        return True, "guest"
    login_url = auth.get("login_url")
    phone = auth.get("phone")
    password = auth.get("password")
    if not (login_url and phone and password):
        return False, "auth: не заданы login_url/phone/password"
    page.goto(base_url.rstrip("/") + login_url, wait_until="domcontentloaded", timeout=timeout)
    try:
        page.fill(auth.get("phone_selector", "input[name='phone_number']"), str(phone))
        page.fill(auth.get("password_selector", "input[name='password']"), str(password))
        page.click(auth.get("submit_selector", "button[type='submit']"))
        page.wait_for_load_state("networkidle", timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - логируем и продолжаем
        return False, f"auth: {type(exc).__name__}: {exc}"
    if login_url and login_url in urlparse(page.url).path:
        return False, f"auth: остались на {page.url}"
    return True, "ok"


def run_browser(root: Path, config: dict[str, Any], out_dir: Path, args: argparse.Namespace) -> dict[str, Any]:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "error": f"playwright недоступен: {type(exc).__name__}: {exc}"}

    base_url = args.base_url or config.get("base_url") or "http://localhost:8000"
    viewports = config.get("viewports") or DEFAULT_VIEWPORTS
    routes = config.get("routes") or [{"path": "/", "name": "home", "auth": "guest"}]
    auth_map = config.get("auth") or {}
    thresholds = {**DEFAULT_THRESHOLDS, **(config.get("thresholds") or {})}
    token_names = config.get("token_names") or DEFAULT_TOKENS
    timeout = int(config.get("timeout_ms", 30000))

    pages: list[dict[str, Any]] = []
    warnings: list[str] = []
    blockers: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        roles = sorted({str(route.get("auth", "guest")) for route in routes})
        for role in roles:
            auth = auth_map.get(role) or {}
            storage_state = auth.get("storage_state")
            context_kwargs: dict[str, Any] = {"locale": "ru-RU"}
            if storage_state:
                context_kwargs["storage_state"] = str((root / storage_state).resolve())
            context = browser.new_context(**context_kwargs)
            page = context.new_page()
            console_errors: list[str] = []
            page_errors: list[str] = []
            failed_requests: list[str] = []

            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.on(
                "requestfailed",
                lambda req: failed_requests.append(req.url)
                if req.url.startswith(base_url)
                else None,
            )

            ok, auth_message = (True, "guest") if role == "guest" else login(page, base_url, auth, timeout)
            if not ok:
                warnings.append(f"{role}: {auth_message}; маршруты этой роли пропущены")
                context.close()
                continue

            for viewport in viewports:
                width = int(viewport.get("width", 1440))
                height = int(viewport.get("height", 900))
                vp_name = str(viewport.get("name") or f"{width}x{height}")
                page.set_viewport_size({"width": width, "height": height})
                for route in routes:
                    if str(route.get("auth", "guest")) != role:
                        continue
                    path = str(route.get("path", "/"))
                    name = str(route.get("name") or path)
                    url = base_url.rstrip("/") + path
                    console_errors.clear()
                    page_errors.clear()
                    failed_requests.clear()
                    try:
                        page.goto(url, wait_until="networkidle", timeout=timeout)
                        wait_for = route.get("wait_for")
                        if wait_for:
                            page.wait_for_selector(str(wait_for), timeout=timeout)
                    except Exception as exc:  # noqa: BLE001
                        warnings.append(f"{role}/{name}/{vp_name}: {type(exc).__name__}: {exc}")
                        continue

                    screenshot_name = f"{safe_name(role)}-{safe_name(name)}-{safe_name(vp_name)}.png"
                    screenshot_path = out_dir / screenshot_name
                    try:
                        page.screenshot(path=str(screenshot_path), full_page=True)
                    except Exception as exc:  # noqa: BLE001
                        warnings.append(f"{role}/{name}/{vp_name}: screenshot: {type(exc).__name__}: {exc}")
                        screenshot_name = ""

                    try:
                        metrics = page.evaluate(METRICS_JS, {"thresholds": thresholds, "tokenNames": token_names})
                    except Exception as exc:  # noqa: BLE001
                        warnings.append(f"{role}/{name}/{vp_name}: metrics: {type(exc).__name__}: {exc}")
                        metrics = {}

                    focus: list[dict[str, Any]] = []
                    try:
                        for _ in range(30):
                            page.keyboard.press("Tab")
                            info = page.evaluate(FOCUS_JS)
                            if info:
                                focus.append(info)
                    except Exception as exc:  # noqa: BLE001
                        warnings.append(f"{role}/{name}/{vp_name}: focus: {type(exc).__name__}: {exc}")

                    missing_focus = [
                        item for item in focus
                        if item.get("outlineStyle") == "none" and item.get("boxShadow") == "none"
                    ]
                    scroll = metrics.get("scroll") or {}
                    if scroll.get("overflowX"):
                        blockers.append(f"{role}/{name}/{vp_name}: горизонтальный скролл {scroll.get('scrollWidth')}>{scroll.get('clientWidth')}")
                    if metrics.get("overlaps"):
                        warnings.append(f"{role}/{name}/{vp_name}: пересечения интерактивных элементов: {len(metrics['overlaps'])}")
                    if metrics.get("nativeSelects"):
                        warnings.append(f"{role}/{name}/{vp_name}: нативные select: {len(metrics['nativeSelects'])}")
                    if metrics.get("noClassControls"):
                        warnings.append(f"{role}/{name}/{vp_name}: контролы без классов: {len(metrics['noClassControls'])}")
                    if metrics.get("fileInputs"):
                        warnings.append(f"{role}/{name}/{vp_name}: file input без обёртки/класса: {len(metrics['fileInputs'])}")
                    if metrics.get("smallTargets"):
                        warnings.append(f"{role}/{name}/{vp_name}: маленькие touch targets: {len(metrics['smallTargets'])}")
                    if metrics.get("longText"):
                        warnings.append(f"{role}/{name}/{vp_name}: текст шире меры: {len(metrics['longText'])}")
                    if metrics.get("brokenImages"):
                        warnings.append(f"{role}/{name}/{vp_name}: битые изображения: {len(metrics['brokenImages'])}")
                    if metrics.get("deadLinks"):
                        warnings.append(f"{role}/{name}/{vp_name}: ссылки href=# без data-хука: {len(metrics['deadLinks'])}")
                    if metrics.get("colors", {}).get("gradients", 0) > int(thresholds["max_gradients"]):
                        warnings.append(f"{role}/{name}/{vp_name}: градиентов больше бюджета")
                    if metrics.get("colors", {}).get("distinct", 0) > int(thresholds["max_distinct_colors"]):
                        warnings.append(f"{role}/{name}/{vp_name}: цветов больше бюджета")
                    if len(metrics.get("typography", {}).get("fontFamilies", [])) > int(thresholds["max_font_families"]):
                        warnings.append(f"{role}/{name}/{vp_name}: семейств шрифтов больше бюджета")
                    if missing_focus:
                        warnings.append(f"{role}/{name}/{vp_name}: focus без видимого outline/box-shadow: {len(missing_focus)}")
                    if console_errors:
                        warnings.append(f"{role}/{name}/{vp_name}: console errors: {len(console_errors)}")
                    if page_errors:
                        warnings.append(f"{role}/{name}/{vp_name}: page errors: {len(page_errors)}")
                    if failed_requests:
                        warnings.append(f"{role}/{name}/{vp_name}: failed requests: {len(failed_requests)}")

                    pages.append(
                        {
                            "role": role,
                            "route": path,
                            "name": name,
                            "viewport": vp_name,
                            "screenshot": screenshot_name,
                            "metrics": metrics,
                            "focus": focus,
                            "missing_focus": missing_focus,
                            "console_errors": list(console_errors),
                            "page_errors": list(page_errors),
                            "failed_requests": list(failed_requests),
                        }
                    )
            context.close()
        browser.close()

    # Потолок по объёму JSON.
    for page_data in pages:
        metrics = page_data.get("metrics") or {}
        for key in ("controls", "cards", "textBlocks", "longText", "narrowText", "spacingOutliers"):
            if isinstance(metrics.get(key), list):
                metrics[key] = metrics[key][:60]
        if isinstance(metrics.get("overlaps"), list):
            metrics["overlaps"] = metrics["overlaps"][:30]

    return {"available": True, "pages": pages, "warnings": warnings, "blockers": blockers}


def write_index(out_dir: Path, report: dict[str, Any]) -> None:
    rows = []
    for page in report.get("pages", []):
        shot = page.get("screenshot") or ""
        metrics = page.get("metrics") or {}
        scroll = metrics.get("scroll") or {}
        rows.append(
            "<tr>"
            f"<td>{page.get('role')}</td>"
            f"<td>{page.get('name')}</td>"
            f"<td>{page.get('viewport')}</td>"
            f"<td>{scroll.get('scrollWidth')}/{scroll.get('clientWidth')}</td>"
            f"<td>{len(metrics.get('overlaps') or [])}</td>"
            f"<td>{len(metrics.get('nativeSelects') or [])}</td>"
            f"<td>{len(metrics.get('noClassControls') or [])}</td>"
            f"<td><a href='{shot}'>{shot}</a></td>"
            "</tr>"
        )
    html = """<!doctype html>
<html lang="ru"><meta charset="utf-8">
<title>Design audit</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;line-height:1.5}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid;padding:6px 8px;text-align:left;font-size:14px}
th{font-weight:700}
</style>
<h1>Design audit</h1>
<p>Скриншоты и метрики. Решение PASS/FAIL принимает ui-design-reviewer.</p>
<table>
<thead><tr><th>Роль</th><th>Страница</th><th>Viewport</th><th>scrollWidth/clientWidth</th><th>overlaps</th><th>native select</th><th>без класса</th><th>Скриншот</th></tr></thead>
<tbody>
""" + "".join(rows) + """
</tbody></table>
</html>
"""
    (out_dir / "index.html").write_text(html, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="UI/UX-аудит: скриншоты и DOM-метрики")
    parser.add_argument("--config", default="staff/design-audit.json")
    parser.add_argument("--sprint", type=int, default=None)
    parser.add_argument("--out", default=None)
    parser.add_argument("--root", default=".")
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--fail-on-blockers", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = root / config_path
    config = load_config(config_path)

    out_dir = Path(args.out) if args.out else root / "staff" / "design-review" / (
        f"sprint-{args.sprint}" if args.sprint else "latest"
    )
    if not out_dir.is_absolute():
        out_dir = root / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    static = static_scan(root, config)
    browser = run_browser(root, config, out_dir, args)

    report = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "root": str(root),
            "config": str(config_path),
            "sprint": args.sprint,
            "base_url": args.base_url or config.get("base_url"),
        },
        "static": static,
        "browser": browser,
        "summary": {
            "pages": len(browser.get("pages", [])) if browser.get("available") else 0,
            "blockers": browser.get("blockers", []) if browser.get("available") else [],
            "warnings": (
                (["playwright: " + str(browser.get("error"))] if not browser.get("available") else [])
                + (browser.get("warnings", []) if browser.get("available") else [])
                + (
                    [f"static: raw hex outside :root: {len(static['raw_hex_outside_root'])}"]
                    if static.get("raw_hex_outside_root") else []
                )
                + (
                    [f"static: inline color styles: {len(static['inline_color_styles'])}"]
                    if static.get("inline_color_styles") else []
                )
                + (
                    [f"static: unclassed controls: {len(static['unclassed_controls'])}"]
                    if static.get("unclassed_controls") else []
                )
            ),
        },
    }

    metrics_path = out_dir / "metrics.json"
    metrics_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_index(out_dir, report)

    if args.json:
        print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    else:
        print(f"DESIGN AUDIT: {out_dir}")
        print(f"REPORT: {metrics_path}")
        print(f"PAGES: {report['summary']['pages']}")
        print(f"BLOCKERS: {len(report['summary']['blockers'])}")
        for item in report["summary"]["blockers"][:20]:
            print(f"  BLOCKER {item}")
        print(f"WARNINGS: {len(report['summary']['warnings'])}")
        for item in report["summary"]["warnings"][:30]:
            print(f"  WARN {item}")
        print("SCREENSHOTS:")
        for page in report["browser"].get("pages", [])[:60]:
            if page.get("screenshot"):
                print(f"  {page['role']}/{page['name']}/{page['viewport']}: {page['screenshot']}")

    if args.fail_on_blockers and report["summary"]["blockers"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
