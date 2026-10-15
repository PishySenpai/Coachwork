/* couleurs portées par des variables CSS (canaux RGB) : le thème clair ou
   sombre les redéfinit sur <html data-apparence>, l'opacité Tailwind reste possible */
const jeton = (nom) => `rgb(var(--c-${nom}) / <alpha-value>)`;

export default {
  content: ["./App.jsx", "./entry.jsx"],
  theme: {
    extend: {
      colors: {
        fond: jeton("fond"),
        carte: jeton("carte"),
        carte2: jeton("carte2"),
        carte3: jeton("carte3"),
        encre: jeton("encre"),
        douce: jeton("douce"),
        brume: jeton("brume"),
        sourd: jeton("sourd"),
        ligne: "var(--c-ligne)",
      },
      fontFamily: {
        jakarta: ['"Plus Jakarta Sans"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        "4xl": "28px",
      },
      scale: {
        98: "0.98",
      },
    },
  },
  plugins: [],
};
