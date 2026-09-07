import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus, RotateCcw } from "lucide-react";
import { applyTheme, readStoredTheme, THEMES, type ThemeId } from "../shared/theme";
import {
  applyTypography, CODE_FONT_NAMES, CODE_FONTS, DEFAULT_TYPOGRAPHY, FONT_SIZE_LIMITS,
  fontProblem, normalizeFontName, readStoredTypography, selectedFontName, UI_FONTS,
  type FontKind, type FontSizeKey, type TypographySettings,
} from "../shared/typography";
import type { MessageKey } from "../shared/i18n";
import { useI18n } from "./i18n";

const THEME_LABEL: Record<ThemeId, MessageKey> = {
  white: "settings.themeWhite", paper: "settings.themePaper", dark: "settings.themeDark",
};
const THEME_DESC: Record<ThemeId, MessageKey> = {
  white: "settings.themeWhiteDesc", paper: "settings.themePaperDesc", dark: "settings.themeDarkDesc",
};
const FONT_LABEL: Record<string, MessageKey> = {
  default: "settings.fontDefault", system: "settings.fontSystem", serif: "settings.fontSerif", custom: "settings.fontCustom",
};
const SIZE_LABEL: Record<FontSizeKey, MessageKey> = {
  uiFontSize: "settings.uiFontSize", chatFontSize: "settings.chatFontSize", codeFontSize: "settings.codeFontSize",
};

function FontSizeInput({ name, value, onChange }: {
  name: FontSizeKey; value: number; onChange(value: number): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const { min, max } = FONT_SIZE_LIMITS[name];
  const label = t(SIZE_LABEL[name]);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = draft.trim() ? Number(draft) : NaN;
    const next = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : value;
    setDraft(String(next));
    onChange(next);
  };
  return (
    <div className="typography-row">
      <label htmlFor={id}>{label}</label>
      <div className="font-size-stepper">
        <button type="button" title={t("settings.decreaseSize", { name: label })} aria-label={t("settings.decreaseSize", { name: label })}
          disabled={value <= min} onClick={() => { setDraft(String(value - 1)); onChange(value - 1); }}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} value={draft}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const n = Number(text);
            if (text && Number.isInteger(n) && n >= min && n <= max) onChange(n);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(); }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(String(value)); }
          }} />
        <span aria-hidden="true">px</span>
        <button type="button" title={t("settings.increaseSize", { name: label })} aria-label={t("settings.increaseSize", { name: label })}
          disabled={value >= max} onClick={() => { setDraft(String(value + 1)); onChange(value + 1); }}>
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function FontSelector({ kind, settings, onChange }: {
  kind: FontKind; settings: TypographySettings; onChange(patch: Partial<TypographySettings>): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const key = kind === "ui" ? "uiFont" : "codeFont";
  const customKey = kind === "ui" ? "customUiFont" : "customCodeFont";
  const [draft, setDraft] = useState(settings[customKey]);
  const [invalid, setInvalid] = useState(false);
  const [fontRevision, setFontRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => { if (active) setFontRevision((n) => n + 1); });
    return () => { active = false; };
  }, []);
  useEffect(() => { setDraft(settings[customKey]); setInvalid(false); }, [settings[customKey]]);
  const available = useMemo(() => Object.fromEntries(Object.entries(CODE_FONT_NAMES).map(([font, name]) => [font, !fontProblem(name, true)])), [fontRevision]);
  const name = selectedFontName(settings, kind);
  const problem = name ? fontProblem(name, kind === "code") : undefined;
  const commit = () => {
    const next = normalizeFontName(draft);
    if (draft.trim() && !next) { setInvalid(true); return; }
    setInvalid(false);
    setDraft(next);
    onChange({ [customKey]: next });
  };
  const error = invalid ? t("settings.fontInvalid") : problem === "missing" ? t("settings.fontMissing")
    : problem === "proportional" ? t("settings.fontProportional")
    : settings[key] === "custom" && !name ? t("settings.fontNameRequired") : "";
  return (
    <div className="typography-row font-family-row">
      <label htmlFor={id}>{t(kind === "ui" ? "settings.uiFont" : "settings.codeFont")}</label>
      <div className="font-family-control">
        <select id={id} value={settings[key]} onChange={(event) => onChange({ [key]: event.target.value })}>
          {(kind === "ui" ? UI_FONTS : CODE_FONTS).map((font) => (
            <option key={font} value={font} disabled={font in CODE_FONT_NAMES && !available[font]}>
              {font in CODE_FONT_NAMES ? CODE_FONT_NAMES[font as keyof typeof CODE_FONT_NAMES] : t(FONT_LABEL[font])}
              {font in CODE_FONT_NAMES && !available[font] ? ` (${t("settings.fontUnavailable")})` : ""}
            </option>
          ))}
        </select>
        {settings[key] === "custom" && (
          <div className="custom-font-input">
            <input id={`${id}-custom`} value={draft} maxLength={100} placeholder={t("settings.fontName")}
              aria-label={t(kind === "ui" ? "settings.customUiFont" : "settings.customCodeFont")}
              aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => { setDraft(event.target.value); setInvalid(false); }} onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(); }
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(settings[customKey]); setInvalid(false); }
              }} />
            <button type="button" aria-label={t("settings.applyFont")} title={t("settings.applyFont")} onClick={commit}>
              <Check size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        {error && <p id={`${id}-error`} className="font-feedback" role="status">{error}</p>}
      </div>
    </div>
  );
}

export function AppearanceSettings() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme);
  const [settings, setSettings] = useState(readStoredTypography);
  const settingsRef = useRef(settings);
  const [resetKey, setResetKey] = useState(0);
  const update = (patch: Partial<TypographySettings>) => {
    const next = applyTypography({ ...settingsRef.current, ...patch });
    settingsRef.current = next;
    setSettings(next);
  };
  return (
    <div className="theme-page">
      <section className="appearance-section" aria-labelledby="appearance-colors">
        <h3 id="appearance-colors">{t("settings.colorTheme")}</h3>
        <div className="theme-picks">
          {THEMES.map((id) => (
            <button key={id} type="button" aria-pressed={theme === id}
              className={`theme-pick theme-pick-${id}${theme === id ? " on" : ""}`}
              onClick={() => setTheme(applyTheme(id))}>
              <span className="theme-pick-preview" aria-hidden="true">
                <span className="theme-pick-side" />
                <span className="theme-pick-main">
                  <span className="theme-pick-bar" /><span className="theme-pick-bubble user" /><span className="theme-pick-bubble" />
                </span>
              </span>
              <span className="theme-pick-meta"><b>{t(THEME_LABEL[id])}</b><small>{t(THEME_DESC[id])}</small></span>
            </button>
          ))}
        </div>
      </section>
      <section className="appearance-section typography-section" aria-labelledby="appearance-fonts">
        <div className="appearance-section-head">
          <h3 id="appearance-fonts">{t("settings.typography")}</h3>
          <button type="button" className="typography-reset" title={t("settings.resetTypography")} onClick={() => {
            update(DEFAULT_TYPOGRAPHY); setResetKey((key) => key + 1);
          }}>
            <RotateCcw size={14} aria-hidden="true" />{t("settings.resetTypography")}
          </button>
        </div>
        <div key={resetKey} className="typography-controls">
          <FontSelector kind="ui" settings={settings} onChange={update} />
          <FontSelector kind="code" settings={settings} onChange={update} />
          {(Object.keys(SIZE_LABEL) as FontSizeKey[]).map((name) => (
            <FontSizeInput key={name} name={name} value={settings[name]} onChange={(value) => update({ [name]: value })} />
          ))}
        </div>
      </section>
      <section className="appearance-section theme-live" aria-labelledby="appearance-preview">
        <h3 id="appearance-preview">{t("settings.themePreview")}</h3>
        <div className="theme-live-frame">
          <aside aria-hidden="true"><i /><i /><i /></aside>
          <main>
            <div className="user-turn"><article className="user">{t("settings.themePreviewUser")}</article></div>
            <article className="turn markdown">
              <p>{t("settings.themePreviewBot")}</p>
              <pre><code><span className="font-preview-keyword">const</span>{' greeting = "Hello, Tether!";\n'}<span className="font-preview-keyword">const</span>{' count = 1234567890;'}</code></pre>
            </article>
            <div className="theme-live-input">{t("settings.themePreviewInput")}</div>
          </main>
        </div>
      </section>
    </div>
  );
}
