export default {
  content: ["./App.jsx", "./entry.jsx"],
  theme: {
    extend: {
      colors: {
        fond: "#08090C",
        carte: "#121419",
        carte2: "#1B1E25",
        carte3: "#252932",
        encre: "#F3F5F8",
        douce: "#C7CCD5",
        brume: "#8B92A0",
        sourd: "#5E6571",
        ligne: "rgba(255,255,255,0.07)",
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
