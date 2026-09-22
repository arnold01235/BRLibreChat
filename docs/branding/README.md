# Brreg colour theme

This change applies Brreg-inspired light and dark colours through LibreChat's existing semantic theme tokens. It changes only colours: the original logos, icons, layouts, typography, control shapes, text, translations and application title are retained. No new dependencies are required.

## Maintenance

`client/src/branding/theme.ts` defines the palette. `client/src/App.jsx` supplies it as the default for installations without a saved custom palette. Existing environment colour overrides and valid saved palettes take precedence; dark/light/system and high-contrast preferences remain supported. The default deployment palette is not written to local storage.

Use the existing LibreChat configuration and rebuild the frontend or your deployment image to apply the colours.

```sh
npm ci
npm run frontend
```

## Colour sources

Brreg's public website stylesheet https://scf.brreg.no/css/br.css?v=22 supplies blue `#00688e`, pale blue `#bce6fa` and text `#333333`. Additional neutrals and the dark palette are application-specific adaptations, not official brand specifications. No Brreg artwork is included.

## Verification

The palette tests check text/link contrast on main and sidebar surfaces in both modes, theme validation and compatibility with saved palettes. The frontend build, TypeScript check and focused tests are the local checks for this change.

The earlier Lighthouse attempt failed before auditing because temporary MongoDB could not start (`open: Operation not permitted`). Run that gate in a compatible environment before merging. Previous screenshots include superseded changes and do not represent this colours-only revision.
