# Artwork

Generated with the built-in image generation tool, then encoded as WebP for delivery (126 KB). Runtime asset: `web/art/console-room.webp`. The original generation remains in the tool's generated-images directory.

## Prompt

Use case: stylized-concept. Asset type: wide pixel-art banner for a retro PlayStation-inspired remote-play web app. Create beautiful meticulous 16-bit pixel art, a grey classic game console with round disc lid and wired controller on a desk in the right half, a small luminous CRT showing a blue game world, blue-black midnight gaming room, angular electric-blue light from a window, tiny mint-green, rose-red, lilac and blue controller symbols floating subtly around the console, deep navy negative space at the left for HTML headings. Refined limited palette, crisp visible square pixels, nostalgic 1990s gaming magazine quality, modern composed lighting but no smooth 3D render, no gradients that obscure pixels. Landscape 1536x1024, main objects centered vertically on right, background dark #0b1023. No text, no logos, no watermark. This is a decorative UI illustration, not a screenshot of a UI.

The console, controller and disc SVGs are original pixel-grid UI assets. Jersey 20 is self-hosted from [Google Fonts](https://github.com/google/fonts/tree/main/ofl/jersey20); its OFL license is included beside the font. It replaced Pixelify Sans, whose digit 5 read as an S in console names such as PS5.

The codec Canvas/H.264/H.265 tiles, Control deck illustration, speaker and fullscreen icons are original SVG pixel-grid assets authored for the touch interface. They use crisp edges and the existing mint, blue and lilac palette.

Three original miniature monitor SVGs preview the Detailed, Minimal and Horizontal HUD layouts.

The classic UI refresh adds ten original 24 × 24 pixel-grid action SVGs (`action-*.svg`). They scale to 28–32 CSS pixels as decorative masks beside readable button labels; existing console, codec and controller artwork is enlarged without additional bitmap downloads. `classic.css` supplies the gray console frame, navy menu panels, colored face symbols and responsive sizing. Assets remain self-hosted and go through the existing versioned web build.
