/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        nf: {
          bg: '#141414',
          surface: '#181818',
          hover: '#202020',
          red: '#E50914',
          redHover: '#F40612',
          green: '#46D369',
          text: '#FFFFFF',
          secondary: '#BCBCBC',
          muted: '#929292',
          border: '#404040',
          // Raised surfaces: hovered round buttons, menus, player panels, cards inside dialogs.
          raised: '#2a2a2a',
          menu: '#242424',
          panel: '#262626',
          card: '#2f2f2f',
          cardHover: '#383838',
          // Netflix greys for secondary copy.
          light: '#e5e5e5',
          soft: '#d2d2d2',
          dim: '#b3b3b3',
          faint: '#8c8c8c',
          // Unfilled part of progress bars and switches.
          track: '#4d4d4d',
          download: {
            DEFAULT: '#38bdf8',
            text: '#7dd3fc',
          },
          warn: '#e87c03',
          gold: '#ffd76a',
          imdb: '#F5C518',
        },
      },
      fontFamily: {
        sans: ['"Netflix Sans"', 'Inter', '"Helvetica Neue"', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      backdropBlur: {
        xs: '2px',
      },
      boxShadow: {
        card: '0 12px 28px rgba(0,0,0,0.75)',
        modal: '0 3px 10px rgba(0,0,0,0.75)',
      },
    },
  },
  plugins: [],
};
