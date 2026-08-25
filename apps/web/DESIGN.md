---
name: Kodus
description: Dark instrument panel for an AI code review practice — tonal depth, one amber signal, no decoration.
colors:
  void: "#101019"
  card-lv1: "#181825"
  card-lv2: "#202032"
  card-lv3: "#30304b"
  border-strong: "#3d3d5c"
  signal-amber: "#f8b76d"
  amber-hover: "#ffca8a"
  amber-deep: "#443024"
  amber-ink: "#1a0f04"
  lavender: "#c9bbf2"
  lavender-deep: "#312b4b"
  blush: "#fdbfbf"
  blush-deep: "#592830"
  text-primary: "#ffffff"
  text-secondary: "#cdcddf"
  text-tertiary: "#f3f3f780"
  success: "#42be65"
  info: "#5190ff"
  alert: "#f2c631"
  warning: "#ff8b40"
  danger: "#fa5867"
  brand-purple: "hsl(255 30.7% 49.2%)"
  brand-red: "hsl(0 83.7% 61.6%)"
  brand-orange: "hsl(32 91.4% 54.3%)"
typography:
  display:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
  headline:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.75rem"
  title:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: "1"
  body:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  label:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
  review:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "1.25rem"
  micro:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "1rem"
  meta:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: "0.875rem"
  data:
    fontFamily: "Overpass Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  component: "12px"
  pill: "9999px"
spacing:
  container: "24px"
  control-sm: "8px 16px"
  control-md: "10px 20px"
  control-lg: "12px 24px"
components:
  button-primary:
    backgroundColor: "{colors.signal-amber}"
    textColor: "{colors.amber-deep}"
    rounded: "{rounded.component}"
    padding: "{spacing.control-md}"
    height: "40px"
    typography: "{typography.label}"
  button-primary-dark:
    backgroundColor: "{colors.amber-deep}"
    textColor: "{colors.signal-amber}"
    rounded: "{rounded.component}"
    padding: "{spacing.control-md}"
  button-secondary:
    backgroundColor: "{colors.lavender-deep}"
    textColor: "{colors.signal-amber}"
    rounded: "{rounded.component}"
    padding: "{spacing.control-md}"
  button-helper:
    backgroundColor: "{colors.card-lv2}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.component}"
    padding: "{spacing.control-md}"
  button-cancel:
    backgroundColor: "transparent"
    textColor: "{colors.text-tertiary}"
    rounded: "{rounded.component}"
    padding: "{spacing.control-md}"
  badge:
    backgroundColor: "{colors.amber-deep}"
    textColor: "{colors.signal-amber}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
  card:
    backgroundColor: "{colors.card-lv1}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.component}"
    padding: "{spacing.container}"
  input:
    backgroundColor: "{colors.card-lv2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.component}"
    padding: "0 20px"
    height: "40px"
    typography: "{typography.body}"
---

# Design System: Kodus

## Overview

**Creative North Star: "The Control Room"**

A dark room full of instruments. Everything is legible under low light, nothing competes for attention on its own, and a single amber lamp lights only what needs a decision. The product's own vocabulary already says this out loud — the leader's landing surface is called the Cockpit — and the visual system is built for the person watching a practice run rather than the person being reviewed.

The system is **dense and efficient** before it is comfortable. This is a working instrument for someone who arrives with a question, so information per pixel outranks breathing room, and spacing tightens rather than paginates when a surface carries real data. Density is never bought with noise: surfaces are borderless, flat, and quiet, and hierarchy comes from how light a panel is, not from lines drawn between things.

The most distinctive decision in the system is how it responds to touch. Hover and active states **do not change colour** — they raise brightness (`brightness-120`). A button lit by the amber lamp gets brighter under the cursor; it never becomes a different button. The palette stays fixed while the light moves across it, which is what keeps a dense screen calm.

**Key Characteristics:**
- Near-black blue-violet ground (`#101019`) with three tonal panel steps above it
- Exactly one accent — Signal Amber — carrying every primary action
- State expressed as light (brightness, focus ring), never as a colour swap
- Borderless surfaces; separation by tone, not by rule
- Generous 12px corners on every interactive surface, against tight interior spacing
- DM Sans throughout, Overpass Mono reserved for data and code

## Colors

A cool, blue-violet dark palette with a single warm light source; every other hue in the system is either a status signal or a rarely-used support accent.

### Primary
- **Signal Amber** (`#f8b76d`): the only accent. Primary buttons, focus rings, active navigation, and anything the user is meant to act on. Warm against an entirely cool ground, which is what makes it read as a lamp rather than as a brand colour.
- **Amber Deep** (`#443024`): the amber's own dark twin. Backs badges and secondary-emphasis buttons where amber text sits on an amber-derived ground, so emphasis is available without spending the accent itself.
- **Amber Hover** (`#ffca8a`): the lit state of the accent, used where brightness alone is not enough.
- **Amber Ink** (`#1a0f04`): near-black warm text for the rare case of dark type on a full amber field.

### Secondary
- **Lavender** (`#c9bbf2`) and **Lavender Deep** (`#312b4b`): the support pair, used for the secondary button and for classifications that must be distinguishable from action without becoming one.

### Tertiary
- **Blush** (`#fdbfbf`) and **Blush Deep** (`#592830`): the third pairing, reserved for a category that is neither action nor support. Rare by design.

### Neutral
- **Void** (`#101019`): the page ground. Blue-violet rather than neutral black — the entire system is tinted cool so the amber has something to be warm against.
- **Panel L1** (`#181825`): the resting card. Most content sits here.
- **Panel L2** (`#202032`): a card inside a card, and the resting state of input fields.
- **Panel L3** (`#30304b`): the highest tonal step, and the ring colour that outlines inputs and popovers.
- **Border Strong** (`#3d3d5c`): the only visible stroke in the system, used sparingly where a tonal step is not enough.
- **Text Primary** (`#ffffff`), **Text Secondary** (`#cdcddf`), **Text Tertiary** (`#f3f3f780`): full white for what must be read, a cooled grey for supporting copy, and a 50%-alpha grey for text that is present but subordinate.

### Status
- **Success** (`#42be65`), **Info** (`#5190ff`), **Alert** (`#f2c631`), **Warning** (`#ff8b40`), **Danger** (`#fa5867`). Status buttons pair each hue with a very dark tinted ground (success sits at `#152120`, in-progress at `#171D30`, error at `#271720`) rather than filling with the hue itself.

### Named Rules
**The One Lamp Rule.** Signal Amber is the only accent in the system. A screen has one amber region — the thing to do next. If two elements are amber, one of them is wrong.

**The Cool Ground Rule.** Every neutral is tinted blue-violet, never neutral grey. A pure `#1a1a1a` panel dropped into this system reads as a foreign element immediately, because it removes the temperature contrast the accent depends on.

**The Status-Is-Not-Accent Rule.** Success, danger, warning, alert, and info are semantic and never decorative. They never stand in for the accent, and the accent never stands in for them.

**The Visible-Focus Rule.** A focus ring is drawn with the dedicated `--color-ring` token (`#f59220`), never with the structural `card-lv3`. The two look similar in a token list and are nothing alike on screen: `card-lv3` on a resting card measures **1.38:1**, under the **3:1** WCAG 2.1 requires of a focus indicator, while `--color-ring` measures between 5.46:1 and 8.12:1 on every surface in this system. A thick ring in a colour nobody can see is worse than a thin one, because it looks solved. Resting and structural rings keep `card-lv3`; only the focus state switches.

## Typography

**Display / Body Font:** DM Sans (loaded via `next/font/google`, with a `sans-serif` fallback)
**Data / Mono Font:** Overpass Mono (with a `monospace` fallback)

**Character:** One geometric sans carries the entire interface, which keeps a dense screen from fragmenting; the mono appears only where characters need to line up or be copied. There is no display face and no serif anywhere in the system — the type does not perform, it reports.

### Hierarchy
- **Display / h1** (600, `1.5rem`): page titles. The largest type in the product; there is no hero scale.
- **Headline / h2** (600, `1.25rem`): section titles within a page.
- **Title** (700, `1.125rem`, `line-height: 1`): card titles, set slightly heavier and tighter than the headings above them.
- **Body** (400, `0.875rem`): all running copy, table cells, and field values.
- **Label** (600, `0.875rem`): buttons and form labels — same size as body, distinguished by weight alone.
- **Data** (Overpass Mono, 400, `0.875rem`): identifiers, code, diffs, token counts, and anything the user may copy.

### The dense ramp

The pull request review surface reads below the general scale, because a diff, a file tree, and a suggestion rail have to sit side by side. Three steps exist only for it, exposed as `text-review`, `text-2xs`, and `text-3xs`:

- **Review** (500, `13px`): the review surface's own body and identity size — file tree rows, tab labels, author names, status text, suggestion prose. Sits between dense metadata and ordinary body.
- **Micro** (500, `11px`): small labels and chips inside that surface.
- **Meta** (500, `10px`): timestamps, counters, and line numbers.

Tailwind's scale bottoms out at `text-xs` (12px), which is why these three had no names and were previously written as literals in ten files.

### Named Rules
**The Small-h3 Rule.** The third heading level is deliberately `0.875rem` — the same size as body — and reads as a label, not a heading. Do not "fix" it upward to fit a conventional scale; a section this deep should announce itself by weight and position, not by size.

**The Weight-Over-Size Rule.** Below the headline level, hierarchy is carried by weight (400 → 600 → 700) at a fixed `0.875rem`. Reach for weight before reaching for a new size.

**The Mono-Is-For-Data Rule.** Overpass Mono marks content that is machine-shaped: shas, model ids, paths, code, aligned figures. It is never used for personality, section labels, or emphasis.

**The No-Literal-Size Rule.** Every size in the system has a name. If a surface needs a step that does not exist, add it to `@theme` and document it here — do not write `text-[13px]` in a component. A literal is invisible to the design system, so nothing keeps the next one consistent with it, and half-pixel values (`10.5px`, `12.5px`, `13.5px`) are the reliable symptom that this rule was skipped.

## Layout

Content is centred in a container with a `2rem` inline padding and no maximum width above the small breakpoint — surfaces are expected to use the width they are given, because the primary user is at a desk reading tables.

Interior rhythm is built on a `24px` module: cards pad their header, content, and footer at `24px`, with the header and footer collapsing their top padding so the three regions read as one block rather than three stacked ones. Controls sit on a tighter scale — `8px` vertical for small, `10px` for medium, `12px` for large — which is what produces the density the system is after.

Groups are laid out with flex and `gap` rather than per-element margins. Cards clip their own overflow (`overflow-hidden`), so a full-bleed element inside a card follows the card's corner without extra masking.

Scrollable regions use a custom thin scrollbar (`8px` track, Panel L3 thumb at `4px` radius, transparent track) rather than the platform default, so a dense screen does not gain a bright system-coloured bar down its edge.

## Elevation & Depth

**This system is tonal, not shadowed.** Depth is read from lightness: Void → Panel L1 → Panel L2 → Panel L3, each step lighter and more forward than the last. Cards carry only `shadow-sm`, which is close to imperceptible and exists to soften the edge rather than to lift the surface.

Two richer shadow tokens exist in the stylesheet — `--shadow-card` and `--shadow-elevated`, both two-layer with an inset top highlight — and they are reserved for genuinely floating surfaces (dialogs, popovers, dropdowns) rather than for ordinary panels. A card that reaches for `--shadow-elevated` to look important is misusing the system; it should move up a tonal step instead.

### Shadow Vocabulary
- **Card** (`0 1px 0 0 rgba(255,255,255,0.02) inset, 0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -8px rgba(0,0,0,0.4)`): a surface that has left the page plane.
- **Elevated** (`0 1px 0 0 rgba(255,255,255,0.03) inset, 0 4px 8px rgba(0,0,0,0.5), 0 16px 40px -12px rgba(0,0,0,0.55)`): a surface floating over content, such as a modal.

### Named Rules
**The Tonal-First Rule.** To make something feel higher, move it up a panel step. Reach for a shadow only when the surface genuinely floats over unrelated content and can be dismissed.

**The Inset Highlight Rule.** Both shadows open with a 1px inset white highlight along the top edge. That highlight is what makes a floating surface read as lit from above in a dark room; a hand-written shadow that omits it will look flat and out of place.

## Shapes

Corners are generous and uniform: every interactive surface — button, input, card — uses a **12px** radius (`rounded-xl`), which is deliberately larger than the `4 / 6 / 8px` scale declared in the theme. Treat the declared scale as available for small interior details (the skeleton block at `6px`, the scrollbar thumb at `4px`) and `12px` as the real component radius.

The exception is fully round: the extra-small button and every icon-only button at that size are pills (`rounded-full`), which is also what gives badges their shape, since a badge is literally a small decorative button.

There are no borders on cards. Where an outline is needed, the system uses a `1px` ring in Panel L3 rather than a border — inputs rest with `ring-1` and thicken to `ring-3` on focus. Strokes are a state, not a decoration.

## Components

### Buttons
- **Shape:** generous 12px corners (`rounded-xl`); the `xs` and icon-only sizes are pills (`rounded-full`).
- **Structure:** every variant sets two custom properties, `--button-background` and `--button-foreground`, and the base class consumes them. A new variant is a colour pair, never a new set of rules.
- **Primary:** Signal Amber ground with Amber Deep text — dark type on a lit field.
- **Primary Dark / Secondary / Tertiary:** the inverse arrangement — light type on the deep twin of each hue (`amber-deep`, `lavender-deep`, `blush-deep`). This is how emphasis is expressed without spending the accent.
- **Helper:** Panel L2 ground with secondary text, for neutral actions inside a card.
- **Cancel:** no ground at all; tertiary text that rises to primary on hover.
- **Status (`success` / `in-progress` / `error`):** the status hue as text on a very dark tinted ground of the same hue.
- **Sizes:** `xs` (28px min-height), `sm` (32px), `md` (40px), `lg` (48px), plus square icon-only counterparts at each step.
- **Hover / Active:** `brightness-120`. Not a colour change, not a translation, not a shadow.
- **Focus:** `ring-3` — a thick ring, on the assumption that a keyboard user on a dark dense screen needs to find the focus quickly.
- **Disabled:** ground drops to `text-placeholder/30` with placeholder-coloured text, and the hover brightness is explicitly cancelled. **Loading:** `cursor-wait` and a spinner in place of the label.

### Chips / Badges
- **Style:** a badge is a `Button` at size `xs`, variant `primary-dark`, marked decorative — Signal Amber text on Amber Deep, in a pill.
- **Consequence:** badges inherit every button state for free. Do not build a parallel badge component; pass a different button variant instead.

### Cards / Containers
- **Corner Style:** 12px (`rounded-xl`), with `overflow-hidden` so children follow the corner.
- **Background:** one of the tonal steps — `none` (transparent), L1, L2, or L3. L1 is the default resting card.
- **Shadow Strategy:** `shadow-sm` only; see Elevation & Depth.
- **Border:** none.
- **Internal Padding:** `24px` on header, content, and footer, with content and footer dropping their top padding so the regions read as one block.
- **Title:** `1.125rem`, weight 700, `line-height: 1`. **Description:** body size, weight 400, secondary text.

### Inputs / Fields
- **Style:** Panel L2 ground, outlined by a `1px` ring in Panel L3, 12px corners, body-size text. Heights match the button scale (`md` 40px, `lg` 48px).
- **Focus:** the ring thickens to `ring-3` **and** the field brightens — the same light-based idiom the buttons use.
- **Error:** the ring turns Danger; a focused invalid field keeps the Danger ring rather than reverting to the accent.
- **Disabled:** ground and ring both fall to `text-placeholder/30`, with `cursor-not-allowed`.

### Motion
Transitions are short and functional. Accordion and collapsible open and close in `0.2s ease-out` against the Radix content-height variable; entrances use `fade-in-up` (`0.5s ease-out`, 10px rise). The one piece of signature motion is `fade-up` — `0.6s` on `cubic-bezier(0.21, 0.6, 0.35, 1)`, an 8px rise with fade — used for content arriving after load. Skeletons use a `1.8s ease-in-out` wave that sweeps a Panel L3 → L4 gradient across the block.

## Do's and Don'ts

### Do:
- **Do** express interaction as light. Hover and active are `brightness-120`; focus is `ring-3`. A new component that changes colour on hover is inconsistent with everything around it.
- **Do** reach for a tonal step before a shadow when something needs to feel higher.
- **Do** define a new button variant as a `--button-background` / `--button-foreground` pair, and let the base class do the rest.
- **Do** use the deep twin of a hue (`amber-deep`, `lavender-deep`, `blush-deep`) when you need emphasis without spending the accent.
- **Do** keep Overpass Mono for machine-shaped content — ids, shas, paths, code, aligned figures.
- **Do** use `12px` corners on interactive surfaces, and reserve the `4 / 6 / 8px` scale for small interior details.
- **Do** tighten spacing before paginating when a surface carries a lot of data. Density is the intent.

### Don't:
- **Don't** introduce a second accent. Signal Amber is the only one, and a screen has one amber region.
- **Don't** use a status colour decoratively, or the accent to mean success or danger.
- **Don't** put a border on a card. Separation is tonal; where an outline is required, use a ring.
- **Don't** use a neutral grey. Every neutral in this system is tinted blue-violet, and an untinted panel reads as foreign.
- **Don't** enlarge `h3` to fit a conventional type scale — it is label-sized on purpose.
- **Don't** write a literal font size in a component. Use a named step, or add one to `@theme` and document it. A half-pixel value is always a mistake.
- **Don't** build a separate badge component; a badge is a decorative `xs` button.
- **Don't** let the interface drift toward a consumer product: no illustration, no emoji as section markers, no pastel palette spread across a surface, no animated tone. The user is working.
- **Don't** imitate an IDE or code editor: syntax highlighting is content, not identity, and editor chrome, panel density, and tab metaphors belong to the tool Kodus sits beside, not inside.
