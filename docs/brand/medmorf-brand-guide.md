# Medmorf Brand Guide

## Brand Essence

**Medmorf** is a medical data transformation platform. It helps turn raw medical inputs into safer, cleaner, more useful formats.

Examples of transformations:

- Speech-to-text for clinical audio
- Medical translation
- Privacy filtering and de-identification
- Document merging
- Format conversion
- Structuring messy clinical data
- Preparing medical content for downstream AI workflows

The name combines **medical** and **morph**, so the brand should feel like medical data is being carefully transformed from one state into another.

The brand should feel:

**Fluid, clinical, intelligent, secure, precise, modular, and trustworthy.**

Medmorf is not just a generic converter. It is a medical-grade transformation layer.

---

## Brand Positioning

### One-line Description

**Medmorf transforms medical data into safer, structured, and usable formats.**

### Longer Description

Medmorf is a healthcare data transformation platform for converting clinical information across modalities, languages, privacy states, and document formats. It supports workflows such as speech-to-text, translation, de-identification, document merging, and structured data preparation.

### Brand Promise

**From messy medical input to clean, usable, privacy-aware output.**

---

## Logo Concept

The logo should communicate four ideas:

1. **Medical data** — clinical documents, audio, language, records, and patient information.
2. **Transformation** — data morphing from one state into another.
3. **Trust and privacy** — medical information is sensitive and must be handled safely.
4. **Modularity** — different transformation tools working as one platform.

---

## Recommended Symbol

Use an abstract morphing-data icon.

Suggested concept:

- A left-side cluster of small data blocks, waveform lines, or document fragments.
- These flow through a central morphing shape, gradient bridge, or soft geometric “M”.
- The output side becomes cleaner structured blocks or a single polished document/data object.
- Add a subtle shield, lock, or privacy cutout only if it remains minimal.
- The icon should suggest transformation without looking like a generic upload/download icon.

The strongest direction is a **fluid M-shaped transformation mark**:

- Left side: fragmented medical inputs.
- Center: smooth morphing bridge.
- Right side: clean structured output.
- Hidden “M” shape for Medmorf.

Avoid literal hospital symbols. The logo should feel like a modern healthcare infrastructure SaaS brand.

---

## Logo Lockups

### Primary Logo

Horizontal lockup:

**[Icon] Medmorf**

Use this for:

- Website header
- Landing page hero
- Product dashboard
- Docs site
- API documentation
- GitHub README

### Icon-Only Mark

Use the morphing icon without the wordmark for:

- Favicon
- App icon
- Sidebar collapsed state
- Social avatar
- Loading states
- Workflow nodes

### Favicon

The favicon should use only the simplified morphing “M” or transformation mark.

At small sizes, prioritize:

- A recognizable M-like silhouette
- One clear transformation direction
- Strong contrast
- No tiny medical details

---

## Color Palette

| Token | Name | Hex | Usage |
|---|---|---:|---|
| `--mm-ink` | Medical Ink | `#102033` | Primary text, logo wordmark |
| `--mm-blue` | Clinical Blue | `#2563EB` | Primary actions, trusted clinical accent |
| `--mm-cyan` | Morph Cyan | `#06B6D4` | Transformation flow, highlights |
| `--mm-violet` | Translation Violet | `#7C3AED` | Language and multimodal accents |
| `--mm-green` | Privacy Green | `#10B981` | Safe, filtered, verified states |
| `--mm-ice` | Clean Ice | `#ECFEFF` | Light backgrounds and panels |
| `--mm-lavender` | Soft Lavender | `#F3E8FF` | Secondary background states |
| `--mm-white` | White | `#FFFFFF` | Main background and negative space |

### Primary Gradient

Use this gradient sparingly for the morphing symbol and hero accents:

```css
linear-gradient(135deg, #2563EB 0%, #06B6D4 48%, #7C3AED 100%)
```

The gradient should represent transformation across formats, languages, and privacy states.

---

## Typography

### Primary Typeface

Use **Inter**.

Recommended weights:

- **Inter Bold** for logo wordmark and hero headings
- **Inter SemiBold** for section headings
- **Inter Medium** for navigation and buttons
- **Inter Regular** for body text

### Optional Technical Typeface

Use **JetBrains Mono** or **IBM Plex Mono** for:

- API snippets
- data schemas
- transformation logs
- workflow labels

### Logo Wordmark

Text: **Medmorf**

Treatment:

- Single word
- Prefer **Medmorf** with capital M
- Medical Ink or dark navy wordmark
- Optional gradient only on icon, not full wordmark

Suggested CSS:

```css
font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
font-weight: 800;
letter-spacing: -0.04em;
```

---

## Visual Style

The brand should use:

- Smooth transformation flows
- Rounded geometric shapes
- Modular cards and pipeline blocks
- Subtle gradients
- Clean white and ice-blue backgrounds
- Privacy and security cues
- Data-in/data-out visual metaphors

Avoid:

- Caduceus symbols
- Stethoscopes
- Pills
- Hospital crosses
- Overly literal DNA imagery
- Cartoon robots
- Aggressive cyber-security visuals
- Messy rainbow gradients

---

## Icon Design Rules

### Full Icon

For large use:

- Input fragments on the left
- Smooth morphing bridge or M-shape in the center
- Clean structured output on the right
- Optional tiny privacy shield or masked segment
- Gradient across the morph path

### Medium Icon

For navigation and app UI:

- Keep the M-like morph shape
- Reduce input/output details
- Use solid blue/cyan or simple gradient

### Small Favicon

For 16–32px:

- Use only the M-like morph mark
- Remove tiny fragments
- Avoid text
- Increase stroke or shape thickness
- Keep strong contrast

---

## Logo SVG Starter

```html
<svg width="260" height="72" viewBox="0 0 260 72" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Medmorf logo">
  <defs>
    <linearGradient id="medmorfGradient" x1="8" y1="8" x2="84" y2="64" gradientUnits="userSpaceOnUse">
      <stop stop-color="#2563EB"/>
      <stop offset="0.48" stop-color="#06B6D4"/>
      <stop offset="1" stop-color="#7C3AED"/>
    </linearGradient>
  </defs>

  <rect x="8" y="18" width="10" height="10" rx="3" fill="#2563EB"/>
  <rect x="8" y="34" width="10" height="10" rx="3" fill="#06B6D4"/>
  <rect x="8" y="50" width="10" height="10" rx="3" fill="#10B981"/>

  <path d="M28 56V22C28 18 32.8 16 35.6 18.8L50 33.2L64.4 18.8C67.2 16 72 18 72 22V56"
        stroke="url(#medmorfGradient)"
        stroke-width="9"
        stroke-linecap="round"
        stroke-linejoin="round"/>

  <path d="M84 24H104C108.4 24 112 27.6 112 32V40C112 44.4 108.4 48 104 48H84"
        stroke="#102033"
        stroke-width="7"
        stroke-linecap="round"/>

  <path d="M90 36H104" stroke="#06B6D4" stroke-width="7" stroke-linecap="round"/>

  <text x="132" y="46" font-family="Inter, system-ui, sans-serif" font-size="34" font-weight="800" fill="#102033">Medmorf</text>
</svg>
```

---

## Voice and Tone

Medmorf should sound:

**Clear, capable, safe, and technically confident.**

Use language that emphasizes:

- Transformation
- Privacy
- Clinical-grade processing
- Workflow automation
- Data readiness
- Medical context preservation
- Human-review friendly outputs

Avoid hype-heavy AI language. The brand should feel reliable and infrastructure-grade.

---

## Messaging Examples

### Headline Options

- **Morph medical data into what your workflow needs.**
- **Transform clinical inputs into safe, usable outputs.**
- **Medical data transformation for modern AI workflows.**
- **From speech, documents, and languages to structured clinical data.**
- **Clean, translate, merge, and protect medical data.**

### Subheading Options

- **Medmorf converts medical data across formats, languages, and privacy states while preserving clinical meaning.**
- **A transformation layer for speech-to-text, translation, de-identification, document merging, and structured medical workflows.**
- **Turn raw clinical content into clean, privacy-aware data for downstream systems and AI agents.**

### Product Pillars

1. **Transcribe** — Convert clinical speech into text.
2. **Translate** — Convert medical content across languages while preserving clinical meaning.
3. **Protect** — Filter, redact, or de-identify sensitive medical information.
4. **Merge** — Combine documents into coherent patient or trial-ready records.
5. **Structure** — Transform messy medical content into usable, machine-readable data.

---

## Suggested Site UI Direction

Recommended UI:

- White or clean ice background
- Dark ink headings
- Gradient morphing accents
- Modular transformation cards
- Pipeline visuals showing input → transform → output
- Privacy badges for safe output states
- Before/after panels for data transformation examples

Example UI labels:

- Speech to Text
- Translation
- Privacy Filtering
- Document Merge
- Medical Data Cleanup
- Structured Output
- Transformation Pipeline
- Protected Output
- Human Review
- Export Format

---

## Suggested Design Agent Prompt

```text
Create a modern vector logo system for a healthcare data transformation platform called “Medmorf”.

Medmorf helps morph medical data into safer, cleaner, more useful formats. It supports speech-to-text, medical translation, privacy filtering and de-identification, document merging, format conversion, and structured output for downstream AI workflows.

Design a clean, professional logo that communicates medical data transformation, privacy, and modular workflows. Use an abstract morphing-data icon. The icon should suggest raw medical inputs flowing through a transformation layer into cleaner structured output.

A strong direction is a fluid M-shaped transformation mark: fragmented data blocks or waveform/document hints on the left, a smooth morphing M-shape in the center, and a clean structured output shape on the right. The mark should feel intelligent, clinical, secure, and modern.

Create:
1. Primary horizontal logo with icon plus “Medmorf”
2. Icon-only logo
3. Square favicon/app icon
4. Light background version
5. Dark background version
6. SVG-ready vector shapes
7. Basic brand sheet with palette and typography

Use this palette:
- Medical Ink: #102033
- Clinical Blue: #2563EB
- Morph Cyan: #06B6D4
- Translation Violet: #7C3AED
- Privacy Green: #10B981
- Clean Ice: #ECFEFF
- Soft Lavender: #F3E8FF
- White: #FFFFFF

Use a restrained gradient from blue to cyan to violet for the morphing icon. Use Inter Bold or Inter ExtraBold for the wordmark.

The style should be flat, minimal, geometric, trustworthy, and modern. It should feel like a serious healthcare infrastructure SaaS brand. Avoid caduceus, stethoscope, pills, hospital crosses, DNA clichés, cartoon robots, and generic upload/download icons.
```

---

## CSS Tokens

```css
:root {
  --mm-ink: #102033;
  --mm-blue: #2563EB;
  --mm-cyan: #06B6D4;
  --mm-violet: #7C3AED;
  --mm-green: #10B981;
  --mm-ice: #ECFEFF;
  --mm-lavender: #F3E8FF;
  --mm-white: #FFFFFF;

  --mm-font: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mm-mono: "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  --mm-gradient: linear-gradient(135deg, #2563EB 0%, #06B6D4 48%, #7C3AED 100%);

  --mm-radius-sm: 8px;
  --mm-radius-md: 14px;
  --mm-radius-lg: 24px;

  --mm-shadow-soft: 0 18px 50px rgba(16, 32, 51, 0.12);
}
```

---

## Brand Summary

**Medmorf** should look and feel like a medical data transformation layer: clean, modular, privacy-aware, and technically strong. Its visual identity should show clinical information moving from raw input into protected, structured, usable output.
