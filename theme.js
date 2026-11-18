// Apply the theme before rendering (avoids flicker). If nothing is saved or the value is unknown, follow the OS light / dark setting
const UI_THEMES = ['light', 'dark', 'green', 'g6'];
const THEME_KEY = 'docket-theme';
function applyTheme(t) {
  if (UI_THEMES.includes(t)) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
const savedTheme = () => { try { return localStorage.getItem(THEME_KEY) || ''; } catch { return ''; } };
applyTheme(savedTheme());
