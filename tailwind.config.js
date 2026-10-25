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
