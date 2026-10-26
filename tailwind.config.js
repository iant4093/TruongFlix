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
          muted: '#777777',
          border: '#404040',
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
