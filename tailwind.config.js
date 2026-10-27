/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Bounty Farm blue, used as a restrained accent on a bright white interface
        // (PRD §11). Steps below 600 are for fills/borders; 700+ for text on white
        // so that body text clears WCAG 2.2 AA (NFR-004).
        bff: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#2f7ac8',
          600: '#1f63ad',
          700: '#1a5290',
          800: '#174472',
          900: '#15395e',
        },

        /*
         * The neumorphic surface, used ONLY by the phone home screen.
         *
         * WHY NOT #FFFFFF. Neumorphism needs the element and the page behind
         * it to be the same colour, with depth carried by a light shadow on
         * the top-left and a dark one on the bottom-right. On a pure white
         * page the light side has nothing to sit against, so the effect
         * degrades to a flat card with a grey drop shadow — which is the
         * thing the style is supposed to replace.
         *
         * WHY NOT #E0E5EC (the usual neumorphism base). Measured: L* 90.8,
         * which is a visible light grey, not white. On a brand whose whole
         * interface is "bright white with restrained blue accents" (PRD §11)
         * it reads as dirty, and in Guyanese daylight a grey panel reads as a
         * disabled one.
         *
         * `base` is #F1F4F8: L* 96.1. The white highlight is a ΔL* of 3.9
         * against it — far above the threshold at which a large soft gradient
         * stops being visible — while staying lighter than iOS's own
         * `systemGroupedBackground` (#F2F2F7, L* 95.4), a colour every phone
         * user already calls white. The tint is blue rather than neutral so
         * the off-white reads as "cool white", the way paper under daylight
         * does, instead of as grey.
         *
         * `shade` is the bottom-right shadow colour, a desaturated form of
         * the brand blue rather than neutral grey: a neutral shadow on a
         * blue-white surface is what actually looks like dirt.
         *
         * LIGHT ONLY, deliberately. Inverting the light source breaks the
         * material metaphor, and `color-scheme: light` is already fixed in
         * src/styles/index.css. There is no dark variant of these tokens and
         * none should be added.
         */
        neu: {
          base: '#f1f4f8',
          light: '#ffffff',
          shade: '#a3b1c6',
        },
      },

      /*
       * Dual-layer depth. Light source top-left, shade bottom-right.
       *
       * `neu` is the resting extruded state, `neu-pressed` the inset concave
       * one. The shade alpha drops 0.60 -> 0.24 between them (a factor of
       * 0.4), which is the "shadow opacity 1 -> 0.4 on press" the design
       * direction asks for, expressed in the tokens rather than in an
       * animation nobody can inspect.
       *
       * These are Tailwind shadow utilities on purpose, never raw
       * `box-shadow` declarations: Tailwind composes the focus ring into the
       * same `box-shadow` property, so a hand-written `box-shadow` here would
       * silently delete every focus ring on a tile.
       */
      boxShadow: {
        neu: '-6px -6px 14px #ffffff, 6px 6px 14px rgba(163, 177, 198, 0.6)',
        'neu-pressed':
          'inset -4px -4px 10px rgba(255, 255, 255, 0.9), inset 5px 5px 10px rgba(163, 177, 198, 0.24)',
        /** A nested inset slot inside a resting tile (nested depth is allowed). */
        'neu-inset': 'inset 3px 3px 6px rgba(163, 177, 198, 0.55), inset -3px -3px 6px #ffffff',
        'neu-sm': '-3px -3px 7px #ffffff, 3px 3px 7px rgba(163, 177, 198, 0.55)',
      },

      /* So a focus ring's offset gap matches the surface it sits on rather
         than punching a white hole in it. */
      ringOffsetColor: {
        'neu-base': '#f1f4f8',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      minHeight: {
        tap: '44px', // minimum accessible tap target for plant tablet use
      },
      minWidth: {
        tap: '44px',
      },
    },
  },
  plugins: [],
};
