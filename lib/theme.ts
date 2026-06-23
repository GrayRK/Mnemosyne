// =====================================================================
// Mnemosyne — дизайн-система (этап 1.2).
//
// Единый источник правды для облика расширения: палитра, типографика,
// радиусы, отступы, тени. Стиль снят пиксель-в-пиксель с утверждённых
// референсов: GUI «Linear Approach» (V4) + лого «Constellation» (V2).
// Холодная индиго-схема с аметистовым акцентом, без золота.
//
// Все три поверхности (popup, inspector, content shadow DOM) потребляют
// эти токены через CSS-переменные `--m-*` (см. buildThemeCss). Раскладку и
// редизайн UI здесь НЕ делаем — это этапы 1.3–1.5; здесь только фундамент.
// =====================================================================

/** Префикс CSS-переменных дизайн-системы (namespace, безопасный на чужих страницах). */
export const THEME_VAR_PREFIX = '--m-';

// ---------------------------------------------------------------------
// Токены. Ключ — суффикс CSS-переменной (`--m-<key>`), значение — CSS.
// Порядок групп: поверхности → текст → акцент → бренд → статусы →
// типографика → форма → тени.
// ---------------------------------------------------------------------
export const THEME_TOKENS = {
  // Поверхности (индиго-графит, по нарастанию «приподнятости»).
  'bg': '#12151D', // фон страницы / самый глубокий слой
  'surface': '#171B24', // карточки, панели
  'surface-2': '#1D222B', // приподнятые/hover-поверхности
  'surface-inset': '#0E1014', // утопленные блоки (инпуты, футер)
  'border': '#262B36', // тонкая разделительная линия
  'border-strong': '#333A48', // акцентированная граница (фокус контейнера)

  // Текст.
  'text-strong': '#FFFFFF', // заголовки, максимальный контраст
  'text': '#F2F2F7', // основной текст
  'text-muted': '#767F9A', // подписи, лейблы секций (сине-серый)
  'text-faint': '#565E70', // второстепенные/неактивные подписи

  // Акцент действия — аметист (кнопки, слайдеры, тогглы, фокус).
  'accent': '#7256E7',
  'accent-hover': '#8366EC',
  'accent-press': '#5E45D6',
  'accent-soft': 'rgba(114, 86, 231, 0.16)', // заливка фокуса/тинты
  'on-accent': '#FFFFFF', // текст/иконки поверх акцента

  // Бренд — холодный градиент лого (серебро → лаванда → барвинок → фиолет).
  // Для бренд-марки, ключевых заголовков, орнаментов-созвездий.
  'brand-1': '#C9D2EC',
  'brand-2': '#BCB1EF',
  'brand-3': '#88AEF1',
  'brand-4': '#7256E7',
  'brand-gradient': 'linear-gradient(135deg, #C9D2EC 0%, #BCB1EF 35%, #88AEF1 65%, #7256E7 100%)',

  // Статусы.
  'ok': '#34D399',
  'warn': '#E7B856',
  'danger': '#DC2626', // стоп/активное действие (наследие виджета)
  'danger-hover': '#EF4444',

  // Типографика.
  'font-ui': "'Segoe UI', system-ui, -apple-system, sans-serif",
  'font-brand': "'Segoe UI', system-ui, -apple-system, sans-serif", // см. STYLE.md — опц. античный шрифт позже
  'tracking-brand': '0.24em', // разрядка бренд-надписи MNEMOSYNE
  'tracking-label': '0.08em', // разрядка лейблов секций (uppercase)

  // Форма.
  'radius-sm': '8px',
  'radius': '12px',
  'radius-lg': '16px',
  'radius-pill': '999px',

  // Отступы (шаг 4).
  'space-1': '4px',
  'space-2': '8px',
  'space-3': '12px',
  'space-4': '16px',
  'space-5': '20px',
  'space-6': '24px',

  // Тени.
  'shadow-card': '0 1px 2px rgba(0, 0, 0, 0.45)',
  'shadow-pop': '0 8px 24px rgba(0, 0, 0, 0.5)',
} as const;

/** Имя токена (ключ THEME_TOKENS). */
export type ThemeTokenName = keyof typeof THEME_TOKENS;

/** Полное имя CSS-переменной токена: `token('accent') → '--m-accent'`. */
export function token(name: ThemeTokenName): string {
  return `${THEME_VAR_PREFIX}${name}`;
}

/** CSS-выражение для использования токена: `cssVar('accent') → 'var(--m-accent)'`. */
export function cssVar(name: ThemeTokenName): string {
  return `var(${token(name)})`;
}

/**
 * Собрать блок объявления всех токенов как CSS-переменных.
 * @param selector куда вешать переменные: `:root` для документа (popup/inspector),
 *                 `:host` для shadow DOM (виджет/субтитры в content.ts).
 */
export function buildThemeCss(selector: ':root' | ':host' = ':root'): string {
  const decls = (Object.keys(THEME_TOKENS) as ThemeTokenName[])
    .map((name) => `  ${token(name)}: ${THEME_TOKENS[name]};`)
    .join('\n');
  return `${selector} {\n${decls}\n}\n`;
}
