# Provider icons

Bundled locally; no runtime requests to provider websites.

- `tokendance.svg`: https://tokendance.space/TokenDance品牌图标-单logo.svg — background removed for a currentColor mask; mark geometry unchanged.
- `tuzi.png`: https://tu-zi.com/portal-assets/media/crystal-blue-rabbit.png — reduced from 1024 × 1024 to 48 × 48; only its transparency is used as a mask.
- `openai-hk.png`: https://www.openai-hk.com/res/img/open.png — reduced from 300 × 300 to 40 × 40; only its transparency is used as a mask.
- `evolink.svg`: https://evolink.ai/apple-touch-icon.png — embeds the original mark reduced to 64 × 64; the SVG filter converts inverse luminance into alpha, removing the white background and retaining the original black mark.

All marks inherit the surrounding text color. Raster resources and the embedded EvoLink raster are at most 64px; all four masks are small enough for Vite to inline.

Fetched 2026-10-27. Provider marks remain the property of their respective owners.
Volcengine / OpenRouter paths are inlined from LobeHub lobe-icons (MIT) in ProviderBrandIcon.tsx.
