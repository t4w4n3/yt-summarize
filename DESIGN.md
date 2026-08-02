---
name: Summarize YT
description: A one-bit desktop workstation for turning YouTube videos into durable Markdown study notes.
colors:
  paper: "#f4f4f0"
  paper-hi: "#fbfbf8"
  ink: "#11110f"
  muted: "#5c5c55"
  dither: "#d3d3cc"
  dither-dark: "#a8a8a0"
  acid-lime: "#d9ff3f"
  error: "#b11818"
typography:
  display:
    fontFamily: "Press Start 2P, IBM Plex Mono, Courier New, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  body:
    fontFamily: "IBM Plex Mono, Courier New, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.01em"
  label:
    fontFamily: "IBM Plex Mono, Courier New, monospace"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  none: "0"
spacing:
  xs: "4px"
  sm: "9px"
  md: "13px"
  lg: "21px"
  xl: "30px"
components:
  button-primary:
    backgroundColor: "{colors.acid-lime}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 14px"
    height: "42px"
  button-secondary:
    backgroundColor: "{colors.paper-hi}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 10px"
    height: "31px"
  input-url:
    backgroundColor: "{colors.paper-hi}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 13px"
    height: "46px"
---

# Design System: Summarize YT

## Overview

**Creative North Star: "The One-Bit Study Workstation"**

Summarize YT is a small, tactile desktop for one serious task: turning a video into a study artifact worth keeping. The interface borrows from early one-bit desktops and HyperCard-like work surfaces: black-and-white pixels, stippled grays, title bars, windows, and inverse pressed states. The visual language makes the pipeline feel inspectable rather than magical.

The system is intentionally flat, high-contrast, and slightly physical without becoming nostalgic decoration. The acid-lime accent marks live state and the next useful action; it is never used as general ornament. Content remains the product: the input window gives the source and pipeline priority, while the note window is ready to become the largest reading surface.

**Key Characteristics:**
- Black ink, paper white, ordered dither, and one acid-lime live state.
- One-pixel desktop geometry: rectangular windows, title bars, square controls.
- Monospace operational copy paired with a pixel display face for window titles.
- Status is explicit: queued, working, done, and error states are named in place.

## Colors

The palette is restrained and binary first; lime is the single signal color and red is reserved for recovery.

### Primary
- **Acid Lime** (`#d9ff3f`): Primary action, active pipeline step, live status LED, and selected output state.

### Neutral
- **Workstation Paper** (`#f4f4f0`): Dithered desktop ground.
- **Window White** (`#fbfbf8`): App surfaces, inputs, and raised paper windows.
- **Black Ink** (`#11110f`): Text, rules, borders, pressed controls, and high-salience status.
- **Muted Graphite** (`#5c5c55`): Supporting copy and metadata; never used for essential text.
- **Dither Gray** (`#d3d3cc`): Status bars, disabled/loading blocks, and tonal texture.
- **Deep Dither Gray** (`#a8a8a0`): Background dot/line texture and low-contrast dividers.
- **Recovery Red** (`#b11818`): Invalid URL and failed worker states only.

### Named Rules
**The One Signal Rule.** Lime means current, ready, or actionable. It does not decorate inactive surfaces.

## Typography

**Display Font:** Press Start 2P (with IBM Plex Mono, Courier New, monospace)
**Body Font:** IBM Plex Mono (with Courier New, monospace)
**Label/Mono Font:** IBM Plex Mono

**Character:** Operational copy is compact, legible, and machine-like. Pixel titles are reserved for window names and important section headings, creating a clear layer above the readable workhorse text.

### Hierarchy
- **Display** (regular, 12px, 1.2): Window titles and compact section headings.
- **Title** (600, 15px, 1.3): Rendered note title.
- **Body** (regular, 13px, 1.45): Instructions, supporting explanation, and note prose; keep reading blocks around 65–75ch.
- **Label** (600, 10px, 1.2, tracked uppercase): Field labels, stage names, metadata, and status text.

### Named Rules
**The Readable Machine Rule.** Pixel type establishes the workstation; body copy stays in the monospace workhorse face and does not sacrifice legibility for theme.

## Layout

The desktop is a full-bleed dithered work surface beneath a sticky menu bar. The primary window is centered with generous breathing room and a slight shadow offset. Supporting note windows overlap the canvas at wide sizes but disappear below 1050px so they never compete with the task.

The primary app window uses a two-column split: source and four-stage pipeline on the left, rendered note on the right. A shared title bar and bottom status bar frame both surfaces. The desktop form uses 30px internal padding; mobile reduces this to 18px and stacks source over output. At 500px and below, the URL field and action stack, pipeline detail labels simplify, and output content remains naturally scrollable.

## Elevation & Depth

Depth is structural and pixel-native, not glossy. Surfaces are flat at rest and gain a soft offset shadow to separate the central window from the stippled desktop. Title-bar hatching, borders, and overlapping rectangles carry most of the hierarchy.

### Shadow Vocabulary
- **Primary window lift** (`7px 7px 0 rgba(17, 17, 15, .18)`): Separates the app window from the desktop.
- **Utility window lift** (`5px 5px 0 rgba(17, 17, 15, .13)`): Separates small background and shortcut windows.
- **Action hover lift** (`3px 3px 0 #11110f`): A short state response on interactive buttons only.

### Named Rules
**The Window Rule.** A shadow belongs to a window or a direct action state; never add floating-card shadows to ordinary content blocks.

## Shapes

All controls and windows use square corners (`0`). Borders are black and generally 1–2px. Window title bars have a close square at left, centered title, and a small grip at right. Inputs are large enough to read and operate, with a 2px ink stroke and no browser-default rounding.

## Components

### Buttons
- **Shape:** Square, bordered, tactile (`0` radius, 2px ink border).
- **Primary:** Acid-lime surface with ink text; `42px` minimum height and compact horizontal padding.
- **Hover / Focus:** Hover lifts by one pixel with a small black offset shadow; focus uses a 3px lime outline with 3px offset.
- **Active / Disabled:** Active inverts to black and removes the offset; disabled uses dither gray and does not move.

### Cards / Containers
- **Corner Style:** Square, no rounding.
- **Background:** Window White on the paper desktop.
- **Shadow Strategy:** Use the window shadow vocabulary only for actual windows.
- **Border:** 2px ink outer frame; 1px internal rules.
- **Internal Padding:** 30px desktop, 18px mobile.

### Inputs / Fields
- **Style:** Window White fill, 2px ink stroke, square corners, monospace 12px text.
- **Focus:** White surface with a 3px lime keyboard outline and 3px offset.
- **Error / Disabled:** Error switches the stroke and message to Recovery Red; busy inputs disable without changing their geometry.

### Navigation
- **Style:** Sticky, 43px menu bar with a bottom ink rule, compact uppercase controls, and a workstation LED.
- **State:** Menu actions are text-first and underline on hover; the status area remains quiet and informational.
- **Mobile:** Secondary menu commands hide while the product name and local-workstation status stay visible.

### Pipeline Track
The four stages are a horizontal line of numbered square nodes: Download, Convert, Transcribe, Summarize. The current node becomes lime and underlines its label; completed nodes invert to black. On narrow screens, supporting descriptions disappear but the stage sequence remains.

## Do's and Don'ts

### Do:
- **Do** use the black/white/dither foundation before reaching for lime.
- **Do** make the current pipeline stage and recovery message explicit in words, not only color.
- **Do** preserve the square window grammar across forms, buttons, inputs, and status surfaces.
- **Do** keep note content readable and let the Markdown become the densest surface when it exists.
- **Do** use the lime accent for action, selection, and live state.

### Don't:
- **Don't** introduce gradients, rounded cards, glass effects, or soft dashboard tiles.
- **Don't** use pixel type for long-form note copy, helper text, or error explanations.
- **Don't** use acid lime as ambient decoration or apply it to inactive controls.
- **Don't** hide failed pipeline stages behind an indefinite spinner.
- **Don't** replace real note content with decorative metrics or invented claims.
