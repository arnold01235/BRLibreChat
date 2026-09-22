import { fromLegacyTheme, validateThemeDefinition } from '@librechat/client';
import type { ThemeDefinition } from '@librechat/client';

/** Brreg website colours mapped onto LibreChat's versioned semantic tokens. */
export const brregTheme: ThemeDefinition = {
  version: 1,
  name: 'brreg',
  modes: {
    light: {
      colors: {
        'rgb-text-primary': '51 51 51',
        'rgb-text-secondary': '69 85 94',
        'rgb-text-secondary-alt': '82 99 108',
        'rgb-text-tertiary': '82 99 108',
        'rgb-text-muted': '90 105 113',
        'rgb-link': '0 104 142',
        'rgb-link-hover': '0 77 106',
        'rgb-accent-primary': '0 104 142',
        'rgb-accent-primary-hover': '0 77 106',
        'rgb-ring-primary': '0 104 142',
        'rgb-surface-primary-alt': '240 247 250',
        'rgb-surface-secondary': '240 247 250',
        'rgb-surface-secondary-alt': '218 237 246',
        'rgb-surface-tertiary': '226 242 249',
        'rgb-surface-active': '218 237 246',
        'rgb-surface-active-alt': '188 230 250',
        'rgb-surface-hover': '218 237 246',
        'rgb-surface-hover-alt': '188 230 250',
        'rgb-surface-composer-hover': '240 247 250',
        'rgb-surface-submit': '0 104 142',
        'rgb-surface-submit-hover': '0 77 106',
        'rgb-border-light': '211 225 232',
        'rgb-border-medium': '154 177 189',
        'rgb-border-heavy': '96 125 140',
      },
    },
    dark: {
      colors: {
        'rgb-text-primary': '235 244 248',
        'rgb-text-secondary': '190 209 219',
        'rgb-text-muted': '160 182 194',
        'rgb-link': '137 214 246',
        'rgb-link-hover': '188 230 250',
        'rgb-accent-primary': '137 214 246',
        'rgb-accent-primary-hover': '188 230 250',
        'rgb-ring-primary': '137 214 246',
        'rgb-presentation': '18 30 38',
        'rgb-header-primary': '18 30 38',
        'rgb-surface-primary': '18 30 38',
        'rgb-surface-primary-alt': '24 40 50',
        'rgb-surface-secondary': '29 47 58',
        'rgb-surface-secondary-alt': '35 58 71',
        'rgb-surface-tertiary': '35 58 71',
        'rgb-surface-dialog': '24 40 50',
        'rgb-surface-chat': '18 30 38',
        'rgb-surface-active': '35 58 71',
        'rgb-surface-active-alt': '39 68 84',
        'rgb-surface-hover': '35 58 71',
        'rgb-surface-hover-alt': '39 68 84',
        'rgb-surface-composer-hover': '35 58 71',
        'rgb-surface-submit': '0 104 142',
        'rgb-surface-submit-hover': '0 88 120',
        'rgb-border-light': '55 77 90',
        'rgb-border-medium': '97 127 142',
        'rgb-border-heavy': '137 164 179',
      },
    },
  },
};

/** Let the provider restore a saved custom palette; branding is the fresh-install default. */
export function getDefaultBrandTheme(): ThemeDefinition | undefined {
  try {
    const saved = localStorage.getItem('theme-definition');
    if (saved && validateThemeDefinition(JSON.parse(saved)).length === 0) {
      return undefined;
    }
    const legacy = localStorage.getItem('theme-colors');
    if (legacy && validateThemeDefinition(fromLegacyTheme(JSON.parse(legacy))).length === 0) {
      return undefined;
    }
  } catch {
    // Unavailable storage or invalid saved data must not prevent startup.
  }
  return brregTheme;
}
