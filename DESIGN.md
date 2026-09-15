---
version: alpha
name: 'AgentPet'
description: 'A capable desktop assistant whose folded-ribbon mark expresses task handoff and continuous work.'
colors:
  brand-cobalt: '#3F66F2'
  brand-blue: '#79A6FF'
  brand-highlight: '#FFFFFF'
  dark-surface: '#11151D'
  light-surface: '#F5F7FB'
  ambient-ice-blue: '#DCE6FA'
  ambient-grey-teal: '#E7F0F1'
  dark-text: '#F8FAFC'
  light-text: '#000000'
typography:
  sans:
    fontFamily: 'Segoe UI Variable Text, Segoe UI Variable, Microsoft YaHei UI, Microsoft YaHei, Segoe UI, sans-serif'
  mono:
    fontFamily: 'Consolas, Monaco, monospace'
rounded:
  sm: '0.25rem'
  md: '0.5rem'
  lg: '0.75rem'
spacing:
  compact: '0.5rem'
  control: '0.75rem'
  section: '1.25rem'
components:
  agentpet-mark:
    motion: 'path-drawn ribbon reveal from its leading edge'
    reducedMotion: 'static'
---

# AgentPet Design System

## Overview

AgentPet is a Windows-first desktop assistant for chat, local tools, automation, knowledge work, and coordinated agent tasks. The interface is a product surface: clarity and compact utility lead, while the folded-ribbon brand mark provides the memorable signature. The ribbon represents work being accepted, carried through tools, and returned as a result. Avoid generic robot heads, stars, neural-network motifs, neon glows, and decorative AI motion.

The existing runtime CSS variables in `src/renderer/src/assets/main.css` remain canonical. This document mirrors accepted values and explains their use; it does not generate runtime tokens.

## Colors

The app icon uses a cobalt-blue rounded tile with the light folded ribbon. Product UI uses the transparent ribbon mark colored with `brand-cobalt` and `brand-blue`; it must never add a local blue tile. Drawing animation reveals the original image colors without adding a highlight, glow, or outline.

The window uses a static ice-blue diffuse-light background: mist-white base, broad ice blue at the upper right, and grey-teal at the lower left, with a clean near-white center. One background on the window owns the atmosphere; content shells and chat canvases stay transparent rather than covering it with an opaque white card. The sidebar uses a 96% opaque mist-white surface and the composer a 95% white surface with a restrained cool shadow. Ordinary borders are neutral grey-blue, not brand-blue. Dark mode mirrors the same light placement using ink, muted blue, and muted teal. No background animation, blur, wallpaper, or purple glow is added. Runtime ownership is the ambient and composer tokens in `main.css`.

## Typography

Use the existing Windows-native Segoe UI Variable and Microsoft YaHei UI stack for product text. Consolas/Monaco remains reserved for code and technical output.

## Layout

Preserve the existing dense desktop layout and sidebar geometry. Brand assets reserve their final dimensions before loading and may not move adjacent names or timestamps between idle and thinking states.

New conversations use a quiet welcome workbench: a 52px ribbon drawn once, a medium-weight invitation, and four task suggestions in two content-sized columns separated by 32px. The suggestion group's visible footprint shares the title's centerline, without unused equal-column space. The welcome group is horizontally and vertically centered in the available area above the composer; each column has left-aligned content with fixed 20px icon slots and a consistent text start. Safe centering preserves scroll access in short windows. Empty-chat canvas borders are removed; only the composer retains elevation. Suggestions fill the draft without sending, use native buttons, and collapse to one column on narrow surfaces. Populated chats and auxiliary panels keep their established layout.

## Elevation & Depth

The transparent mark has no container border, badge, glow, or shadow in any state. The application icon retains its own blue tile and soft internal depth.

## Shapes

The app icon uses the approved rounded-square silhouette. In-product marks use only the folded ribbon with transparent surroundings. Do not place it inside an extra badge, circle, or rounded tile.

## Components

### Iconography

`AgentPetMark` is the shared owner for the in-product AgentPet identity. External agent/provider marks continue using their supplied brand assets. The application package and operating-system surfaces use `agentpet-app-icon.png` and generated platform icons.

Sidebar, chat avatars, and startup marks use the original blue ribbon. The mark is decorative and does not support click actions, alternate palettes, or saved color preferences. Sidebar hover continues to trigger the drawing animation.

### Motion

Startup replaces the former AgentPet text effect with a centered 104px transparent mark, drawn once over 2.4 seconds before the existing splash fade. Reduced-motion startup uses a static mark and the original minimum delay.

Motion belongs to the ribbon itself rather than its container: the original mark is revealed from its leading edge along one continuous folded path, as though the ribbon is being drawn into place. Use a gentle symmetric ease-in-out: sidebar hover draws once over 2.4 seconds; chat thinking repeats over 4.6 seconds with a complete-mark pause and soft fade between cycles. Completed messages remain still. `prefers-reduced-motion: reduce` restores the untouched static mark.

## Do's and Don'ts

- **Do:** Keep app-icon and transparent product-mark variants distinct.
- **Do:** Drive streaming animation from the existing message state.
- **Don't:** Animate completed chat messages or rotate/pulse the whole logo.
- **Don't:** reintroduce the former robot icon or blue badge behind in-product marks.
