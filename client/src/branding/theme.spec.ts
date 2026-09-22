import { resolveTheme, validateThemeDefinition } from '@librechat/client';
import { brregTheme, getDefaultBrandTheme } from './theme';

const luminance = (rgb: string) =>
  rgb.split(' ').reduce((total, value, index) => {
    const channel = Number(value) / 255;
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return total + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);

const contrast = (foreground: string, background: string) => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

afterEach(() => localStorage.clear());

test('the branded palette resolves through the shared registry', () => {
  expect(validateThemeDefinition(brregTheme)).toEqual([]);
  for (const mode of ['light', 'dark'] as const) {
    const { colors } = resolveTheme(brregTheme, mode);
    for (const text of [
      'rgb-text-primary',
      'rgb-text-secondary',
      'rgb-text-muted',
      'rgb-link',
    ] as const) {
      for (const surface of ['rgb-presentation', 'rgb-surface-primary-alt'] as const) {
        expect(contrast(colors[text], colors[surface])).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test('fresh installations and invalid saved data receive Brreg colours', () => {
  expect(getDefaultBrandTheme()).toBe(brregTheme);
  localStorage.setItem('theme-definition', '{broken');
  expect(getDefaultBrandTheme()).toBe(brregTheme);
});

test('saved custom palettes remain owned by ThemeProvider', () => {
  localStorage.setItem('theme-definition', JSON.stringify({ ...brregTheme, name: 'custom' }));
  expect(getDefaultBrandTheme()).toBeUndefined();
  localStorage.clear();
  localStorage.setItem('theme-colors', JSON.stringify({ 'rgb-link': '0 104 142' }));
  expect(getDefaultBrandTheme()).toBeUndefined();
});
