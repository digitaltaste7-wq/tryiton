# TryOn

AI virtual try-on for any online store — jewellery, clothing and pets.
Store owners sign up, paste their website, preview TryOn on their own products, then add one line of code to go live.

- `server.js` — the web app (sign-up, dashboard, preview pages, widget API)
- `public/widget.js` — the one-line widget shoppers see (served as `/w.js`)
- `src/ai.js` — the AI step (Google Gemini "Nano Banana 2 Lite"; falls back to 2.5 Flash Image)
- `src/catalog.js` — reads products from a website (Shopify, WooCommerce, or product data on any site)

Run it: `npm install` then `npm start` (Node 22.13+). Settings go in environment variables — see `.env.example`.
Without `GEMINI_API_KEY` it runs in test mode (try-ons return the shopper's own photo).
