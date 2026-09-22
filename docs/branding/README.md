# Brreg interface

This fork applies Brreg-inspired visual styling to LibreChat. All original product names, wording, translations, greetings and configured conversation starters are retained. It is a first design pass, not a claim of formal brand approval or completed accessibility certification.

## Run locally

Use Node 24 and the normal LibreChat services/configuration. For a fresh installation, copy `.env.example` to `.env` and configure MongoDB and your model endpoints. Keep the existing application title and language configuration.

```sh
npm ci
npm run frontend
npm run backend
```

For frontend development with the backend running separately:

```sh
npm run frontend:dev
```

Language selection and browser-language detection are unchanged. Rebuild your own image when deploying; an upstream LibreChat image will not contain this fork's frontend.

## Design and maintenance

- `client/src/branding/theme.ts`: versioned semantic light/dark colour and appearance tokens. New installations receive the brand theme. Existing valid saved custom palettes and `REACT_APP_THEME_*` overrides retain precedence. Saved light/dark/system and high-contrast preferences continue to work. The deployment palette is not written into local storage.
- `client/src/branding/Brand.tsx`: locally hosted Brreg logo. The logo remains on a white plate in dark mode, keeping the original artwork intact.
- Login, conversation sidebar, welcome screen and chat header compose the existing LibreChat primitives. No translation files or user-facing copy are changed.
- Backend authentication, permissions, model selection and integrations retain their existing behavior. Configure your organisation's authentication separately.
- The Designsystemet approach informs the semantic tokens and restrained layout. This pass does not replace LibreChat's component system with Digdir's React library. That migration would require a separate scope.

## Asset sources

Retrieved 2026-09-21:

- Logo: https://scf.brreg.no/bilder/brreg_logo.svg (vendored unchanged under `client/public/assets/branding/`).
- Public website colours: https://scf.brreg.no/css/br.css?v=22 — blue `#00688e`, pale blues `#89d6f6` and `#bce6fa`, text `#333333`. Additional neutral shades and the dark palette are adaptations for this application, not official brand specifications.
- Website typography: https://scf.brreg.no/css/framework.css?v=67 — Inter. LibreChat already self-hosts Inter; no external font request was added.
- Icons: https://aksel.nav.no/komponenter/ikoner — `@navikt/aksel-icons` (MIT).
- Design guidance: https://designsystemet.no/en.

Confirm the artwork and final presentation with the internal brand owner before a production rollout. Existing LibreChat attribution and licence files are retained.

## Verification

The frontend production build, frontend TypeScript check, ESLint and focused tests are used to verify the change. The initial visual pass was inspected in Chromium with mocked API responses. This revision removes the added text and starter cards and restores all original wording; new screenshots have not been generated. These previews do not verify a live backend or model connection. Brand tests check normal text/link contrast against the main and sidebar surfaces in both colour schemes and saved-palette compatibility.

The required Lighthouse command was attempted. Its temporary MongoDB process failed with `open: Operation not permitted` in the execution environment before the browser audit could run. Run `npm run lighthouse` in a development environment that can start MongoDB before merging.
